import type { StorageOptions } from './legacy-evidence.js';
import { Worker } from 'node:worker_threads';
import { serialize } from 'node:v8';
import { PageError } from '../pages.js';
import { FolderAccessError } from '../folder-access.js';
import { ZodError } from 'zod';
import {
  cancelledStorageError,
  isRepositoryMethod,
  repositoryMethods,
  storageLimits,
  type AsyncRepositories,
  type RepositoryArguments,
  type RepositoryCallOptions,
  type RepositoryMethod,
  type RepositoryResult,
  type StorageFailure,
  type StorageResponse,
} from './repository-contract.js';
interface OpenOptions extends StorageOptions {
  database: string;
  ownerId: string;
  entry?: string | URL;
  execArgv?: string[];
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}
function remoteError(failure: StorageFailure) {
  if (failure.name === 'ZodError' && failure.issues)
    return new ZodError(failure.issues);
  if (failure.name === 'PageError')
    return new PageError(
      failure.message,
      failure.status as ConstructorParameters<typeof PageError>[1],
    );
  if (failure.name === 'FolderAccessError')
    return new FolderAccessError(
      failure.message,
      failure.status as ConstructorParameters<typeof FolderAccessError>[1],
    );
  return Object.assign(new Error(failure.message), failure);
}
export class StorageClient {
  readonly repositories: AsyncRepositories;
  private readonly lifecycle = new AbortController();
  get signal(): AbortSignal {
    return this.lifecycle.signal;
  }
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private closing = false;
  private closed = false;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private closePromise?: Promise<void>;
  private constructor(
    private worker: Worker,
    readonly ownerId: string,
    readonly engine: 'legacy-postgres' | 'sqlite',
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.exited = new Promise((resolve) =>
      worker.once('exit', () => resolve()),
    );
    worker.on('message', (message: StorageResponse) => {
      if (message.kind === 'ready') {
        this.resolveReady();
        return;
      }
      if (message.kind === 'fatal') {
        this.fail(remoteError(message.error));
        return;
      }
      if (message.kind !== 'result') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup();
      if (message.error) pending.reject(remoteError(message.error));
      else pending.resolve(message.value);
    });
    worker.on('error', (error) =>
      this.fail(
        error instanceof Error ? error : new Error('Storage worker failed'),
      ),
    );
    worker.on('exit', (code) => {
      if (!this.closing || code !== 0 || this.pending.size)
        this.fail(new Error(`Storage worker exited (${code})`));
      else this.closed = true;
    });
    const groups: Record<string, Record<string, unknown>> = {};
    for (const [group, names] of Object.entries(repositoryMethods)) {
      const facade: Record<string, unknown> = {};
      for (const name of names)
        facade[name] = (...args: unknown[]) => {
          let signal: AbortSignal | undefined;
          if (
            group === 'folders' &&
            (name === 'listDirectory' ||
              name === 'readFile' ||
              name === 'writeFile')
          ) {
            const index = name === 'writeFile' ? 4 : 3;
            signal = args[index] as AbortSignal | undefined;
            args = args.slice(0, index);
          }
          return this.call(
            `${group}.${name}` as RepositoryMethod,
            args as RepositoryArguments<RepositoryMethod>,
            { signal },
          );
        };
      groups[group] = facade;
    }
    Object.defineProperty(groups.workspace, 'ownerId', {
      value: ownerId,
      enumerable: true,
    });
    Object.defineProperty(groups.memory, 'ownerId', {
      value: ownerId,
      enumerable: true,
    });
    Object.assign(groups.workspace, {
      policy: groups.policy,
      memory: Object.assign(groups.memory, { history: groups.history }),
      pages: groups.pages,
      computers: groups.computers,
      connections: groups.connections,
      folders: groups.folders,
    });
    groups.evidence.indexRun = async (runId: string) => {
      while (
        !(
          await this.call('evidence.indexBatch', [runId], {
            priority: 'background',
          })
        ).complete
      ) {
        /* each request yields to foreground work */
      }
    };
    groups.jobs.publishDream = (
      input: RepositoryArguments<'jobs.publishDream'>[0],
      signal?: AbortSignal,
    ) => this.call('jobs.publishDream', [input], { signal });
    this.repositories = {
      evidence: groups.evidence,
      jobs: groups.jobs,
      recall: groups.recall,
      access: groups.access,
      publication: groups.publication,
      context: groups.context,
      store: groups.store,
      workspace: groups.workspace,
    } as unknown as AsyncRepositories;
  }
  static async open(options: OpenOptions): Promise<StorageClient> {
    const source = import.meta.url.endsWith('.ts');
    const entry =
      options.entry ??
      new URL(
        source ? './storage-worker-entry.ts' : './storage-worker-entry.js',
        import.meta.url,
      );
    // TS workers use the same installed loader as development; packaged workers have no loader dependency.
    const execArgv =
      options.execArgv ??
      (String(entry).endsWith('.ts')
        ? ['--import', import.meta.resolve('tsx')]
        : []);
    const worker = new Worker(entry, {
      workerData: {
        database: options.database,
        ownerId: options.ownerId,
        machineId: options.machineId,
        engine: options.engine,
        postgresUrl: options.postgresUrl,
        pinnedTokenLimit: options.pinnedTokenLimit,
      },
      execArgv,
    });
    const client = new StorageClient(
      worker,
      options.ownerId,
      options.engine ?? 'sqlite',
    );
    try {
      await client.ready;
      return client;
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  }
  async call<K extends RepositoryMethod>(
    method: K,
    args: RepositoryArguments<K>,
    options: RepositoryCallOptions = {},
  ): Promise<RepositoryResult<K>> {
    if (this.closing || this.closed)
      throw new Error('Storage client is closed');
    if (!isRepositoryMethod(method))
      throw new Error('Unknown repository method');
    if (
      !Array.isArray(args) ||
      serialize(args).byteLength > storageLimits.bytes
    )
      throw new Error('Storage payload exceeds size limit');
    if (this.pending.size >= storageLimits.requests)
      throw new Error('Storage request queue limit exceeded');
    if (options.signal?.aborted) throw cancelledStorageError();
    const id = ++this.nextId;
    const cancel = new SharedArrayBuffer(4);
    return new Promise<RepositoryResult<K>>((resolve, reject) => {
      const abort = () => {
        Atomics.store(new Int32Array(cancel), 0, 1);
        this.worker.postMessage({ kind: 'cancel', id });
      };
      this.pending.set(id, {
        resolve: (value) => resolve(value as RepositoryResult<K>),
        reject,
        cleanup: () => options.signal?.removeEventListener('abort', abort),
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        this.worker.postMessage({
          kind: 'call',
          id,
          method,
          args,
          priority: options.priority ?? 'foreground',
          cancel,
        });
      } catch (error) {
        this.pending.delete(id);
        options.signal?.removeEventListener('abort', abort);
        reject(error);
      }
    });
  }
  private fail(error: Error) {
    this.closed = true;
    this.lifecycle.abort(error);
    this.rejectReady(error);
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (!this.closed) this.worker.postMessage({ kind: 'close' });
    this.closePromise = this.exited;
    return this.closePromise;
  }
}
