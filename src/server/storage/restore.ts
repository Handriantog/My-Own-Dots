import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  lstat,
  realpath,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import type { ArchiveManifest } from '../../shared/storage-archive.js';
import {
  createWorkspaceManifest,
  readWorkspaceManifest,
  sqliteStorageSchema,
} from '../../shared/workspace-manifest.js';
import {
  claimWorkspaceDatabase,
  workspaceIdentity,
} from '../workspace-identity.js';
import { readArchive } from './archive.js';
import { validateArchivePaths } from './archive-paths.js';
import { POSTGRES_RECORDS } from './postgres-records.js';
import {
  postgresSeal,
  restoredDatabaseName,
  restoredDatabaseUrl,
  assertRestoredRelations,
  restorePool,
  restorePostgres,
} from './restore-postgres.js';
import { restoreSQLite } from './restore-sqlite.js';
import { migrateLegacySnapshot } from './migrate-workspace.js';
import { recoverMigrationScratch } from './migration-scratch.js';
import {
  atomicStorageWrite,
  fileSeal,
  loadJournal,
  ownedRestoreDirectory,
  readSelection,
  writeSelection,
  saveJournal,
  withRestoreLock,
  type RestoreJournal,
  journalPath,
  type MigrationProof,
} from './restore-journal.js';

