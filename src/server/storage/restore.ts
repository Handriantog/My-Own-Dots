import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  lstat,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import type { ArchiveManifest } from '../../shared/storage-archive.js';
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
  restorePool,
  restorePostgres,
} from './restore-postgres.js';
import { restoreSQLite } from './restore-sqlite.js';
import {
  atomicStorageWrite,
  fileSeal,
  loadJournal,
  ownedRestoreDirectory,
  readSelection,
  saveJournal,
  withRestoreLock,
  type RestoreJournal,
} from './restore-journal.js';

export interface RestorePreview {
  operationId: string;
  workspaceId: string;
  counts: Record<string, number>;
  coverage: ArchiveManifest['coverage'];
  warnings: string[];
}
interface RestoreOptions {
  profile: string;
  stopWorkspace: () => Promise<void>;
  now?: () => number;
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
    const { destination, signal } = input;
    if (!isAbsolute(destination))
      throw new Error('Choose an absolute restore destination');
    if (!input.postgresTarget)
      throw new Error('Choose a PostgreSQL server for this legacy backup');
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
    };
    let databaseUrl: string | undefined;
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
      const expected = [
        'core/workspace.sqlite',
        'recovery/configuration.json',
        ...Object.keys(POSTGRES_RECORDS).map(
          (table) => `postgres/${table}.jsonl`,
        ),
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
      const sqlite = await restoreSQLite(
        join(snapshot, 'core/workspace.sqlite'),
        join(destination, 'data/opendots.sqlite'),
        manifest.ownerId,
        signal,
      );
      const postgres = await restorePostgres({
        server: input.postgresTarget,
        operationId,
        directory: snapshot,
        ownerId: manifest.ownerId,
        dotIds: sqlite.dotIds,
        threads: sqlite.threads,
        signal,
      });
      databaseUrl = postgres.url;
      journal.postgresSeal = postgres.seal;
      // Only app-generated safe defaults and the explicitly selected target server.
      const quote = (value: string) => {
        if (/[\r\n\0']/.test(value))
          throw new Error('Unsupported restored configuration value');
        return `'${value}'`;
      };
      await atomicStorageWrite(
        join(destination, '.env'),
        `HOST=127.0.0.1\nPORT=4310\nDATABASE_PATH=data/opendots.sqlite\nOWNER_ID=${quote(manifest.ownerId)}\nOWNER_TOKEN=${randomBytes(32).toString('hex')}\nCONVERSATION_BACKEND=local\nLOCAL_DATABASE_URL=${quote(postgres.url)}\nLLM_BACKEND=subscription\nLLM_PROVIDER=codex\nDO_NOT_TRACK=1\n`,
      );
      for (const path of [
        '.restore-owner',
        '.env',
        'data/opendots.sqlite',
        'recovery/access-audit.jsonl',
        ...manifest.entries.map((entry) => 'snapshot/' + entry.path),
      ])
        journal.files.push({
          path,
          sha256: await fileSeal(join(destination, path), signal),
        });
      await this.phase(journal, 'verified');
      return {
        operationId,
        workspaceId: workspaceIdentity(
          join(destination, 'data/opendots.sqlite'),
        ),
        counts: { ...sqlite.counts, ...postgres.counts },
        coverage: manifest.coverage,
        warnings: [
          'Schedules and learning are paused. External access must be approved again.',
          'Computer files and browser profiles are not included.',
        ],
      };
    } catch (error) {
      if (databaseUrl) {
        const admin = restorePool(input.postgresTarget);
        try {
          await admin.query(
            `DROP DATABASE "${restoredDatabaseName(operationId)}"`,
          );
        } catch {
          /* Keep an orphan rather than touching any unrelated database. */
        } finally {
          await admin.end();
        }
      }
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
  private async verify(journal: RestoreJournal, signal: AbortSignal) {
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
  async activateRestore(
    operationId: string,
    mode: 'new' | 'replace',
    signal: AbortSignal,
  ) {
    return withRestoreLock(this.options.profile, async () => {
      const journal = await loadJournal(this.options.profile, operationId);
      if (journal.phase !== 'verified')
        throw new Error('Restore preview is not ready');
      if (this.now() - journal.createdAt > 15 * 60_000)
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
        await atomicStorageWrite(
          join(this.options.profile, 'workspace-location.json'),
          JSON.stringify({ directory: journal.directory }),
        );
        await this.phase(journal, 'active');
        return { workspaceDirectory: journal.directory };
      } catch (error) {
        if (switchingStarted) {
          const selected = await readSelection(this.options.profile);
          if (
            selected &&
            JSON.parse(selected).directory === journal.directory
          ) {
            if (journal.previousSelection === null)
              await rm(join(this.options.profile, 'workspace-location.json'), {
                force: true,
              });
            else
              await atomicStorageWrite(
                join(this.options.profile, 'workspace-location.json'),
                journal.previousSelection,
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
    let entries: string[];
    try {
      entries = await readdir(join(this.options.profile, 'restore-journals'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.filter((name) =>
      /^[a-f0-9-]{36}\.json$/.test(name),
    )) {
      const journal = await loadJournal(
        this.options.profile,
        entry.slice(0, -5),
      );
      if (journal.phase !== 'switching') continue;
      const current = await readSelection(this.options.profile);
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
            await atomicStorageWrite(
              join(this.options.profile, 'workspace-location.json'),
              journal.previousSelection,
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
  }
}
