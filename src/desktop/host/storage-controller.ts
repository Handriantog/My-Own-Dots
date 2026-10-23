import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  statfs,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { parseArchiveManifest } from '../../shared/storage-archive.js';
import { readWorkspaceManifest } from '../../shared/workspace-manifest.js';
import { workspaceIdentity } from '../../server/workspace-identity.js';
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
  chooseDirectory(
    kind: 'backup' | 'restore' | 'move',
  ): Promise<string | undefined>;
  openDirectory(directory: string): Promise<void>;
  chooseArchive(): Promise<string | undefined>;
  chooseBackupFile(defaultPath: string): Promise<string | undefined>;
  confirmRestore(mode: 'new' | 'replace'): Promise<boolean>;
  confirmMigration(mode: 'prepare' | 'activate'): Promise<boolean>;
  confirmMove(mode: 'prepare' | 'activate'): Promise<boolean>;
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
  beforeMaintenance?(): Promise<void>;
  afterMaintenance?(): Promise<void>;
}
const password = z
  .string()
  .max(4096, 'The recovery password must be at most 4096 characters.');
/** Only native dialogs choose paths; renderer commands are strictly shape-checked. */
export class StorageController {
  private operation?: StorageOperationStatus;
  private backupFile?: { workspace: string; path: string };
  private restoreArchive?: { workspace: string; path: string };
  private preview?: StorageStatus['preview'];
  private coverage?: StorageStatus['coverage'];
  private running?: { controller: AbortController; done: Promise<void> };
  private listeners = new Set<(status: StorageStatus) => void>();
  private disposed = false;
  private migrationStopped = false;
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
    if (this.preview?.expiresAt && now >= this.preview.expiresAt)
      await this.discardPreview();
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
    const file = this.stateFile();
    try {
      return metadataSchema.parse(JSON.parse(await readFile(file, 'utf8')));
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
    const configuration = this.options.configuration();
    if (!configuration)
      return {
        secureStorage: false,
        automatic: false,
        error:
          'The workspace is still starting. If it cannot open, choose a workspace in Workspace Setup.',
      };
    const metadata = await this.metadata();
    const manifest = await readWorkspaceManifest(configuration.workspace);
    const engine = manifest?.storage ?? 'legacy-postgres';
    const env = parseEnv(
      await readFile(configuration.envFile, 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }),
    );
    const recoveryWarnings = await readFile(
      join(this.options.profile, 'restore-cleanup-warnings.json'),
      'utf8',
    )
      .then((value) => z.array(z.string()).parse(JSON.parse(value)))
      .catch(() => []);
    return {
      workspaceDirectory: configuration.workspace,
      storageEngine: engine,
      moveAvailable:
        engine === 'sqlite' && this.options.connection()?.owned === true,
      migrationAvailable:
        engine === 'legacy-postgres' &&
        this.options.connection()?.owned === true &&
        !!env.LOCAL_DATABASE_URL &&
        (env.CONVERSATION_BACKEND ?? 'local') === 'local',
      recoveryWarnings,
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
      'chooseBackupFile',
      'chooseRestoreArchive',
      'setAutomatic',
      'previewRestore',
      'restore',
      'previewMigration',
      'migrate',
      'chooseWorkspaceMove',
      'moveWorkspace',
    ].includes(method);
    if (chooser) this.choosing = true;
    try {
      return await this.dispatch(method, input, context);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issue = error.issues.find(
          (issue) => issue.path[0] === 'passphrase',
        );
        if (issue) throw new Error(issue.message, { cause: error });
      }
      throw error;
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
      if (this.operation?.id !== id && this.preview?.operationId !== id)
        throw new Error('Storage operation not found');
      await this.cancelActive();
      this.preview = undefined;
      this.phase('cancelled');
      return;
    }
    this.guard(context, true);
    if (this.running) throw new Error('A storage operation is already active');
    if (method === 'openWorkspaceFolder') {
      z.undefined().parse(input);
      const directory = await realpath(this.configuration().workspace);
      this.guard(context, true);
      return context.openDirectory(directory);
    }
    if (method === 'chooseWorkspaceMove') {
      z.undefined().parse(input);
      if (!(await this.status()).moveAvailable)
        throw new Error(
          'Moving requires a locally owned SQLite workspace; migrate first',
        );
      const configuration = this.configuration();
      const parent = await context.chooseDirectory('move');
      this.guard(context, true);
      if (!parent || !(await context.confirmMove('prepare'))) return;
      this.guard(context, true);
      const manifest = await readWorkspaceManifest(configuration.workspace);
      const identity = await this.json(
        this.options.connection()!,
        '/desktop/identity',
      );
      if (identity.workspaceId !== manifest?.id)
        throw new Error('Workspace identity changed');
      this.guard(context, true);
      return this.run('move', async (signal) => {
        await this.discardPreview(signal);
        const result = await this.options.worker.run(
          {
            kind: 'move-preview',
            profile: this.options.profile,
            source: {
              directory: configuration.workspace,
              sqlitePath: resolve(configuration.database),
            },
            destination: join(
              await realpath(parent),
              `Dots-workspace-${randomUUID()}`,
            ),
          },
          {
            signal,
            phase: (phase) => this.phase(phase),
            stopWorkspace: () => {
              this.guard(context);
              this.migrationStopped = true;
              return this.options.stopWorkspace();
            },
          },
        );
        if (!('operationId' in result)) throw new Error('Invalid move preview');
        this.preview = { ...result, movement: true };
        this.operation = {
          id: result.operationId,
          kind: 'move',
          phase: 'ready',
        };
      });
    }
    if (method === 'moveWorkspace') {
      const value = z.object({ operationId: z.uuid() }).strict().parse(input);
      if (
        !this.preview?.movement ||
        this.preview.operationId !== value.operationId
      )
        throw new Error('Prepare a fresh workspace move');
      if (!(await context.confirmMove('activate'))) return;
      this.guard(context, true);
      if (
        !this.preview?.movement ||
        this.preview.operationId !== value.operationId
      )
        throw new Error('Move preview changed');
      return this.run(
        'move',
        async (signal) => {
          const result = await this.options.worker.run(
            {
              kind: 'move-activate',
              profile: this.options.profile,
              operationId: value.operationId,
            },
            {
              signal,
              phase: (phase) => this.phase(phase),
              stopWorkspace: () => {
                this.guard(context);
                this.migrationStopped = true;
                return this.options.stopWorkspace();
              },
            },
          );
          if (!('workspaceDirectory' in result))
            throw new Error('Workspace move did not complete');
          this.preview = undefined;
          this.migrationStopped = false;
          await this.options.afterRestore();
        },
        value.operationId,
      );
    }
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
    if (method === 'chooseBackupFile') {
      z.undefined().parse(input);
      this.backupFile = undefined;
      const configuration = this.configuration();
      const metadata = await this.metadata();
      const filename = `Dots-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.dotbackup`;
      const selected = await context.chooseBackupFile(
        metadata.destination ? join(metadata.destination, filename) : filename,
      );
      this.guard(context, true);
      if (!selected) return;
      const directory = await this.checkDestination(dirname(selected));
      const path = join(directory, basename(selected));
      const existing = await lstat(path).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        },
      );
      if (existing)
        throw new Error(
          'A file already exists at this location. Choose a new backup name.',
        );
      this.guard(context, true);
      this.backupFile = { workspace: configuration.workspace, path };
      this.operation = undefined;
      return path;
    }
    if (method === 'chooseRestoreArchive') {
      z.undefined().parse(input);
      this.restoreArchive = undefined;
      const workspace = this.configuration().workspace;
      const selected = await context.chooseArchive();
      this.guard(context, true);
      if (!selected) return;
      // Detection only selects the password prompt. The worker validates the
      // full header, checksums and contents again before creating a preview.
      const file = await open(
        selected,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if (!(await file.stat()).isFile())
          throw new Error('Choose a Dot backup file.');
        const head = Buffer.alloc(22);
        const { bytesRead } = await file.read(head, 0, head.length, 0);
        const encrypted = head
          .subarray(0, bytesRead)
          .toString('ascii')
          .startsWith('age-encryption.org/v1\n');
        if (!encrypted && !(head[0] === 0x1f && head[1] === 0x8b))
          throw new Error('This is not a supported Dot backup file.');
        this.guard(context, true);
        this.restoreArchive = { workspace, path: selected };
        this.operation = undefined;
        return { name: basename(selected), encrypted };
      } finally {
        await file.close();
      }
    }
    if (method === 'backupNow') {
      const value = z
        .object({ passphrase: password, remember: z.boolean() })
        .strict()
        .parse(input);
      if (value.remember && !value.passphrase)
        throw new Error('Enter a recovery password before remembering it.');
      const file = this.selectedBackupFile();
      if (value.remember && !this.keys().available())
        throw new Error(
          'Secure storage is unavailable; use a manual backup without remembering the password',
        );
      return this.run('backup', async (signal) => {
        if (value.remember) await this.keys().remember(value.passphrase);
        this.guard(context, true);
        await this.backup(value.passphrase, signal, 'manual', file);
        this.backupFile = undefined;
      });
    }
    if (method === 'previewRestore') {
      const value = z.object({ passphrase: password }).strict().parse(input);
      if (
        this.restoreArchive &&
        this.restoreArchive.workspace !== this.configuration().workspace
      )
        throw new Error('The workspace changed. Choose the backup again.');
      const archive =
        this.restoreArchive?.path ?? (await context.chooseArchive());
      this.guard(context, true);
      if (!archive) return;
      const destination = join(
        dirname(await realpath(this.configuration().workspace)),
        `Dots-restored-${randomUUID()}`,
      );
      const env = parseEnv(
        await readFile(this.configuration().envFile, 'utf8'),
      );
      return this.run('restore', async (signal) => {
        this.guard(context, true);
        await this.discardPreview(signal);
        const result = await this.options.worker.run(
          {
            kind: 'preview',
            profile: this.options.profile,
            archive,
            destination,
            postgresTarget: env.LOCAL_DATABASE_URL,
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
    if (method === 'previewMigration') {
      const value = z.object({ passphrase: password }).strict().parse(input);
      if (!(await this.status()).migrationAvailable)
        throw new Error('Migration requires a locally owned legacy workspace');
      const configuration = this.configuration();
      const metadata = await this.metadata();
      const selected = this.selectedBackupFile();
      if (!selected && !metadata.destination)
        throw new Error('Choose where to save the included backup first.');
      const backupDirectory = await this.checkDestination(
        selected ? dirname(selected) : metadata.destination!,
      );
      const parent = dirname(await realpath(configuration.workspace));
      if (!(await context.confirmMigration('prepare'))) return;
      this.guard(context, true);
      const manifest = await readWorkspaceManifest(configuration.workspace);
      const env = parseEnv(await readFile(configuration.envFile, 'utf8'));
      const workspaceId =
        manifest?.id ??
        configuration.workspaceId ??
        workspaceIdentity(configuration.database);
      const identity = await this.json(
        this.options.connection()!,
        '/desktop/identity',
      );
      if (identity.workspaceId !== workspaceId)
        throw new Error('Migration workspace identity changed');
      this.guard(context, true);
      const source = {
        directory: configuration.workspace,
        sqlitePath: resolve(configuration.database),
        configurationPath: resolve(configuration.envFile),
        ownerId: manifest?.ownerId ?? env.OWNER_ID ?? 'opendots-owner',
        workspaceId,
        postgresUrl: env.LOCAL_DATABASE_URL!,
      };
      return this.run('migration', async (signal) => {
        await this.discardPreview(signal);
        const result = await this.options.worker.run(
          {
            kind: 'migration-preview',
            profile: this.options.profile,
            source,
            destination: join(
              await realpath(parent),
              `Dots-upgraded-${randomUUID()}`,
            ),
            backupDestination:
              selected ??
              join(backupDirectory, `pre-migration-${randomUUID()}.dotbackup`),
            passphrase: value.passphrase,
          },
          {
            signal,
            phase: (phase) => this.phase(phase),
            stopWorkspace: () => {
              this.guard(context);
              this.migrationStopped = true;
              return this.options.stopWorkspace();
            },
          },
        );
        if (!('operationId' in result))
          throw new Error('Invalid migration preview');
        this.backupFile = undefined;
        this.preview = { ...result, migration: true };
        this.operation = {
          id: result.operationId,
          kind: 'migration',
          phase: 'ready',
        };
      });
    }
    if (method === 'migrate') {
      const value = z.object({ operationId: z.uuid() }).strict().parse(input);
      if (
        !this.preview?.migration ||
        this.preview.operationId !== value.operationId
      )
        throw new Error('Create a fresh migration preview');
      if (!(await context.confirmMigration('activate'))) return;
      this.guard(context, true);
      if (
        !this.preview?.migration ||
        this.preview.operationId !== value.operationId
      )
        throw new Error('Migration preview changed');
      return this.run(
        'migration',
        async (signal) => {
          const result = await this.options.worker.run(
            {
              kind: 'migration-activate',
              profile: this.options.profile,
              operationId: value.operationId,
            },
            {
              signal,
              phase: (phase) => this.phase(phase),
              stopWorkspace: () => {
                this.guard(context);
                this.migrationStopped = true;
                return this.options.stopWorkspace();
              },
            },
          );
          if (!('workspaceDirectory' in result))
            throw new Error('Migration activation did not complete');
          this.preview = undefined;
          this.migrationStopped = false;
          await this.options.afterRestore();
        },
        value.operationId,
      );
    }
    if (method === 'restore') {
      if (this.preview?.movement)
        throw new Error('Use the workspace move control');
      if (this.preview?.migration)
        throw new Error('Use the migration activation control');
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
    kind: StorageOperationStatus['kind'],
    action: (signal: AbortSignal) => Promise<void>,
    id: string = randomUUID(),
  ) {
    const controller = new AbortController();
    this.operation = { id, kind, phase: 'queued' };
    const done = Promise.resolve()
      .then(() => this.options.beforeMaintenance?.())
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
        try {
          if ((kind === 'migration' || kind === 'move') && !this.preview)
            await this.resumeMigrationSource();
        } finally {
          await this.options.afterMaintenance?.();
        }
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
  private selectedBackupFile() {
    if (
      this.backupFile &&
      this.backupFile.workspace !== this.configuration().workspace
    )
      throw new Error(
        'The workspace changed. Choose the backup location again.',
      );
    return this.backupFile?.path;
  }
  private async backup(
    passphrase: string,
    signal: AbortSignal,
    origin: 'manual' | 'automatic',
    selectedFile?: string,
  ) {
    const configuration = this.configuration();
    const connection = this.options.connection();
    if (!connection?.ownerToken)
      throw new Error(
        'A supported authenticated workspace is required for backup',
      );
    const metadata = await this.metadata();
    if (!selectedFile && !metadata.destination)
      throw new Error('Choose a backup location first');
    const destination = await this.checkDestination(
      selectedFile ? dirname(selectedFile) : metadata.destination!,
    );
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
      const archivePath =
        selectedFile ?? join(destination, `${archiveId}.dotbackup`);
      const result = await this.options.worker.run(
        {
          kind: 'backup',
          sourceDirectory: captured.directory,
          destination: archivePath,
          manifest,
          passphrase,
        },
        { signal, phase: (phase) => this.phase(phase) },
      );
      if (!('verified' in result) || !result.verified)
        throw new Error('Backup was not verified');
      if (result.id !== archiveId) throw new Error('Backup identity changed');
      const file = await lstat(archivePath);
      if (!file.isFile()) throw new Error('Verified backup is unavailable');
      this.coverage = result.coverage;
      metadata.lastSuccess = new Date().toISOString();
      // User-named manual backups are never subject to scheduled retention.
      if (!selectedFile)
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
  private async discardPreview(signal = new AbortController().signal) {
    if (!this.preview) return;
    const preview = this.preview;
    try {
      await this.options.worker.run(
        {
          kind: 'discard',
          profile: this.options.profile,
          operationId: preview.operationId,
        },
        { signal },
      );
    } catch {
      const file = join(this.options.profile, 'restore-cleanup-warnings.json');
      const warnings: string[] = await readFile(file, 'utf8')
        .then((value) => z.array(z.string()).parse(JSON.parse(value)))
        .catch(() => []);
      warnings.push(
        `Unused restore ${preview.operationId} was retained. Restart Dot for its cleanup location; active and changed data were not removed.`,
      );
      await atomicStorageWrite(file, JSON.stringify(warnings));
    }
    if (this.preview === preview) this.preview = undefined;
    if (preview.migration || preview.movement)
      await this.resumeMigrationSource();
    await this.emit().catch(() => {});
  }
  private async resumeMigrationSource() {
    if (!this.migrationStopped || this.disposed) return;
    this.migrationStopped = false;
    await this.options.afterRestore();
  }
  async cancelActive() {
    this.cancelling = true;
    try {
      this.running?.controller.abort();
      await this.running?.done.catch(() => {});
      await this.ticking?.catch(() => {});
      await this.discardPreview();
    } finally {
      this.cancelling = false;
    }
  }
  async close() {
    this.disposed = true;
    clearInterval(this.timer);
    await this.cancelActive();
    this.listeners.clear();
  }
}