export interface RestorePreview {
  destination?: string;
  backupPath?: string;
  operationId: string;
  expiresAt?: number;
  workspaceId: string;
  counts: Record<string, number>;
  coverage: ArchiveManifest['coverage'];
  warnings: string[];
}
interface RestoreOptions {
  profile: string;
  stopWorkspace: () => Promise<void>;
  now?: () => number;
  /** Host-only migration configuration; archived environment files are never applied. */
  migration?: { proof: MigrationProof; configuration: string };
  migrationAuthorized?: boolean;
  movementAuthorized?: boolean;
  /** Host verifies a fresh backup of the selected workspace before replacement. */
  preRestoreBackup?: (
    signal: AbortSignal,
  ) => Promise<{ verified: true; directory: string }>;
  onPhase?: (
    operationId: string,
    phase: RestoreJournal['phase'],
  ) => void | Promise<void>;
}
/** Host-owned service. Paths, database server, and callbacks never come from renderer IPC. */
export class RestoreService {
  constructor(private readonly options: RestoreOptions) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private async phase(journal: RestoreJournal, phase: RestoreJournal['phase']) {
    journal.phase = phase;
    await saveJournal(this.options.profile, journal);
    await this.options.onPhase?.(journal.operationId, phase);
  }
  async prepareRestore(input: {
    archive: string;
    passphrase: string;
    destination: string;
    postgresTarget?: string;
    signal: AbortSignal;
  }): Promise<RestorePreview> {
    return withRestoreLock(this.options.profile, () =>
      this.prepareLocked(input),
    );
  }
  private async prepareLocked(input: {
    archive: string;
    passphrase: string;
    destination: string;
    postgresTarget?: string;
    signal: AbortSignal;
  }): Promise<RestorePreview> {
    const { destination, signal } = input;
    if (!isAbsolute(destination))
      throw new Error('Choose an absolute restore destination');
    signal.throwIfAborted();
    const operationId = randomUUID();
    // Exclusive creation is the ownership boundary. Existing directories are never cleaned.
    await mkdir(destination, { mode: 0o700 });
    const journal: RestoreJournal = {
      version: 1,
      operationId,
      phase: 'staging',
      createdAt: this.now(),
      directory: destination,
      previousSelection: await readSelection(this.options.profile),
      files: [],
      postgresTarget: input.postgresTarget,
      ...(this.options.migration
        ? { migration: this.options.migration.proof }
        : {}),
    };
    try {
      await writeFile(join(destination, '.restore-owner'), operationId, {
        flag: 'wx',
        mode: 0o600,
      });
      await this.phase(journal, 'staging');
      const snapshot = join(destination, 'snapshot');
      const manifest = await readArchive({
        source: input.archive,
        stagingDirectory: snapshot,
        passphrase: input.passphrase,
        signal,
      });
      const migration = this.options.migration;
      if (
        migration &&
        (manifest.version !== 1 ||
          manifest.ownerId !== migration.proof.source.ownerId ||
          manifest.workspaceId !== migration.proof.source.workspaceId)
      )
        throw new Error('Migration capture identity changed');
      const unified = manifest.version === 2 || !!migration;
      journal.storage = unified ? 'sqlite' : 'legacy-postgres';
      if (!unified && !input.postgresTarget)
        throw new Error('Choose a PostgreSQL server for this legacy backup');
      await this.phase(journal, 'staging');
      const expected = [
        'core/workspace.sqlite',
        'recovery/configuration.json',
        ...(manifest.version === 2
          ? []
          : Object.keys(POSTGRES_RECORDS).map(
              (table) => `postgres/${table}.jsonl`,
            )),
      ];
      if (
        manifest.kind !== 'workspace-backup' ||
        JSON.stringify(manifest.entries.map((entry) => entry.path).sort()) !==
          JSON.stringify(expected.sort())
      )
        throw new Error('Unsupported workspace backup components');
      if (
        !['core-sqlite', 'local-conversations-memory'].every((component) =>
          manifest.coverage.some(
            (entry) =>
              entry.component === component && entry.state === 'included',
          ),
        )
      )
        throw new Error('Incomplete workspace backup');
      await mkdir(join(destination, 'data'), { mode: 0o700 });
      await mkdir(join(destination, 'recovery'), { mode: 0o700 });
      const converted = migration
        ? await migrateLegacySnapshot({
            directory: snapshot,
            destination: join(destination, 'data/opendots.sqlite'),
            ownerId: manifest.ownerId,
            signal,
          })
        : undefined;
      const sqlite = converted
        ? { counts: converted.counts, dotIds: [], threads: [] }
        : await restoreSQLite(
            join(snapshot, 'core/workspace.sqlite'),
            join(destination, 'data/opendots.sqlite'),
            manifest.ownerId,
            signal,
            unified ? 'sqlite' : 'legacy-postgres',
          );
      const postgres = unified
        ? undefined
        : await restorePostgres({
            server: input.postgresTarget!,
            operationId,
            directory: snapshot,
            ownerId: manifest.ownerId,
            dotIds: sqlite.dotIds,
            threads: sqlite.threads,
            signal,
            onCreated: async (oid) => {
              journal.postgresOid = oid;
              await this.phase(journal, 'staging');
            },
          });
      journal.postgresSeal = postgres?.seal;
      if (unified)
        await createWorkspaceManifest(destination, {
          version: 1,
          id: migration?.proof.targetWorkspaceId ?? randomUUID(),
          ownerId: manifest.ownerId,
          storage: 'sqlite',
          schema: sqliteStorageSchema,
        });
      // Only app-generated safe defaults and the explicitly selected target server.
      const quote = (value: string) => {
        if (/[\r\n\0']/.test(value))
          throw new Error('Unsupported restored configuration value');
        return `'${value}'`;
      };
      const migratedEnvironment = migration
        ? Object.entries(parseEnv(migration.configuration))
            .filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string' &&
                ![
                  'HOST',
                  'PORT',
                  'DATABASE_PATH',
                  'OWNER_ID',
                  'OWNER_TOKEN',
                  'CONVERSATION_BACKEND',
                  'LOCAL_DATABASE_URL',
                  'DOTS_WORKSPACE_ENV',
                  'APP_ORIGIN',
                ].includes(entry[0]),
            )
            .map(([key, value]) => `${key}=${quote(value)}\n`)
            .join('')
        : '';
      await atomicStorageWrite(
        join(destination, '.env'),
        `HOST=127.0.0.1\nPORT=4310\nDATABASE_PATH=data/opendots.sqlite\nOWNER_ID=${quote(manifest.ownerId)}\nOWNER_TOKEN=${randomBytes(32).toString('hex')}\nCONVERSATION_BACKEND=local\n${postgres ? `LOCAL_DATABASE_URL=${quote(postgres.url)}\n` : ''}LLM_BACKEND=subscription\nLLM_PROVIDER=codex\nDO_NOT_TRACK=1\n${migratedEnvironment}`,
      );
      for (const path of [
        '.restore-owner',
        '.env',
        ...(unified ? ['workspace.json'] : []),
        'data/opendots.sqlite',
        migration
          ? 'recovery/migration-verification.json'
          : 'recovery/access-audit.jsonl',
        ...manifest.entries.map((entry) => 'snapshot/' + entry.path),
      ])
        journal.files.push({
          path,
          sha256: await fileSeal(join(destination, path), signal),
        });
      journal.verifiedAt = this.now();
      await this.phase(journal, 'verified');
      return {
        destination,
        ...(migration ? { backupPath: migration.proof.backup.path } : {}),
        operationId,
        expiresAt: journal.verifiedAt + 15 * 60_000,
        workspaceId:
          (await readWorkspaceManifest(destination))?.id ??
          workspaceIdentity(join(destination, 'data/opendots.sqlite')),
        counts: { ...sqlite.counts, ...postgres?.counts },
        coverage: manifest.coverage,
        warnings: [
          migration
            ? 'Automation is paused. Same-machine connection and permission definitions are retained; interrupted actions will not replay.'
            : 'Schedules and learning are paused. External access must be approved again.',
          'Computer files and browser profiles are not included.',
        ],
      };
    } catch (error) {
      try {
        await this.discardLocked(journal, new AbortController().signal);
      } catch {
        // Preserve durable ownership information for startup/manual cleanup.
        await saveJournal(this.options.profile, journal).catch(() => {});
      }
      throw error;
    }
  }
  private async verify(
    journal: RestoreJournal,
    signal: AbortSignal,
    filesOnly = false,
  ) {
    await ownedRestoreDirectory(journal);
    validateArchivePaths(journal.files.map((entry) => entry.path));
    for (const entry of journal.files) {
      let parent = journal.directory;
      for (const part of entry.path.split('/').slice(0, -1)) {
        parent = join(parent, part);
        if (!(await lstat(parent)).isDirectory())
          throw new Error('Restore target changed');
      }
      if (
        (await fileSeal(join(journal.directory, entry.path), signal)) !==
        entry.sha256
      )
        throw new Error('Restore target checksum changed');
    }
    for (const suffix of ['-wal', '-shm']) {
      try {
        await lstat(join(journal.directory, 'data/opendots.sqlite' + suffix));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new Error('Restore target was opened or changed');
    }
    if (filesOnly) return;
    if (journal.storage === 'sqlite') {
      const manifest = await readWorkspaceManifest(journal.directory);
      if (
        manifest?.storage !== 'sqlite' ||
        manifest.schema !== sqliteStorageSchema
      )
        throw new Error('Restored workspace identity changed');
      return;
    }
    const env = parseEnv(
      await readFile(join(journal.directory, '.env'), 'utf8'),
    );
    if (
      !env.LOCAL_DATABASE_URL ||
      new URL(env.LOCAL_DATABASE_URL).pathname !==
        '/' + restoredDatabaseName(journal.operationId)
    )
      throw new Error('Restored database ownership changed');
    const pool = restorePool(env.LOCAL_DATABASE_URL);
    try {
      if (
        (await postgresSeal(pool, journal.operationId, signal)) !==
        journal.postgresSeal
      )
        throw new Error('Restored database checksum changed');
    } finally {
      await pool.end();
    }
  }
  async discardRestore(operationId: string, signal: AbortSignal) {
    return withRestoreLock(this.options.profile, async () => {
      const journal = await loadJournal(this.options.profile, operationId);
      await this.discardLocked(journal, signal);
    });
  }
  private async discardLocked(journal: RestoreJournal, signal: AbortSignal) {
    if (!['staging', 'verified'].includes(journal.phase))
      throw new Error('An active restore cannot be discarded');
    const selection = await readSelection(this.options.profile);
    if (selection) {
      const directory = JSON.parse(selection).directory;
      if (
        directory === journal.directory ||
        (await realpath(directory).catch(() => directory)) ===
          (await realpath(journal.directory).catch(() => journal.directory))
      )
        throw new Error('The selected workspace cannot be discarded');
    }
    let present = true;
    try {
      await lstat(journal.directory);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        journal.cleanupPending
      )
        present = false;
      else throw error;
    }
    if (present) await ownedRestoreDirectory(journal);
    // Do not remove user-added files or follow links, even inside an owned target.
    const allowed = new Set([
      '.restore-owner',
      '.env',
      'workspace.json',
      'data/opendots.sqlite',
      'recovery/access-audit.jsonl',
      'recovery/migration-verification.json',
      'snapshot/core/workspace.sqlite',
      'snapshot/recovery/configuration.json',
      ...Object.keys(POSTGRES_RECORDS).map(
        (table) => `snapshot/postgres/${table}.jsonl`,
      ),
      ...(journal.movement?.targetPaths ?? []),
    ]);
    validateArchivePaths([...allowed]);
    const inspect = async (prefix = '') => {
      for (const item of await readdir(join(journal.directory, prefix), {
        withFileTypes: true,
      })) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (
          item.isDirectory() &&
          ([...allowed].some((name) => name.startsWith(path + '/')) ||
            (journal.movement && path === 'files'))
        )
          await inspect(path);
        else if (!item.isFile() || !allowed.has(path))
          throw new Error(
            `Restore contains changed or unrecognized file ${path}; retained for manual cleanup`,
          );
      }
    };
    if (present) {
      await inspect();
      if (journal.phase === 'verified')
        await this.verify(journal, signal, !!journal.cleanupPending);
    }
    const release = present
      ? claimWorkspaceDatabase(join(journal.directory, 'data/opendots.sqlite'))
      : undefined;
    try {
      signal.throwIfAborted();
      journal.cleanupPending = true;
      await saveJournal(this.options.profile, journal);
      if (
        !journal.databaseRemoved &&
        journal.storage !== 'sqlite' &&
        (journal.postgresTarget || journal.postgresOid || journal.postgresSeal)
      ) {
        if (!journal.postgresTarget)
          throw new Error(
            'Restore database ownership is unavailable; retained for manual cleanup',
          );
        const admin = restorePool(journal.postgresTarget);
        try {
          const name = restoredDatabaseName(journal.operationId);
          const database = await admin.query(
            'SELECT oid::text FROM pg_database WHERE datname=$1',
            [name],
          );
          if (database.rowCount) {
            if (
              !journal.postgresOid ||
              database.rows[0].oid !== journal.postgresOid
            )
              throw new Error(
                'Restore database identity changed; retained for manual cleanup',
              );
            const target = restorePool(
              restoredDatabaseUrl(journal.postgresTarget, journal.operationId),
            );
            try {
              await assertRestoredRelations(target);
              const identity = await target.query(
                'SELECT operation_id FROM dots_restore_identity',
              );
              if (
                identity.rows.length !== 1 ||
                identity.rows[0].operation_id !== journal.operationId
              )
                throw new Error('Restore database ownership changed');
            } finally {
              await target.end();
            }
            // Never force-disconnect a database another process has opened.
            if (
              (
                await admin.query(
                  'SELECT 1 FROM pg_stat_activity WHERE datname=$1 LIMIT 1',
                  [name],
                )
              ).rowCount
            )
              throw new Error(
                'Restored database is open; retained for manual cleanup',
              );
            await admin.query(`DROP DATABASE "${name}"`);
          }
          journal.databaseRemoved = true;
          await saveJournal(this.options.profile, journal);
        } finally {
          await admin.end();
        }
      }
      if (present) await rm(journal.directory, { recursive: true });
      await rm(journalPath(this.options.profile, journal.operationId), {
        force: true,
      });
    } finally {
      release?.();
      if (release) process.removeListener('exit', release);
    }
  }
  async activateRestore(
    operationId: string,
    mode: 'new' | 'replace',
    signal: AbortSignal,
  ) {
    return withRestoreLock(this.options.profile, async () => {
      const journal = await loadJournal(this.options.profile, operationId);
      if (journal.migration && !this.options.migrationAuthorized)
        throw new Error(
          'Migration requires fresh source and backup verification',
        );
      if (journal.movement && !this.options.movementAuthorized)
        throw new Error('Workspace move requires fresh source verification');
      if (journal.phase !== 'verified')
        throw new Error('Restore preview is not ready');
      if (this.now() - (journal.verifiedAt ?? journal.createdAt) > 15 * 60_000)
        throw new Error('Restore preview expired');
      if (
        (await readSelection(this.options.profile)) !==
        journal.previousSelection
      )
        throw new Error('Selected workspace changed; preview again');
      if (mode === 'replace') {
        if (!this.options.preRestoreBackup)
          throw new Error('A verified pre-restore backup is required');
        const backup = await this.options.preRestoreBackup(signal);
        if (
          !backup.verified ||
          !journal.previousSelection ||
          backup.directory !== JSON.parse(journal.previousSelection).directory
        )
          throw new Error(
            'A verified backup of the selected workspace is required',
          );
      }
      await this.verify(journal, signal);
      await this.options.stopWorkspace();
      const release = claimWorkspaceDatabase(
        join(journal.directory, 'data/opendots.sqlite'),
      );
      let switchingStarted = false;
      try {
        await this.verify(journal, signal);
        signal.throwIfAborted();
        if (
          (await readSelection(this.options.profile)) !==
          journal.previousSelection
        )
          throw new Error('Selected workspace changed while closing');
        switchingStarted = true;
        await this.phase(journal, 'switching');
        await writeSelection(this.options.profile, journal.directory);
        await this.phase(journal, 'active');
        return { workspaceDirectory: journal.directory };
      } catch (error) {
        if (switchingStarted) {
          const selected = await readSelection(this.options.profile, false);
          if (
            selected &&
            JSON.parse(selected).directory === journal.directory
          ) {
            if (journal.previousSelection === null)
              await rm(join(this.options.profile, 'workspace-location.json'), {
                force: true,
              });
            else
              await writeSelection(
                this.options.profile,
                JSON.parse(journal.previousSelection).directory,
              );
          }
          await this.phase(journal, 'verified');
        }
        throw error;
      } finally {
        release();
      }
    });
  }
  /** Call before opening any workspace on host startup. Unfinished captures never become selected. */
  async recover() {
    return withRestoreLock(this.options.profile, () => this.recoverLocked());
  }
  private async recoverLocked() {
    const warnings = await recoverMigrationScratch(this.options.profile);
    let entries: string[];
    try {
      entries = await readdir(join(this.options.profile, 'restore-journals'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      entries = [];
    }
    for (const entry of entries.filter((name) =>
      /^[a-f0-9-]{36}\.json$/.test(name),
    )) {
      const journal = await loadJournal(
        this.options.profile,
        entry.slice(0, -5),
      );
      if (['staging', 'verified'].includes(journal.phase)) {
        try {
          await this.discardLocked(journal, new AbortController().signal);
        } catch {
          warnings.push(
            `Unused restore retained for manual cleanup: ${journal.directory}; database ${restoredDatabaseName(journal.operationId)}. Ownership, changes or database access could not be verified.`,
          );
        }
        continue;
      }
      if (journal.phase !== 'switching') continue;
      const current = await readSelection(this.options.profile, false);
      if (current && JSON.parse(current).directory === journal.directory) {
        try {
          await this.verify(journal, new AbortController().signal);
          await this.phase(journal, 'active');
        } catch {
          if (journal.previousSelection === null)
            await rm(join(this.options.profile, 'workspace-location.json'), {
              force: true,
            });
          else
            await writeSelection(
              this.options.profile,
              JSON.parse(journal.previousSelection).directory,
            );
          await this.phase(journal, 'verified');
        }
      } else if (current === journal.previousSelection)
        await this.phase(journal, 'verified');
      else
        throw new Error(
          'Workspace selection changed during interrupted restoration',
        );
    }
    await atomicStorageWrite(
      join(this.options.profile, 'restore-cleanup-warnings.json'),
      JSON.stringify(warnings),
    );
  }
}
