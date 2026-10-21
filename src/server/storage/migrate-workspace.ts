import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { MessageSchema, RunAgentInputSchema, type Message } from '@ag-ui/core';
import { evidenceHash } from '../conversation-memory.js';
import {
  POSTGRES_RECORDS,
  type PostgresRecordTable,
} from './postgres-records.js';
import { records } from './restore-postgres.js';
import { copyValidatedSQLite } from './restore-sqlite.js';
import { initializeSQLiteSchema } from './sqlite-schema.js';
import { validateUnifiedGraph } from './unified-validation.js';
import { atomicStorageWrite } from './restore-journal.js';

type Row = Record<string, unknown>;
type Verification = {
  expectedCount: number;
  actualCount: number;
  expectedHash: string;
  actualHash: string;
};
type Value = string | number | bigint | null;
const nativeTables: Record<PostgresRecordTable, string> = {
  local_ai_threads: 'conversation_threads',
  local_ai_runs: 'conversation_runs',
  memory_episode_chunks: 'memory_episode_chunks',
  memory_jobs: 'memory_jobs',
  memory_daily_admissions: 'memory_daily_admissions',
  memory_processed_sources: 'memory_processed_sources',
  memory_evidence: 'memory_evidence',
  memory_checkpoints: 'memory_checkpoints',
  memory_index_runs: 'memory_index_runs',
};
function json(value: unknown) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}
function timestamp(value: unknown) {
  const milliseconds =
    typeof value === 'bigint' || typeof value === 'number'
      ? Number(value)
      : Date.parse(String(value));
  if (!Number.isSafeInteger(milliseconds))
    throw new Error('Invalid migration timestamp');
  return milliseconds;
}
function normalize(
  table: PostgresRecordTable,
  input: Row,
  sqlite: boolean,
): Row {
  return Object.fromEntries(
    Object.entries(POSTGRES_RECORDS[table]).map(([column, type]) => {
      const value = input[column];
      if (value === undefined) throw new Error('Missing migration field');
      if (value === null) return [column, null];
      if (type === 'jsonb')
        return [column, typeof value === 'string' ? JSON.parse(value) : value];
      if (type === 'timestamp with time zone')
        return [column, new Date(timestamp(value)).toISOString()];
      if (type === 'integer' || type === 'bigint') {
        if (!/^-?\d+$/.test(String(value)))
          throw new Error('Invalid migration integer');
        const integer = BigInt(String(value));
        if (
          integer < -(2n ** 63n) ||
          integer > 2n ** 63n - 1n ||
          (type === 'integer' &&
            (integer < -(2n ** 31n) || integer > 2n ** 31n - 1n))
        )
          throw new Error('Migration integer exceeds its schema');
        return [column, String(integer)];
      }
      if (type === 'boolean') {
        const truth = sqlite
          ? value === 1n || value === 1
          : value === 't' || value === 'true';
        const falsehood = sqlite
          ? value === 0n || value === 0
          : value === 'f' || value === 'false';
        if (!truth && !falsehood) throw new Error('Invalid migration boolean');
        return [column, truth];
      }
      if (typeof value !== 'string') throw new Error('Invalid migration text');
      return [column, value];
    }),
  );
}
function sqlValue(type: string, value: unknown): Value {
  if (value === null) return null;
  if (type === 'jsonb') return json(value);
  if (type === 'timestamp with time zone') return timestamp(value);
  if (type === 'integer' || type === 'bigint') return BigInt(String(value));
  if (type === 'boolean') return value ? 1 : 0;
  return String(value);
}
function messages(value: unknown): Message[] {
  if (
    !Array.isArray(value) ||
    value.some((message) => !MessageSchema.safeParse(message).success)
  )
    throw new Error('Invalid migration messages');
  if (new Set(value.map((message) => message.id)).size !== value.length)
    throw new Error('Duplicate migration message ID');
  return value as Message[];
}
function saveMessages(
  db: DatabaseSync,
  ownerId: string,
  threadId: string,
  input: unknown,
  run?: { id: string; kind: 'input' | 'evidence' },
) {
  for (const [seq, message] of messages(input).entries()) {
    const hash = evidenceHash(message);
    db.prepare(
      'INSERT OR IGNORE INTO conversation_message_versions VALUES(?,?,?,?,?)',
    ).run(ownerId, threadId, message.id, hash, json(message));
    if (run)
      db.prepare(
        'INSERT INTO conversation_run_messages VALUES(?,?,?,?,?,?,?)',
      ).run(ownerId, threadId, run.id, run.kind, seq, message.id, hash);
    else
      db.prepare('INSERT INTO conversation_messages VALUES(?,?,?,?,?)').run(
        ownerId,
        threadId,
        message.id,
        seq,
        hash,
      );
  }
}
function insert(db: DatabaseSync, table: PostgresRecordTable, row: Row) {
  const owner = String(row.owner_id);
  if (table === 'local_ai_threads') {
    db.prepare(
      'INSERT INTO conversation_threads(owner_id,id,agent_id,name,state,last_run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(
      owner,
      String(row.id),
      String(row.agent_id),
      row.name as string | null,
      json(row.state),
      row.last_run_id as string | null,
      timestamp(row.created_at),
      timestamp(row.updated_at),
    );
    saveMessages(db, owner, String(row.id), row.messages);
  } else if (table === 'local_ai_runs') {
    const input = row.input as Row;
    if (
      !RunAgentInputSchema.safeParse(input).success ||
      input.threadId !== row.thread_id ||
      input.runId !== row.run_id ||
      !Array.isArray(row.events)
    )
      throw new Error('Invalid migration run scope');
    const { messages: inputMessages, ...metadata } = input;
    db.prepare(
      'INSERT INTO conversation_runs(owner_id,thread_id,run_id,input,status,created_at,lease_generation,next_event_seq,evidence_guard,prior_message_ids,provenance_complete) VALUES(?,?,?,?,?,?,0,?,?,?,?)',
    ).run(
      owner,
      String(row.thread_id),
      String(row.run_id),
      json(metadata),
      String(row.status),
      timestamp(row.created_at),
      row.events.length,
      row.evidence_guard === null ? null : json(row.evidence_guard),
      json(row.prior_message_ids),
      row.provenance_complete ? 1 : 0,
    );
    saveMessages(db, owner, String(row.thread_id), inputMessages, {
      id: String(row.run_id),
      kind: 'input',
    });
    saveMessages(db, owner, String(row.thread_id), row.evidence_messages, {
      id: String(row.run_id),
      kind: 'evidence',
    });
    for (const [seq, event] of row.events.entries()) {
      if (!event || typeof event !== 'object' || typeof event.type !== 'string')
        throw new Error('Invalid migration event');
      db.prepare('INSERT INTO conversation_events VALUES(?,?,?,?,?,?,?)').run(
        owner,
        String(row.thread_id),
        String(row.run_id),
        seq,
        event.type,
        +(event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR'),
        json(event),
      );
    }
  } else {
    const columns = Object.entries(POSTGRES_RECORDS[table]);
    db.prepare(
      `INSERT INTO "${nativeTables[table]}" (${columns.map(([name]) => `"${name}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    ).run(...columns.map(([name, type]) => sqlValue(type, row[name])));
  }
}
function readMessages(
  db: DatabaseSync,
  owner: SQLOutputValue,
  thread: SQLOutputValue,
  run?: { id: SQLOutputValue; kind: string },
) {
  const rows = run
    ? db
        .prepare(
          'SELECT v.value FROM conversation_run_messages m JOIN conversation_message_versions v USING(owner_id,thread_id,message_id,hash) WHERE m.owner_id=? AND m.thread_id=? AND m.run_id=? AND m.kind=? ORDER BY m.seq',
        )
        .all(owner, thread, run.id, run.kind)
    : db
        .prepare(
          'SELECT v.value FROM conversation_messages m JOIN conversation_message_versions v USING(owner_id,thread_id,message_id,hash) WHERE m.owner_id=? AND m.thread_id=? ORDER BY m.seq',
        )
        .all(owner, thread);
  return rows.map((row) => JSON.parse(String(row.value)));
}
function logical(
  db: DatabaseSync,
  table: PostgresRecordTable,
  row: Record<string, SQLOutputValue>,
): Row {
  if (table === 'local_ai_threads')
    return { ...row, messages: readMessages(db, row.owner_id, row.id) };
  if (table === 'local_ai_runs')
    return {
      ...row,
      input: {
        ...JSON.parse(String(row.input)),
        messages: readMessages(db, row.owner_id, row.thread_id, {
          id: row.run_id,
          kind: 'input',
        }),
      },
      evidence_messages: readMessages(db, row.owner_id, row.thread_id, {
        id: row.run_id,
        kind: 'evidence',
      }),
      events: db
        .prepare(
          'SELECT value FROM conversation_events WHERE owner_id=? AND thread_id=? AND run_id=? ORDER BY seq',
        )
        .all(row.owner_id, row.thread_id, row.run_id)
        .map((event) => JSON.parse(String(event.value))),
    };
  return row;
}
function coreHash(db: DatabaseSync, table: string, signal: AbortSignal) {
  const statement = db.prepare(
    `SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`,
  );
  statement.setReadBigInts(true);
  const hash = createHash('sha256');
  let count = 0;
  for (const row of statement.iterate()) {
    signal.throwIfAborted();
    hash.update(json(row) + '\n');
    count++;
  }
  return { hash: hash.digest('hex'), count };
}

/** Offline conversion of a verified, quiescent legacy capture. No PostgreSQL connection is opened. */
export async function migrateLegacySnapshot(options: {
  directory: string;
  destination: string;
  ownerId: string;
  signal: AbortSignal;
}) {
  const { directory, destination, ownerId, signal } = options;
  const sourcePath = join(directory, 'core/workspace.sqlite');
  await copyValidatedSQLite(sourcePath, destination, ownerId, signal);
  const original = new DatabaseSync(sourcePath, { readOnly: true });
  const db = new DatabaseSync(destination);
  const verification: Record<string, Verification> = {};
  const counts: Record<string, number> = {};
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    initializeSQLiteSchema(db);
    for (const item of original
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_fts%' ORDER BY name",
      )
      .all()) {
      const table = String(item.name);
      const before = coreHash(original, table, signal),
        after = coreHash(db, table, signal);
      if (before.count !== after.count || before.hash !== after.hash)
        throw new Error('Core migration content mismatch');
      verification['core:' + table] = {
        expectedCount: before.count,
        actualCount: after.count,
        expectedHash: before.hash,
        actualHash: after.hash,
      };
      counts[table] = after.count;
    }
    db.exec(
      'CREATE TEMP TABLE migration_hashes(side TEXT,record_type TEXT,hash TEXT); CREATE INDEX temp.migration_hash_order ON migration_hashes(side,record_type,hash); BEGIN',
    );
    let batch = 0;
    for (const table of Object.keys(
      POSTGRES_RECORDS,
    ) as PostgresRecordTable[]) {
      const definition = POSTGRES_RECORDS[table];
      let header = false;
      for await (const value of records(
        join(directory, `postgres/${table}.jsonl`),
        signal,
      )) {
        if (!header) {
          if (
            !isDeepStrictEqual(value, {
              version: 1,
              table,
              columns: definition,
            })
          )
            throw new Error('Unsupported migration record schema');
          header = true;
          continue;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Invalid migration record');
        const raw = value as Row;
        if (
          Object.keys(raw).length !== Object.keys(definition).length ||
          Object.keys(definition).some(
            (key) => raw[key] !== null && typeof raw[key] !== 'string',
          ) ||
          raw.owner_id !== ownerId
        )
          throw new Error('Invalid migration ownership or fields');
        const row = normalize(table, raw, false);
        insert(db, table, row);
        db.prepare('INSERT INTO migration_hashes VALUES(?,?,?)').run(
          'expected',
          table,
          evidenceHash(row),
        );
        if (++batch % 128 === 0) db.exec('COMMIT; BEGIN');
      }
      if (!header) throw new Error('Missing migration record header');
    }
    db.exec('COMMIT');
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Migration reference check failed');
    await validateUnifiedGraph(db, ownerId, signal);
    for (const table of Object.keys(
      POSTGRES_RECORDS,
    ) as PostgresRecordTable[]) {
      const statement = db.prepare(`SELECT * FROM "${nativeTables[table]}"`);
      statement.setReadBigInts(true);
      for (const row of statement.iterate()) {
        signal.throwIfAborted();
        db.prepare('INSERT INTO migration_hashes VALUES(?,?,?)').run(
          'actual',
          table,
          evidenceHash(normalize(table, logical(db, table, row), true)),
        );
      }
      const sums = ['expected', 'actual'].map((side) => {
        const hash = createHash('sha256');
        let count = 0;
        for (const row of db
          .prepare(
            'SELECT hash FROM migration_hashes WHERE side=? AND record_type=? ORDER BY hash',
          )
          .iterate(side, table)) {
          hash.update(String(row.hash) + '\n');
          count++;
        }
        return { hash: hash.digest('hex'), count };
      });
      const [before, after] = sums;
      if (before.count !== after.count || before.hash !== after.hash)
        throw new Error(`Migration content mismatch: ${table}`);
      verification[table] = {
        expectedCount: before.count,
        actualCount: after.count,
        expectedHash: before.hash,
        actualHash: after.hash,
      };
      counts[table] = after.count;
    }
    // Preserve definitions, approval evidence and credentials on the same machine.
    // Pause automation and fence interrupted operations without replaying effects.
    db.exec('BEGIN');
    for (const table of [
      'settings',
      'tasks',
      'runs',
      'calls',
      'mcp_actions',
      'conversation_runs',
      'memory_jobs',
      'voice_delegations',
    ]) {
      const statement = db.prepare(`SELECT * FROM "${table}"`);
      statement.setReadBigInts(true);
      for (const row of statement.iterate())
        db.prepare('INSERT INTO storage_recovery_audit VALUES(?,?,?,?)').run(
          randomUUID(),
          Date.now(),
          table,
          json(row),
        );
    }
    const settings = JSON.parse(
      String(db.prepare('SELECT value FROM settings WHERE id=1').get()!.value),
    );
    db.prepare('UPDATE settings SET value=? WHERE id=1').run(
      json({ ...settings, paused: true }),
    );
    db.exec(`UPDATE tasks SET status=CASE WHEN status IN ('queued','running') OR nextRunAt IS NOT NULL THEN 'paused' ELSE status END,lease=NULL,leaseUntil=NULL,nextRunAt=NULL;
      UPDATE runs SET status='interrupted',error='Interrupted by workspace migration' WHERE status='running';
      UPDATE calls SET status='failed',error='Interrupted by workspace migration' WHERE status NOT IN ('ended','failed');
      UPDATE page_threads SET leaseUntil=0;
      UPDATE conversation_threads SET lease_token=NULL,lease_until=0;
      UPDATE conversation_runs SET status='interrupted' WHERE status='running';
      UPDATE memory_jobs SET state=CASE WHEN state IN ('queued','running') THEN 'cancelled' ELSE state END,lease_token=NULL,lease_until=NULL,call_started_at=NULL;`);
    db.prepare(
      "UPDATE voice_delegations SET status='interrupted',lease_token=NULL,lease_until=NULL,lease_generation=lease_generation+1,receipt_message_id=NULL,delivered_at=NULL,updated_at=?,error='Interrupted by workspace migration' WHERE status IN ('queued','running','approval')",
    ).run(Date.now());
    db.prepare(
      "UPDATE mcp_actions SET status='done',result=? WHERE status='running'",
    ).run(
      json({
        ok: false,
        error:
          'Interrupted by workspace migration; review completed effects before retrying.',
      }),
    );
    db.exec(
      "INSERT INTO memory_episodes_fts(memory_episodes_fts) VALUES('rebuild')",
    );
    db.prepare(
      'INSERT INTO memory_index_meta VALUES(?,1) ON CONFLICT(owner_id) DO UPDATE SET revision=revision+1',
    ).run(ownerId);
    signal.throwIfAborted();
    db.exec(
      'COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE',
    );
    const result = {
      version: 1,
      normalization:
        'Logical JSON, exact integers and application UTC millisecond timestamps; hashes precede audited interruption/automation changes.',
      counts,
      verification,
    };
    await atomicStorageWrite(
      join(
        dirname(dirname(destination)),
        'recovery/migration-verification.json',
      ),
      json(result),
    );
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
    original.close();
    // Read-only inspection can create sidecars for a WAL snapshot. These paths
    // belong to the private extracted capture, never the live legacy source.
    for (const suffix of ['-wal', '-shm'])
      await rm(sourcePath + suffix, { force: true });
  }
}
