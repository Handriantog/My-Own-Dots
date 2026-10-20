import { DatabaseSync } from 'node:sqlite';
import { type MessagePort } from 'node:worker_threads';
import { serialize } from 'node:v8';
import { Store } from '../store.js';
import { WorkspaceStore } from '../workspace.js';
import {
  cancelledStorageError,
  isRepositoryMethod,
  repositoryMethods,
  storageFailure,
  storageLimits,
  type StorageRequest,
  type StorageResponse,
} from './repository-contract.js';

const asynchronous = new Set([
  'folders.select',
  'folders.decide',
  'folders.listDirectory',
  'folders.readFile',
  'folders.writeFile',
]);
interface Queued {
  request: StorageRequest;
  controller: AbortController;
  availableAt: number;
  deadline: number;
}
/** All core handles live on this worker. No transaction spans an await or external I/O. */
export function serveStorage(
  port: MessagePort,
  db: DatabaseSync,
  ownerId: string,
) {
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;',
  );
  let store: Store;
  let workspace: WorkspaceStore;
  db.exec('BEGIN IMMEDIATE');
  try {
    store = new Store(':memory:', db);
    workspace = new WorkspaceStore(':memory:', ownerId, db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const repositories = {
    store,
    workspace,
    memory: workspace.memory,
    history: workspace.memory.history,
    pages: workspace.pages,
    computers: workspace.computers,
    connections: workspace.connections,
    folders: workspace.folders,
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  for (const group of Object.keys(
    repositoryMethods,
  ) as (keyof typeof repositoryMethods)[]) {
    const repository = repositories[group];
    for (const name of repositoryMethods[group]) {
      // Both object and method come only from the static allowlist above.
      const fn = (
        repository as unknown as Record<string, (...args: unknown[]) => unknown>
      )[name];
      handlers.set(`${group}.${name}`, fn.bind(repository));
    }
  }
  const queue: Queued[] = [];
  const outstanding = new Map<number, Queued>();
  let closing = false;
  let scheduled:
    ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate> | undefined;
  const send = (response: StorageResponse) => port.postMessage(response);
  function finish(item: Queued, value?: unknown, error?: unknown) {
    outstanding.delete(item.request.id);
    send({
      kind: 'result',
      id: item.request.id,
      ...(error ? { error: storageFailure(error) } : { value }),
    });
    schedule();
  }
  function isCancelled(item: Queued) {
    return Atomics.load(new Int32Array(item.request.cancel), 0) !== 0;
  }
  function resultSize(value: unknown) {
    if (serialize(value).byteLength > storageLimits.bytes)
      throw new Error('Storage result exceeds size limit; use a bounded query');
  }
  function pump() {
    scheduled = undefined;
    if (closing && !outstanding.size) {
      workspace.close();
      store.close();
      db.close();
      send({ kind: 'closed' });
      port.close();
      return;
    }
    const now = Date.now();
    // Foreground always wins among eligible requests. A busy transaction yields between retries.
    let index = queue.findIndex(
      (item) =>
        item.request.priority === 'foreground' &&
        (item.availableAt <= now || isCancelled(item)),
    );
    if (
      index < 0 &&
      !queue.some((item) => item.request.priority === 'foreground')
    )
      index = queue.findIndex(
        (item) => item.availableAt <= now || isCancelled(item),
      );
    if (index < 0) {
      schedule();
      return;
    }
    const item = queue.splice(index, 1)[0];
    const request = item.request;
    if (isCancelled(item)) {
      finish(item, undefined, cancelledStorageError());
      return;
    }
    const handler = handlers.get(request.method)!;
    if (asynchronous.has(request.method)) {
      const args = [...request.args];
      if (
        request.method === 'folders.readFile' ||
        request.method === 'folders.listDirectory'
      )
        args[3] = item.controller.signal;
      if (request.method === 'folders.writeFile')
        args[4] = item.controller.signal;
      Promise.resolve()
        .then(() => handler(...args))
        .then(
          (value) => {
            resultSize(value);
            finish(item, value);
          },
          (error) => finish(item, undefined, error),
        )
        .catch((error) => finish(item, undefined, error));
      // External folder helpers may wait; permission revocation must still run while they do.
      schedule();
      return;
    }
    try {
      db.exec('BEGIN');
      const value = handler(...request.args);
      resultSize(value);
      if (isCancelled(item)) throw cancelledStorageError();
      db.exec('COMMIT');
      finish(item, value);
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      const code = (error as { errcode?: number }).errcode;
      if (
        typeof code === 'number' &&
        (code & 255) === 5 &&
        Date.now() < item.deadline &&
        !isCancelled(item)
      ) {
        item.availableAt = Date.now() + 10;
        queue.push(item);
        schedule();
      } else
        finish(
          item,
          undefined,
          isCancelled(item) ? cancelledStorageError() : error,
        );
    }
  }
  function schedule() {
    if (scheduled) return;
    if (closing && !outstanding.size) {
      scheduled = setImmediate(pump);
      return;
    }
    if (!queue.length) return;
    const foreground = queue.filter(
      (item) => item.request.priority === 'foreground',
    );
    const eligible = foreground.length ? foreground : queue;
    const delay = Math.max(
      0,
      Math.min(
        ...eligible.map((item) => (isCancelled(item) ? 0 : item.availableAt)),
      ) - Date.now(),
    );
    scheduled = delay ? setTimeout(pump, delay) : setImmediate(pump);
  }
  port.on('message', (message: unknown) => {
    const request = message as StorageRequest;
    if ((message as { kind?: string })?.kind === 'close') {
      closing = true;
      schedule();
      return;
    }
    if ((message as { kind?: string })?.kind === 'cancel') {
      const item = outstanding.get((message as { id: number }).id);
      item?.controller.abort();
      schedule();
      return;
    }
    try {
      if (
        !request ||
        request.kind !== 'call' ||
        !Number.isSafeInteger(request.id) ||
        request.id < 1
      )
        throw new Error('Invalid storage request');
      if (closing) throw new Error('Storage worker is closing');
      if (!isRepositoryMethod(request.method))
        throw new Error('Unknown repository method');
      if (
        !Array.isArray(request.args) ||
        serialize(request.args).byteLength > storageLimits.bytes
      )
        throw new Error('Storage payload exceeds size limit');
      if (
        request.priority !== 'foreground' &&
        request.priority !== 'background'
      )
        throw new Error('Invalid storage priority');
      if (
        !(request.cancel instanceof SharedArrayBuffer) ||
        request.cancel.byteLength !== 4
      )
        throw new Error('Invalid storage cancellation token');
      if (
        outstanding.has(request.id) ||
        outstanding.size >= storageLimits.requests
      )
        throw new Error('Storage request queue limit exceeded');
      const item = {
        request,
        controller: new AbortController(),
        availableAt: 0,
        deadline: Date.now() + 5000,
      };
      outstanding.set(request.id, item);
      queue.push(item);
      schedule();
    } catch (error) {
      send({ kind: 'result', id: request?.id, error: storageFailure(error) });
    }
  });
  send({ kind: 'ready' });
}
