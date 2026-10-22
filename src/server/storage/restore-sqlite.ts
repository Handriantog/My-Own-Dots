import { copyFile, open, rm, chmod, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../store.js';
import { WorkspaceStore } from '../workspace.js';
import {
  initializeSQLiteSchema,
  sqliteStorageSchema,
} from './sqlite-schema.js';
import { validateUnifiedGraph } from './unified-validation.js';

const inventory = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();

/** Reject unknown schemas before executing any statement that could invoke archived triggers. */
export async function copyValidatedSQLite(
  source: string,
  destination: string,
  ownerId: string,
  signal: AbortSignal,
  engine: 'legacy-postgres' | 'sqlite' = 'legacy-postgres',
  expectedSchema?: 2 | 3 | 4,
) {
  const baselineDirectory = await mkdtemp(
    join(dirname(destination), '.schema-'),
  );
  const supported = new Map<number, ReturnType<typeof inventory>>();
  try {
    const baselinePath = join(baselineDirectory, 'baseline.sqlite');
    const store = new Store(baselinePath);
    store.close();
    const workspace = new WorkspaceStore(baselinePath, ownerId);
    workspace.close();
    if (engine === 'sqlite') {
      const schema = new DatabaseSync(baselinePath);
      try {
        initializeSQLiteSchema(schema, 2);
        supported.set(2, inventory(schema));
        initializeSQLiteSchema(schema, 3);
        supported.set(3, inventory(schema));
        initializeSQLiteSchema(schema);
        supported.set(sqliteStorageSchema, inventory(schema));
      } finally {
        schema.close();
      }
    }
    const baseline = new DatabaseSync(baselinePath, { readOnly: true });
    try {
      if (engine !== 'sqlite') supported.set(0, inventory(baseline));
    } finally {
      baseline.close();
    }
  } finally {
    await rm(baselineDirectory, { recursive: true, force: true });
  }
  const original = new DatabaseSync(source, { readOnly: true });
  try {
    original.exec('PRAGMA trusted_schema=OFF');
    const actual = JSON.stringify(inventory(original));
    // The additive customization migration is also absent in older supported
    // backups. Match that exact known schema; never execute archived DDL.
    const variants = [...supported.entries()].flatMap(([version, schema]) => [
      [version, schema] as const,
      [
        version,
        schema
          .filter((row) => row.name !== 'desktop_dot')
          .map((row) =>
            row.name === 'dots'
              ? {
                  ...row,
                  sql: String(row.sql).replace(', customization TEXT', ''),
                }
              : row,
          ),
      ] as const,
    ]);
    // Ability metadata is absent in historical schema 2/3 and legacy backups.
    // Only exact known inventories are accepted; archived DDL is never executed.
    const compatible = variants.flatMap(([version, schema]) =>
      version < 4
        ? [
            [version, schema] as const,
            [
              version,
              schema.filter((row) => !String(row.name).startsWith('ability_')),
            ] as const,
          ]
        : [[version, schema] as const],
    );
    const matching = compatible.filter(
      ([, expected]) => actual === JSON.stringify(expected),
    );
    if (!matching.length) throw new Error('Unsupported SQLite restore schema');
    // Metadata repositories also exist in legacy workspaces, so additive
    // schema versions may have the same DDL inventory. Match the version row too.
    const storedVersion =
      engine === 'sqlite'
        ? Number(
            original
              .prepare(
                'SELECT max(version) AS version FROM workspace_storage_schema',
              )
              .get()!.version,
          )
        : 0;
    const match = matching.find(([version]) => version === storedVersion);
    if (!match) throw new Error('Unsupported SQLite storage version');
    const [version, expected] = match;
    if (expectedSchema !== undefined && expectedSchema !== version)
      throw new Error('SQLite archive schema does not match its manifest');
    const check = original.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || check[0].integrity_check !== 'ok')
      throw new Error('SQLite integrity check failed');
    if (original.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('SQLite reference check failed');
    for (const item of expected.filter((row) => row.type === 'table')) {
      const table = String(item.name).replaceAll('"', '""');
      for (const column of original
        .prepare(`PRAGMA table_info("${table}")`)
        .all())
        if (
          (column.name === 'ownerId' || column.name === 'owner_id') &&
          original
            .prepare(
              `SELECT 1 FROM "${table}" WHERE "${column.name}"<>? LIMIT 1`,
            )
            .get(ownerId)
        )
          throw new Error('Invalid SQLite owner');
    }
    if (engine === 'sqlite')
      await validateUnifiedGraph(original, ownerId, signal, version);
  } finally {
    original.close();
    // These sidecars belong to the private extracted snapshot, not the source workspace.
    for (const suffix of ['-wal', '-shm'])
      await rm(source + suffix, { force: true });
  }
  signal.throwIfAborted();
  await copyFile(source, destination, 1); // COPYFILE_EXCL; the directory is privately owned.
  await chmod(destination, 0o600);
}
export async function restoreSQLite(
  source: string,
  destination: string,
  ownerId: string,
  signal: AbortSignal,
  engine: 'legacy-postgres' | 'sqlite' = 'legacy-postgres',
  expectedSchema?: 2 | 3 | 4,
) {
  await copyValidatedSQLite(
    source,
    destination,
    ownerId,
    signal,
    engine,
    expectedSchema,
  );
  const db = new DatabaseSync(destination);
  const counts: Record<string, number> = {};
  try {
    if (engine === 'sqlite') initializeSQLiteSchema(db);
    db.exec(
      'PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE',
    );
    for (const table of [
      'dots',
      'spaces',
      'pages',
      'memories',
      'memory_items',
      'memory_revisions',
      'memory_suppressions',
      'tasks',
      'calls',
      ...(engine === 'sqlite'
        ? [
            'conversation_threads',
            'conversation_runs',
            'conversation_events',
            'memory_episode_chunks',
            'memory_jobs',
            'memory_evidence',
            'memory_checkpoints',
            'voice_delegations',
          ]
        : []),
    ])
      counts[table] = Number(
        db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n,
      );
    const audit = await open(
      join(dirname(dirname(destination)), 'recovery/access-audit.jsonl'),
      'wx',
      0o600,
    );
    try {
      // Keep original permission/operation records as inert recovery evidence.
      for (const table of [
        'settings',
        'tasks',
        'runs',
        'dots',
        'mcp_connections',
        'mcp_approvals',
        'mcp_actions',
        'computer_permissions',
        'folder_grants',
        'folder_requests',
        'memory_pending_operations',
        'memory_restore_previews',
        'memory_settings',
        'setup_telemetry',
        ...(engine === 'sqlite' ? ['memory_jobs', 'voice_delegations'] : []),
      ])
        for (const row of db.prepare(`SELECT * FROM "${table}"`).iterate()) {
          signal.throwIfAborted();
          await audit.writeFile(JSON.stringify({ table, row }) + '\n');
          db.prepare('INSERT INTO storage_recovery_audit VALUES (?,?,?,?)').run(
            randomUUID(),
            Date.now(),
            table,
            JSON.stringify(row),
          );
        }
      await audit.sync();
    } finally {
      await audit.close();
    }
    const settings = JSON.parse(
      String(db.prepare('SELECT value FROM settings WHERE id=1').get()!.value),
    );
    db.prepare('UPDATE settings SET value=? WHERE id=1').run(
      JSON.stringify({
        ...settings,
        paused: true,
        appsAllowed: false,
        researchAllowed: false,
      }),
    );
    db.exec(`UPDATE tasks SET status=CASE WHEN status IN ('queued','running') OR nextRunAt IS NOT NULL THEN 'paused' ELSE status END,lease=NULL,leaseUntil=NULL,nextRunAt=NULL;
      UPDATE runs SET status='interrupted',error='Interrupted by workspace recovery' WHERE status='running';
      UPDATE calls SET status='failed',error='Interrupted by workspace recovery' WHERE status NOT IN ('ended','failed');
      UPDATE dots SET researchAllowed=0,appsAllowed=0,learningContainerId=NULL,skillDeliveryEnabled=0,composioSessionId=NULL,composioPolicyHash=NULL;
      UPDATE thread_bindings SET learningContainerId=NULL;
      UPDATE page_threads SET leaseUntil=0;
      DELETE FROM mcp_connections; DELETE FROM mcp_approvals;
      DELETE FROM computer_permissions; DELETE FROM folder_grants; DELETE FROM folder_requests;
      DELETE FROM memory_pending_operations; DELETE FROM memory_restore_previews; DELETE FROM setup_telemetry;`);
    db.prepare(
      "UPDATE mcp_actions SET status='done',result=? WHERE status='running'",
    ).run(
      JSON.stringify({
        ok: false,
        error:
          'Interrupted by workspace recovery; approve a fresh action to retry.',
      }),
    );
    if (engine === 'sqlite')
      db.exec(`
      UPDATE conversation_threads SET lease_token=NULL,lease_until=0;
      UPDATE memory_evidence SET workflow_complete=0 WHERE EXISTS(SELECT 1 FROM conversation_runs r WHERE r.owner_id=memory_evidence.owner_id AND r.thread_id=memory_evidence.thread_id AND r.run_id=memory_evidence.run_id AND r.status='running');
      UPDATE conversation_runs SET status='interrupted' WHERE status='running';
      UPDATE memory_jobs SET state='cancelled',error='Interrupted by workspace recovery',lease_token=NULL,lease_until=NULL,call_started_at=NULL WHERE state IN ('queued','running');
      UPDATE voice_delegations SET status='interrupted',error='Interrupted by workspace recovery; approve a fresh task to retry.',lease_token=NULL,lease_until=NULL,lease_generation=lease_generation+1,receipt_message_id=NULL,delivered_at=NULL,updated_at=${Date.now()} WHERE status IN ('queued','running','approval');
    `);
    for (const row of db
      .prepare('SELECT ownerId,dotId,value FROM memory_settings')
      .all()) {
      const value = JSON.parse(String(row.value));
      db.prepare(
        'UPDATE memory_settings SET value=? WHERE ownerId=? AND dotId=?',
      ).run(
        JSON.stringify({
          ...value,
          learningEnabled: false,
          autoDream: false,
          autoCompact: false,
        }),
        row.ownerId,
        row.dotId,
      );
    }
    db.exec(
      'COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE',
    );
    return {
      counts,
      dotIds: db
        .prepare('SELECT id FROM dots')
        .all()
        .map((row) => String(row.id)),
      threads: [
        ...db
          .prepare('SELECT id,dotId FROM thread_bindings')
          .all()
          .map((row) => ({
            id: String(row.id),
            dotId: String(row.dotId),
            required: true,
          })),
        ...db
          .prepare('SELECT threadId,dotId FROM page_threads')
          .all()
          .map((row) => ({
            id: String(row.threadId),
            dotId: String(row.dotId),
            required: false,
          })),
      ],
    };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* Already committed. */
    }
    throw error;
  } finally {
    db.close();
  }
}
