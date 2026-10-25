import { RuntimePolicy } from './runtime-policy.js';
import { SQLiteSnapshot } from './sqlite-snapshot.js';
import { bindPortableWorkspace } from './portable-binding.js';
import { VoiceDelegations } from './voice-delegations.js';
import { MemoryJobs } from '../memory-jobs.js';
import { LegacyEvidence, type StorageOptions } from './legacy-evidence.js';
import { ContextBuilder } from '../context-builder.js';
import { DreamPublication } from '../dream-publication.js';
import type { PublishDreamInput } from '../memory-jobs.js';
import { SQLiteEvidence } from './sqlite-evidence.js';
import { SQLiteJobs } from './sqlite-jobs.js';
import { MemoryRecall } from '../memory-recall.js';
import { MemoryAccess } from '../memory-access.js';
import { initializeSQLiteSchema } from './sqlite-schema.js';
import { SQLiteConversationRecords } from './sqlite-conversation-records.js';
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
  type AsyncRepositoryMethod,
  type RepositoryMethod,
} from './repository-contract.js';

const asynchronous = {
  'snapshot.capture': true,
  'jobs.publishDream': true,
  'publication.review': true,
  'publication.share': true,
  'context.essentials': true,
  'recall.search': true,
  'recall.read': true,
  'recall.readSource': true,
  'folders.select': true,
  'folders.resolve': true,
  'folders.decide': true,
  'folders.bindExecution': true,
  'folders.executionScope': true,
  'folders.listDirectory': true,
  'folders.readFile': true,
  'folders.writeFile': true,
} satisfies Record<AsyncRepositoryMethod, true> &
  Partial<Record<RepositoryMethod, true>>;
interface Queued {
  request: StorageRequest;
  controller: AbortController;
  availableAt: number;
  deadline: number;
}
/** All core handles live on this worker. No transaction spans an await or external I/O. */
export async function serveStorage(
  port: MessagePort,
  db: DatabaseSync,
  ownerId: string,
  options: StorageOptions = {},
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
    if (options.engine !== 'legacy-postgres') initializeSQLiteSchema(db);
    if (options.machineId && options.engine !== 'legacy-postgres')
      bindPortableWorkspace(db, options.machineId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const legacy = options.engine === 'legacy-postgres';
  const pg =
    legacy && options.postgresUrl
      ? new (await import('pg')).Pool({
          connectionString: options.postgresUrl,
          max: 2,
          connectionTimeoutMillis: 5000,
          query_timeout: 10000,
        })
      : undefined;
  pg?.on('error', () => {});
  const asyncMethods = new Set(Object.keys(asynchronous));
  if (pg)
    for (const group of ['evidence', 'jobs'] as const)
      for (const name of repositoryMethods[group])
        asyncMethods.add(`${group}.${name}`);
  const evidence = pg
    ? new LegacyEvidence(
        pg,
        ownerId,
        workspace,
        () => store.settings().memoryAllowed,
      )
    : new SQLiteEvidence(
        db,
        ownerId,
        workspace,
        () => store.settings().memoryAllowed,
      );
  const episodes = {
    generation: () => evidence.generation(),
    coverage: (dotId?: string) => evidence.coverage(dotId),
    searchEpisodes: evidence.searchEpisodes.bind(evidence),
    sourceById: evidence.sourceById.bind(evidence),
    readSource: evidence.readSource.bind(evidence),
  };
  const recall = new MemoryRecall(
    workspace.memory,
    episodes,
    new MemoryAccess(workspace, store),
  );
  const repositories = {
    voiceDelegations: new VoiceDelegations(
      db,
      ownerId,
      workspace,
      new SQLiteConversationRecords(db, ownerId),
      !legacy,
      () => store.settings().memoryAllowed,
    ),
    snapshot: new SQLiteSnapshot(db, ownerId),
    policy: new RuntimePolicy(store, workspace),
    evidence,
    jobs: pg
      ? new MemoryJobs(pg, ownerId, Date.now, {
          publication: new DreamPublication(recall),
        })
      : new SQLiteJobs(db, ownerId, Date.now, {
          publication: new DreamPublication(recall),
        }),
    recall,
    access: recall.access,
    publication: new DreamPublication(recall),
    context: new ContextBuilder(recall, {
      pinnedTokenLimit: options.pinnedTokenLimit,
    }),
    conversations: new SQLiteConversationRecords(db, ownerId),
    store,
    workspace,
    memory: workspace.memory,
    history: workspace.memory.history,
    pages: workspace.pages,
    computers: workspace.computers,
    connections: workspace.connections,
    abilities: workspace.abilities,
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
  function retryOrFinish(item: Queued, error: unknown) {
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
  function pump() {
    scheduled = undefined;
    if (closing && !outstanding.size) {
      workspace.close();
      store.close();
      db.close();
      const closed = () => {
        send({ kind: 'closed' });
        port.close();
      };
      if (pg) void pg.end().then(closed, closed);
      else closed();
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
    if (asyncMethods.has(request.method)) {
      const args = [...request.args];
      if (request.method === 'snapshot.capture')
        args[1] = item.controller.signal;
      if (
        request.method === 'folders.readFile' ||
        request.method === 'folders.listDirectory'
      )
        args[3] = item.controller.signal;
      if (request.method === 'folders.writeFile')
        args[4] = item.controller.signal;
      Promise.resolve()
        .then(() =>
          request.method === 'jobs.publishDream'
            ? repositories.jobs.publishDreamWithFence(
                args[0] as PublishDreamInput,
                () => {
                  if (isCancelled(item)) throw cancelledStorageError();
                },
              )
            : handler(...args),
        )
        .then(
          (value) => {
            resultSize(value);
            finish(item, value);
          },
          // Publication has no external side effects: its transaction rolled back before retry.
          // Folder operations may already have performed I/O and must never be replayed here.
          (error) =>
            request.method === 'jobs.publishDream'
              ? retryOrFinish(item, error)
              : finish(item, undefined, error),
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
      retryOrFinish(item, error);
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
