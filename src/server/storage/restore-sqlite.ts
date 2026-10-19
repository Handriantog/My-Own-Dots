import { copyFile, open, rm, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../store.js';
import { WorkspaceStore } from '../workspace.js';

const inventory = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();

/** Reject unknown schemas before executing any statement that could invoke archived triggers. */
export async function restoreSQLite(
  source: string,
  destination: string,
  ownerId: string,
  signal: AbortSignal,
) {
  const baselinePath = destination + '.schema';
  const store = new Store(baselinePath);
  store.close();
  const workspace = new WorkspaceStore(baselinePath, ownerId);
  workspace.close();
  const baseline = new DatabaseSync(baselinePath, { readOnly: true });
  const expected = inventory(baseline);
  baseline.close();
  await rm(baselinePath);
  const original = new DatabaseSync(source, { readOnly: true });
  try {
    original.exec('PRAGMA trusted_schema=OFF');
    if (JSON.stringify(inventory(original)) !== JSON.stringify(expected))
      throw new Error('Unsupported SQLite restore schema');
    const check = original.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || check[0].integrity_check !== 'ok')
      throw new Error('SQLite integrity check failed');
    if (original.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('SQLite reference check failed');
    for (const item of expected.filter((row) => row.type === 'table')) {
      const table = String(item.name).replaceAll('"', '""');
      if (
        original
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .some((row) => row.name === 'ownerId') &&
        original
          .prepare(`SELECT 1 FROM "${table}" WHERE ownerId<>? LIMIT 1`)
          .get(ownerId)
      )
        throw new Error('Invalid SQLite owner');
    }
  } finally {
    original.close();
  }
  signal.throwIfAborted();
  await copyFile(source, destination, 1); // COPYFILE_EXCL; the directory is privately owned.
  await chmod(destination, 0o600);
  const db = new DatabaseSync(destination);
  const counts: Record<string, number> = {};
  try {
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
