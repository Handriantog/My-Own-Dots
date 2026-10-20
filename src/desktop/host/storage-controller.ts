import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  statfs,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { parseArchiveManifest } from '../../shared/storage-archive.js';
import { atomicStorageWrite } from '../../server/storage/restore-journal.js';
import type {
  DesktopStorageBridge,
  StorageStatus,
  StorageOperationStatus,
} from '../shared/storage-contract.js';
import type { BackupKeys } from './backup-keys.js';
import { BackupSchedule } from './backup-schedule.js';
import type {
  ArchiveWorkerPort,
  ArchiveWorkerResult,
} from './archive-worker-client.js';
import type {
  WorkspaceBackendConfiguration,
  WorkspaceBackendConnection,
} from './workspace-backend.js';

export interface StorageInvocation {
  trusted(): boolean;
  focused(): boolean;
  chooseDirectory(kind: 'backup' | 'restore'): Promise<string | undefined>;
  chooseArchive(): Promise<string | undefined>;
  confirmRestore(mode: 'new' | 'replace'): Promise<boolean>;
}
const metadataSchema = z
  .object({
    version: z.literal(1),
    destination: z.string().optional(),
    automatic: z.boolean().default(false),
    lastAttempt: z.string().optional(),
    lastSuccess: z.string().optional(),
    error: z.string().optional(),
    records: z
      .array(
        z
          .object({
            id: z.uuid(),
            createdAt: z.string(),
            verified: z.literal(true),
            managed: z.literal(true),
            file: z
              .object({
                size: z.number(),
                mtimeMs: z.number(),
                ino: z.number(),
                dev: z.number(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
type Metadata = z.infer<typeof metadataSchema>;
interface Options {
  profile: string;
  keys: BackupKeys | ((metadataDirectory: string) => BackupKeys);
  worker: ArchiveWorkerPort;
  configuration(): WorkspaceBackendConfiguration | undefined;
  connection(): WorkspaceBackendConnection | undefined;
  request?: typeof fetch;
  stopWorkspace(): Promise<void>;
  afterRestore(): Promise<void>;
}
const password = z.string().min(1).max(4096);
/** Only native dialogs choose paths; renderer commands are strictly shape-checked. */
export class StorageController {
  private operation?: StorageOperationStatus;
  private preview?: StorageStatus['preview'];
  private coverage?: StorageStatus['coverage'];
  private running?: { controller: AbortController; done: Promise<void> };
  private listeners = new Set<(status: StorageStatus) => void>();
  private disposed = false;
  private choosing = false;
  private ticking?: Promise<void>;
  private cancelling = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: Options) {}
  private keys() {
    return typeof this.options.keys === 'function'
      ? this.options.keys(dirname(this.stateFile()))
      : this.options.keys;
  }
  start() {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 60000);
    this.timer.unref();
  }
  tick(now = Date.now()): Promise<void> {
    if (this.disposed || this.cancelling || this.running || this.choosing)
      return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.choosing = true;
    this.ticking = this.automaticTick(now).finally(() => {
      this.ticking = undefined;
      this.choosing = false;
    });
    return this.ticking;
  }
  private async automaticTick(now: number) {
    if (!this.options.configuration()) return;
    const metadata = await this.metadata();
    if (!metadata.automatic) return;
    try {
      const connection = this.options.connection();
      if (!connection?.ownerToken) return;
      const activity = z
        .object({ idle: z.boolean(), revision: z.string().min(1) })
        .parse(await this.json(connection, '/storage/status'));
      if (!activity.idle || this.disposed || this.cancelling) return;
      const passphrase = await this.keys().recall();
      if (!passphrase) throw new Error('Remember the recovery password again');
      if (this.disposed || this.cancelling) return;
      const destinationKey = createHash('sha256')
        .update(metadata.destination ?? '')
        .digest('hex');
      const schedule = new BackupSchedule({
        stateFile: join(
          dirname(this.stateFile()),
          `schedule-${destinationKey}.json`,
        ),
        backup: async () => {
          let result:
            Extract<ArchiveWorkerResult, { verified: true }> | undefined;
          await this.run('backup', async (signal) => {
            result = await this.backup(passphrase, signal, 'automatic');
          });
          return { ...result!, managed: true };
        },
        list: async () => (await this.metadata()).records,
        remove: (id) => this.removeManagedBackup(id),
      });
      await schedule.tick({ now, ...activity });
      const state = await schedule.status();
      if (state.error)
        await this.save({ ...(await this.metadata()), error: state.error });
    } catch (error) {
      await this.save({
        ...(await this.metadata()),
        lastAttempt: new Date(now).toISOString(),
        error:
          'Automatic backup failed. Check the backup folder and recovery password.',
      });
      throw error;
    }
  }
  private async removeManagedBackup(id: string) {
    const metadata = await this.metadata();
    const record = metadata.records.find((record) => record.id === id);
    // Old metadata without a file identity is retained conservatively.
    if (!record?.file || !metadata.destination || metadata.records.length < 2)
      return;
    const destination = await this.checkDestination(metadata.destination);
    const file = join(destination, `${z.uuid().parse(id)}.dotbackup`);
    let value;
    try {
      value = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (value) {
      if (
        !value.isFile() ||
        (['size', 'mtimeMs', 'ino', 'dev'] as const).some(
          (key) => value[key] !== record.file![key],
        )
      )
        return;
      await rm(file);
    }
    await this.save({
      ...metadata,
      records: metadata.records.filter((record) => record.id !== id),
    });
  }
  subscribe(listener: (status: StorageStatus) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private guard(context: StorageInvocation, focus = false) {
    if (this.disposed || !context.trusted())
      throw new Error('Invalid storage sender');
    if (focus && !context.focused())
      throw new Error('Focus the workspace to manage backups');
  }
  private configuration() {
    const configuration = this.options.configuration();
    if (!configuration)
      throw new Error('Choose a workspace before managing backups');
    return configuration;
  }
  private stateFile() {
    const key = createHash('sha256')
      .update(resolve(this.configuration().database))
      .digest('hex');
    return join(this.options.profile, 'storage', key, 'settings.json');
  }
  private async metadata(): Promise<Metadata> {
    try {
      return metadataSchema.parse(
        JSON.parse(await readFile(this.stateFile(), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, automatic: false, records: [] };
      throw new Error(
        'Backup settings could not be read; existing backups were retained',
        { cause: error },
      );
    }
  }
  private async save(metadata: Metadata) {
    const file = this.stateFile();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await atomicStorageWrite(
      file,
      JSON.stringify(metadataSchema.parse(metadata)),
    );
    await this.emit();
  }
  async status(): Promise<StorageStatus> {
    const metadata = await this.metadata();
    return {
      secureStorage: this.keys().available(),
      destination: metadata.destination,
      automatic: metadata.automatic,
      lastAttempt: metadata.lastAttempt,
      lastSuccess: metadata.lastSuccess,
      error: metadata.error,
      operation: this.operation && { ...this.operation },
      preview: this.preview && structuredClone(this.preview),
      coverage: this.coverage && structuredClone(this.coverage),
    };
  }
  private async emit() {
    if (!this.listeners.size || this.disposed) return;
    const state = await this.status();
    for (const listener of this.listeners) listener(state);
  }
  private phase(phase: StorageOperationStatus['phase']) {
    if (this.operation) this.operation = { ...this.operation, phase };
    void this.emit().catch(() => {});
  }
  async invoke(
    method: keyof Omit<DesktopStorageBridge, 'onStatus'>,
    input: unknown,
    context: StorageInvocation,
  ): Promise<unknown> {
    this.guard(context);
    if (this.choosing && method !== 'status' && method !== 'cancel')
      throw new Error('A storage chooser is already active');
    const chooser = [
      'chooseBackupDirectory',
      'setAutomatic',
      'previewRestore',
      'restore',
    ].includes(method);
    if (chooser) this.choosing = true;
    try {
      return await this.dispatch(method, input, context);
    } finally {
      if (chooser) this.choosing = false;
    }
  }
  private async dispatch(
    method: keyof Omit<DesktopStorageBridge, 'onStatus'>,
    input: unknown,
    context: StorageInvocation,
  ): Promise<unknown> {
    this.guard(context);
    if (method === 'status') return this.status();
    if (method === 'cancel') {
      const id = z.uuid().parse(input);
      if (this.operation?.id !== id)
        throw new Error('Storage operation not found');
      await this.cancelActive();
      this.preview = undefined;
      this.phase('cancelled');
      return;
    }
    this.guard(context, true);
    if (this.running) throw new Error('A storage operation is already active');
    if (method === 'setAutomatic') {
      const { enabled } = z
        .object({ enabled: z.boolean() })
        .strict()
        .parse(input);
      const metadata = await this.metadata();
      if (enabled) {
        if (!this.keys().available())
          throw new Error('Secure storage is required for automatic backups');
        if (!metadata.destination)
          throw new Error('Choose a backup folder first');
        await this.checkDestination(metadata.destination);
        if (!(await this.keys().recall()))
          throw new Error(
            'Remember a recovery password before enabling automatic backups',
          );
      }
      this.guard(context, true);
      await this.save({ ...metadata, automatic: enabled });
      return;
    }
    if (method === 'chooseBackupDirectory') {
      if (input !== undefined)
        throw new Error('Folder paths must be chosen natively');
      const selected = await context.chooseDirectory('backup');
      this.guard(context, true);
      if (!selected) return false;
      const destination = await this.checkDestination(selected);
      this.guard(context, true);
      const metadata = await this.metadata();
      await this.save(
        metadata.destination === destination
          ? metadata
          : { version: 1, destination, automatic: false, records: [] },
      );
      return true;
    }
    if (method === 'backupNow') {
      const value = z
        .object({ passphrase: password, remember: z.boolean() })
        .strict()
        .parse(input);
      if (value.remember && !this.keys().available())
        throw new Error(
          'Secure storage is unavailable; use a manual backup without remembering the password',
        );
      return this.run('backup', async (signal) => {
        if (value.remember) await this.keys().remember(value.passphrase);
        this.guard(context, true);
        await this.backup(value.passphrase, signal, 'manual');
      });
    }
    if (method === 'previewRestore') {
      const value = z.object({ passphrase: password }).strict().parse(input);
      const archive = await context.chooseArchive();
      this.guard(context, true);
      if (!archive) return;
      const parent = await context.chooseDirectory('restore');
      this.guard(context, true);
      if (!parent) return;
      const destination = join(
        await realpath(parent),
        `Dots-restored-${randomUUID()}`,
      );
      const env = parseEnv(
        await readFile(this.configuration().envFile, 'utf8'),
      );
      if (!env.LOCAL_DATABASE_URL)
        throw new Error(
          'Configure a destination PostgreSQL server before restoring this legacy backup',
        );
      return this.run('restore', async (signal) => {
        this.guard(context, true);
        const result = await this.options.worker.run(
          {
            kind: 'preview',
            profile: this.options.profile,
            archive,
            destination,
            postgresTarget: env.LOCAL_DATABASE_URL!,
            passphrase: value.passphrase,
          },
          { signal, phase: (phase) => this.phase(phase) },
        );
        if (!('operationId' in result))
          throw new Error('Invalid restore preview');
        this.preview = result;
        this.operation = {
          id: result.operationId,
          kind: 'restore',
          phase: 'ready',
        };
      });
    }
    if (method === 'restore') {
      const value = z
        .object({ operationId: z.uuid(), mode: z.enum(['new', 'replace']) })
        .strict()
        .parse(input);
      if (this.preview?.operationId !== value.operationId)
        throw new Error('Create a fresh restore preview');
      if (!(await context.confirmRestore(value.mode))) return;
      this.guard(context, true);
      if (this.preview?.operationId !== value.operationId)
        throw new Error('Restore preview changed');
      return this.run(
        'restore',
        async (signal) => {
          let verifiedBackupDirectory: string | undefined;
          if (value.mode === 'replace') {
            const passphrase = await this.keys().recall();
            if (!passphrase)
              throw new Error(
                'Save a recovery password and create a verified backup before replacement',
              );
            await this.backup(passphrase, signal, 'manual');
            verifiedBackupDirectory = this.configuration().workspace;
          }
          const result = await this.options.worker.run(
            {
              kind: 'activate',
              profile: this.options.profile,
              operationId: value.operationId,
              mode: value.mode,
              verifiedBackupDirectory,
            },
            {
              signal,
              phase: (phase) => this.phase(phase),
              stopWorkspace: () => {
                this.guard(context);
                return this.options.stopWorkspace();
              },
            },
          );
          if (!('workspaceDirectory' in result))
            throw new Error('Restore activation did not complete');
          this.preview = undefined;
          await this.options.afterRestore();
        },
        value.operationId,
      );
    }
    throw new Error('Unsupported storage command');
  }
  private run(
    kind: 'backup' | 'restore',
    action: (signal: AbortSignal) => Promise<void>,
    id: string = randomUUID(),
  ) {
    const controller = new AbortController();
    this.operation = { id, kind, phase: 'queued' };
    const done = Promise.resolve()
      .then(() => action(controller.signal))
      .then(
        () => {
          this.phase('ready');
        },
        async (error: unknown) => {
          const message = controller.signal.aborted
            ? 'Storage operation cancelled'
            : error instanceof Error
              ? error.message
              : 'Storage operation failed';
          this.operation = {
            ...this.operation!,
            phase: controller.signal.aborted ? 'cancelled' : 'failed',
            error: message,
          };
          throw error;
        },
      )
      .finally(async () => {
        this.running = undefined;
        await this.emit().catch(() => {});
      });
    this.running = { controller, done };
    void this.emit().catch(() => {});
    return done;
  }
  private async checkDestination(directory: string) {
    const destination = await realpath(directory);
    const workspace = await realpath(this.configuration().workspace);
    const within = relative(workspace, destination);
    if (
      !within ||
      (within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within))
    )
      throw new Error('Choose a backup folder outside the active workspace');
    const probe = join(destination, `.dots-write-check-${randomUUID()}`);
    const file = await open(probe, 'wx', 0o600);
    try {
      await file.sync();
    } finally {
      await file.close();
      await rm(probe, { force: true });
    }
    return destination;
  }
  private async json(
    connection: WorkspaceBackendConnection,
    path: string,
    method = 'GET',
    body?: unknown,
  ) {
    const response = await (this.options.request ?? fetch)(
      `${connection.url}/api${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${connection.ownerToken}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
      },
    );
    if (!response.ok)
      throw new Error('Workspace storage service is unavailable or busy');
    return response.json();
  }
  private async backup(
    passphrase: string,
    signal: AbortSignal,
    origin: 'manual' | 'automatic',
  ) {
    const configuration = this.configuration();
    const connection = this.options.connection();
    if (!connection?.ownerToken)
      throw new Error(
        'A supported authenticated workspace is required for backup',
      );
    const metadata = await this.metadata();
    if (!metadata.destination) throw new Error('Choose a backup folder first');
    const destination = await this.checkDestination(metadata.destination);
    const identity = await this.json(connection, '/desktop/identity');
    if (
      !Array.isArray(identity.capabilities) ||
      !identity.capabilities.includes('workspace-snapshot-v1')
    )
      throw new Error(
        'This backend does not support consistent workspace backups',
      );
    signal.throwIfAborted();
    metadata.lastAttempt = new Date().toISOString();
    metadata.error = undefined;
    await this.save(metadata);
    this.phase('snapshot');
    let id: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      id = z.uuid().parse(
        (
          await this.json(connection, '/storage/snapshots', 'POST', {
            origin,
          })
        ).id,
      );
      let captured;
      for (;;) {
        signal.throwIfAborted();
        captured = await this.json(connection, `/storage/snapshots/${id}`);
        if (captured.phase === 'ready') break;
        if (captured.phase !== 'capturing')
          throw new Error(captured.error || 'Snapshot could not be completed');
        await delay(100, undefined, { signal });
      }
      const manifest = parseArchiveManifest(JSON.stringify(captured.manifest));
      if (
        manifest.kind !== 'workspace-backup' ||
        manifest.workspaceId !== identity.workspaceId
      )
        throw new Error(
          'Snapshot identity does not match the connected workspace',
        );
      const archiveId = z.uuid().parse(manifest.archiveId);
      const expected = join(
        dirname(resolve(configuration.database)),
        '.storage-snapshots',
        id,
      );
      if (resolve(captured.directory) !== expected)
        throw new Error(
          'Snapshot directory does not match the selected workspace',
        );
      const disk = await statfs(destination);
      if (
        disk.bavail * disk.bsize <
        manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0) * 2 +
          64 * 1024 * 1024
      )
        throw new Error('The backup destination needs more free space');
      heartbeat = setInterval(() => {
        void this.json(connection, `/storage/snapshots/${id}`).catch(() => {});
      }, 30000);
      const result = await this.options.worker.run(
        {
          kind: 'backup',
          sourceDirectory: captured.directory,
          destination: join(destination, `${archiveId}.dotbackup`),
          manifest,
          passphrase,
        },
        { signal, phase: (phase) => this.phase(phase) },
      );
      if (!('verified' in result) || !result.verified)
        throw new Error('Backup was not verified');
      if (result.id !== archiveId) throw new Error('Backup identity changed');
      const file = await lstat(join(destination, `${archiveId}.dotbackup`));
      if (!file.isFile()) throw new Error('Verified backup is unavailable');
      this.coverage = result.coverage;
      metadata.lastSuccess = new Date().toISOString();
      metadata.records.push({
        id: result.id,
        createdAt: result.createdAt,
        verified: true,
        managed: true,
        file: {
          size: file.size,
          mtimeMs: file.mtimeMs,
          ino: file.ino,
          dev: file.dev,
        },
      });
      await this.save(metadata);
      return result;
    } catch (error) {
      metadata.error = signal.aborted
        ? 'Backup cancelled'
        : 'Backup failed. Existing recovery points were retained.';
      await this.save(metadata);
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (id)
        await this.json(
          connection,
          `/storage/snapshots/${id}/release`,
          'POST',
          {},
        ).catch(() => {});
    }
  }
  async cancelActive() {
    this.cancelling = true;
    this.running?.controller.abort();
    await this.running?.done.catch(() => {});
    await this.ticking?.catch(() => {});
    this.cancelling = false;
  }
  async close() {
    this.disposed = true;
    clearInterval(this.timer);
    await this.cancelActive();
    this.listeners.clear();
  }
}
