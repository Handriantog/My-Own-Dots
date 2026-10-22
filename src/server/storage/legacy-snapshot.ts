import { captureAbilityState } from './ability-snapshot.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import type {
  ArchiveEntry,
  ArchiveManifest,
} from '../../shared/storage-archive.js';
import { MaintenanceGate } from './maintenance.js';
import {
  capturePostgresRecords,
  POSTGRES_RECORDS,
} from './postgres-records.js';

export interface SnapshotSource {
  activity?(): Promise<{ idle: boolean; revision: string }>;
  capture(
    directory: string,
    signal: AbortSignal,
    origin?: 'manual' | 'automatic',
  ): Promise<ArchiveManifest>;
}
export interface LegacySnapshotOptions {
  sqlitePath: string;
  postgresUrl?: string;
  ownerId: string;
  workspaceId: string;
  gate: MaintenanceGate;
  owned: boolean;
  conversationBackend: string;
  configurationPath?: string;
  quiesceAbilities?(): Promise<() => Promise<void>>;
  /** Injection boundary for crash/cancellation tests, never a renderer callback. */
  onSQLiteCaptured?: () => void | Promise<void>;
}
export class LegacySnapshotSource implements SnapshotSource {
  private configuration?: Buffer;
  constructor(private readonly options: LegacySnapshotOptions) {
    if (options.configurationPath) {
      this.configuration = readFileSync(options.configurationPath);
      if (this.configuration.length > 1024 * 1024)
        throw new Error('Workspace configuration exceeds limit');
    }
  }
  private async configurationUnchanged() {
    if (
      this.options.configurationPath &&
      !(await readFile(this.options.configurationPath)).equals(
        this.configuration!,
      )
    )
      throw new Error(
        'Workspace configuration changed; reconnect before taking a backup',
      );
  }
  /** Conservative, bounded change signal: no history scans or per-chat writes.
   * PostgreSQL counters can lag, so the next idle tick observes late changes.
   * Shared-server writes may cause an extra backup, never an omitted scope.
   */
  async activity() {
    const { gate, sqlitePath, postgresUrl, configurationPath } = this.options;
    const idle = () =>
      !gate.closing && !gate.status().held && gate.status().activeWrites === 0;
    if (!idle()) return { idle: false, revision: 'busy' };
    if (!postgresUrl) throw new Error('Conversation storage is unavailable');
    const files = await Promise.all(
      [
        sqlitePath,
        `${sqlitePath}-wal`,
        ...(configurationPath ? [configurationPath] : []),
      ].map(async (file) => {
        try {
          const value = await stat(file, { bigint: true });
          return [
            file,
            String(value.size),
            String(value.mtimeNs),
            String(value.ino),
          ];
        } catch (error) {
          if (
            file.endsWith('-wal') &&
            (error as NodeJS.ErrnoException).code === 'ENOENT'
          )
            return [file, 'absent'];
          throw error;
        }
      }),
    );
    const pool = new Pool({
      connectionString: postgresUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    pool.on('error', () => {});
    try {
      const result = await pool.query(
        `SELECT schemaname,relname,relid::text,n_tup_ins::text,n_tup_upd::text,n_tup_del::text
        FROM pg_stat_user_tables WHERE schemaname='public' AND relname=ANY($1::text[]) ORDER BY relname`,
        [Object.keys(POSTGRES_RECORDS)],
      );
      const reset = await pool.query(
        "SELECT stats_reset::text,current_setting('track_counts') AS tracking FROM pg_stat_database WHERE datname=current_database()",
      );
      if (reset.rows[0]?.tracking !== 'on')
        throw new Error('PostgreSQL change tracking is disabled');
      return {
        idle: idle(),
        revision: createHash('sha256')
          .update(JSON.stringify([files, result.rows, reset.rows]))
          .digest('hex'),
      };
    } finally {
      await pool.end();
    }
  }
  async capture(
    directory: string,
    signal: AbortSignal,
    origin: 'manual' | 'automatic' = 'manual',
  ): Promise<ArchiveManifest> {
    const options = this.options;
    if (
      !options.owned ||
      options.conversationBackend !== 'local' ||
      !options.postgresUrl
    )
      throw new Error(
        'A supported locally owned conversation backend is required for a complete backup',
      );
    signal.throwIfAborted();
    await this.configurationUnchanged();
    const lease = await options.gate.acquire({ origin, signal });
    signal = lease.signal;
    let resumeAbilities: (() => Promise<void>) | undefined;
    let created = false;
    let source: DatabaseSync | undefined;
    let pool: Pool | undefined;
    try {
      pool = new Pool({
        connectionString: options.postgresUrl,
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 30000,
      });
      pool.on('error', () => {});
      signal.throwIfAborted();
      resumeAbilities = await this.options.quiesceAbilities?.();
      await mkdir(directory, { mode: 0o700 });
      created = true;
      await mkdir(join(directory, 'core'), { mode: 0o700 });
      await mkdir(join(directory, 'postgres'), { mode: 0o700 });
      await mkdir(join(directory, 'recovery'), { mode: 0o700 });
      source = new DatabaseSync(options.sqlitePath, { readOnly: true });
      // A SQLite file containing another owner's rows is ambiguous, not an
      // invitation to export that owner's information in a full-file backup.
      for (const row of source
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()) {
        const table = String(row.name).replaceAll('"', '""');
        if (
          source
            .prepare(`PRAGMA table_info("${table}")`)
            .all()
            .some((column) => column.name === 'ownerId') &&
          source
            .prepare(`SELECT 1 FROM "${table}" WHERE ownerId<>? LIMIT 1`)
            .get(options.ownerId)
        )
          throw new Error('SQLite contains ambiguous workspace ownership');
      }
      const dots = source
        .prepare('SELECT id FROM dots')
        .all()
        .map((row) => String(row.id));
      const bindings = source
        .prepare('SELECT id,dotId FROM thread_bindings WHERE ownerId=?')
        .all(options.ownerId);
      const client = await pool.connect();
      let released = false;
      // This connection has only read-only capture work. Destroying it interrupts
      // an outstanding query too, so an automatic backup cannot hold foreground
      // admission behind a PostgreSQL table lock or a slow server response.
      const cancelRead = () => {
        if (!released) {
          released = true;
          client.release(true);
        }
      };
      signal.addEventListener('abort', cancelRead, { once: true });
      let entries: ArchiveEntry[];
      try {
        signal.throwIfAborted();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL timezone='UTC'");
        const knownThreads = new Map(
          bindings.map((row) => [String(row.id), String(row.dotId)]),
        );
        for (const row of source
          .prepare('SELECT threadId,dotId FROM page_threads')
          .all()) {
          const previous = knownThreads.get(String(row.threadId));
          if (previous && previous !== row.dotId)
            throw new Error('Ambiguous page conversation binding');
          knownThreads.set(String(row.threadId), String(row.dotId));
        }
        const selected = await client.query<{ id: string; agent_id: string }>(
          'SELECT id,agent_id FROM local_ai_threads WHERE owner_id=$1 AND agent_id=ANY($2::text[])',
          [options.ownerId, dots],
        );
        if (
          selected.rows.some((row) => knownThreads.get(row.id) !== row.agent_id)
        )
          throw new Error('Ambiguous shared Dot conversation ownership');
        for (const binding of bindings) {
          const match = await client.query(
            'SELECT agent_id FROM local_ai_threads WHERE owner_id=$1 AND id=$2',
            [options.ownerId, binding.id],
          );
          if (
            match.rows.length !== 1 ||
            match.rows[0].agent_id !== binding.dotId ||
            !dots.includes(String(binding.dotId))
          )
            throw new Error(
              'Conversation binding is missing or belongs to another workspace',
            );
        }
        signal.throwIfAborted();
        const sqlite = join(directory, 'core/workspace.sqlite');
        await backup(source, sqlite, {
          rate: 128,
          progress: () => {
            signal.throwIfAborted();
          },
        });
        await chmod(sqlite, 0o600);
        await options.onSQLiteCaptured?.();
        signal.throwIfAborted();
        entries = await capturePostgresRecords(
          client,
          directory,
          options.ownerId,
          dots,
          signal,
        );
        await this.configurationUnchanged();
        signal.throwIfAborted();
        await client.query('COMMIT');
      } catch (error) {
        if (!released) await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        signal.removeEventListener('abort', cancelRead);
        if (!released) client.release();
      }
      const computers = source
        .prepare('SELECT dotId,value FROM computer_permissions')
        .all();
      const evidence = JSON.stringify({
        version: 1,
        activatable: false,
        configuration: this.configuration?.toString('utf8') ?? null,
        computerVolumes: computers.map((row) => ({
          dotId: row.dotId,
          permissions: JSON.parse(String(row.value)),
          included: false,
        })),
        notice:
          'Host secrets and paths are recovery evidence only. Do not apply this configuration automatically.',
      });
      const config = await open(
        join(directory, 'recovery/configuration.json'),
        'wx',
        0o600,
      );
      try {
        await config.writeFile(evidence);
        await config.sync();
      } finally {
        await config.close();
      }
      for (const path of [
        'core/workspace.sqlite',
        'recovery/configuration.json',
      ]) {
        const file = await open(join(directory, path), 'r');
        const hash = createHash('sha256');
        let bytes = 0;
        try {
          for await (const chunk of file.createReadStream({
            autoClose: false,
          })) {
            signal.throwIfAborted();
            hash.update(chunk);
            bytes += chunk.length;
          }
        } finally {
          await file.close();
        }
        entries.push({ path, bytes, sha256: hash.digest('hex') });
      }
      if (
        !this.options.quiesceAbilities &&
        (await stat(
          join(dirname(this.options.sqlitePath), 'abilities/state'),
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        }))
      )
        throw new Error('Ability host must confirm shutdown before capture');
      const abilities = await captureAbilityState(
        dirname(this.options.sqlitePath),
        directory,
        signal,
      );
      entries.push(...abilities.entries);
      signal.throwIfAborted();
      return {
        ...(abilities.entries.length
          ? {
              version: 3 as const,
              minimumReader: 3 as const,
              abilities: { version: 1 as const },
              storage: { engine: 'legacy-postgres' as const },
            }
          : { version: 1 as const, minimumReader: 1 as const }),
        kind: 'workspace-backup',
        archiveId: randomUUID(),
        workspaceId: options.workspaceId,
        ownerId: options.ownerId,
        createdAt: new Date().toISOString(),
        entries,
        coverage: [
          { component: 'core-sqlite', state: 'included' },
          { component: 'local-conversations-memory', state: 'included' },
          { component: 'recovery-configuration', state: 'included' },
          ...(abilities.entries.length
            ? [
                {
                  component: 'ability-private-state',
                  state: 'included' as const,
                },
                {
                  component: 'ability-credentials-and-executables',
                  state: 'excluded' as const,
                  reason:
                    'Account credentials stay on this desktop. Packages require digest verification and fresh consent.',
                },
              ]
            : []),
          {
            component: 'computer-volumes',
            state: 'excluded',
            reason:
              'Core backup only. Computer files and browser profiles require their own verified snapshot.',
          },
          {
            component: 'owner-wide-derived-indexes',
            state: 'excluded',
            reason:
              'Rebuilt from restored workspace records; shared-owner counters are not copied.',
          },
        ],
      };
    } catch (error) {
      if (created) await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      try {
        source?.close();
      } finally {
        try {
          await pool?.end();
        } finally {
          try {
            await resumeAbilities?.();
          } finally {
            lease.release();
          }
        }
      }
    }
  }
}
