import { invalidateAbilityTrust } from './ability-snapshot.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** Runs inside the worker's initialization transaction, before runtime admission. */
export function bindPortableWorkspace(db: DatabaseSync, machineId: string) {
  if (!machineId || machineId.length > 256)
    throw new Error('Invalid portable host binding');
  const bindingId = 'portable-workspace-host';
  const previous = db
    .prepare('SELECT value FROM storage_recovery_audit WHERE id=?')
    .get(bindingId);
  if (previous?.value === machineId) return;
  for (const table of [
    'settings',
    'tasks',
    'dots',
    'mcp_connections',
    'mcp_approvals',
    'computer_permissions',
    'folder_grants',
    'folder_requests',
    'project_execution_bindings',
    'memory_pending_operations',
    'memory_settings',
    'voice_delegations',
    'voice_input_receipts',
  ]) {
    const rows = db.prepare(`SELECT * FROM "${table}"`);
    rows.setReadBigInts(true);
    for (const row of rows.iterate())
      db.prepare('INSERT INTO storage_recovery_audit VALUES(?,?,?,?)').run(
        randomUUID(),
        Date.now(),
        table,
        JSON.stringify(row, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      );
  }
  invalidateAbilityTrust(db);
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
    UPDATE runs SET status='interrupted',error='Portable workspace host changed' WHERE status='running';
    UPDATE calls SET status='failed',error='Portable workspace host changed' WHERE status NOT IN ('ended','failed');
    UPDATE dots SET researchAllowed=0,appsAllowed=0,learningContainerId=NULL,skillDeliveryEnabled=0,composioSessionId=NULL,composioPolicyHash=NULL;
    UPDATE thread_bindings SET learningContainerId=NULL;
    UPDATE page_threads SET leaseUntil=0;
    DELETE FROM mcp_connections; DELETE FROM mcp_approvals; DELETE FROM computer_permissions;
    DELETE FROM folder_grants; DELETE FROM folder_requests; DELETE FROM project_execution_bindings; DELETE FROM memory_pending_operations;
    DELETE FROM memory_restore_previews; DELETE FROM setup_telemetry;
    UPDATE memory_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL,call_started_at=NULL,error='Portable workspace host changed' WHERE state IN ('queued','running');
    UPDATE voice_input_receipts SET status='interrupted',reply='Workspace recovered; request was not resumed.' WHERE deliveredAt IS NULL;
    UPDATE voice_delegations SET status='interrupted',lease_token=NULL,lease_until=NULL,lease_generation=lease_generation+1,receipt_message_id=NULL,delivered_at=NULL,updated_at=${Date.now()},error='Portable workspace host changed; approve a fresh task to retry.' WHERE status IN ('queued','running','approval');
    UPDATE conversation_threads SET lease_token=NULL,lease_until=0;
    UPDATE memory_evidence SET workflow_complete=0 WHERE EXISTS(SELECT 1 FROM conversation_runs r WHERE r.owner_id=memory_evidence.owner_id AND r.thread_id=memory_evidence.thread_id AND r.run_id=memory_evidence.run_id AND r.status='running');
    UPDATE conversation_runs SET status='interrupted' WHERE status='running';`);
  db.prepare(
    "UPDATE mcp_actions SET status='done',result=? WHERE status='running'",
  ).run(
    JSON.stringify({
      ok: false,
      error:
        'Portable workspace host changed; review effects before approving a new action.',
    }),
  );
  for (const row of db
    .prepare('SELECT ownerId,dotId,value FROM memory_settings')
    .all())
    db.prepare(
      'UPDATE memory_settings SET value=? WHERE ownerId=? AND dotId=?',
    ).run(
      JSON.stringify({
        ...JSON.parse(String(row.value)),
        learningEnabled: false,
        autoDream: false,
        autoCompact: false,
      }),
      row.ownerId,
      row.dotId,
    );
  db.prepare(
    'INSERT OR REPLACE INTO storage_recovery_audit VALUES(?,?,?,?)',
  ).run(bindingId, Date.now(), 'portable_host_binding', machineId);
}
