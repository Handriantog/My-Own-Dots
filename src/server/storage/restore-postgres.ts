import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { PostgresConversations } from '../local-conversations.js';
import {
  MAX_RECORD_BYTES,
  POSTGRES_RECORDS,
  validatePostgresGraph,
} from './postgres-records.js';

export function restoredDatabaseName(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid restore identity');
  return `dots_restore_${id.replaceAll('-', '')}`;
}
export function restoredDatabaseUrl(server: string, id: string) {
  const url = new URL(server);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('Choose a PostgreSQL server for restoration');
  url.pathname = '/' + restoredDatabaseName(id);
  return url.toString();
}
export function restorePool(url: string) {
  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  });
  pool.on('error', () => {});
  return pool;
}
export async function* records(
  path: string,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile())
      throw new Error('Invalid PostgreSQL records file');
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      pending = Buffer.concat([pending, chunk]);
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        if (newline > MAX_RECORD_BYTES)
          throw new Error('PostgreSQL record exceeds restore limit');
        yield JSON.parse(pending.subarray(0, newline).toString('utf8'));
        pending = pending.subarray(newline + 1);
      }
      if (pending.length > MAX_RECORD_BYTES)
        throw new Error('PostgreSQL record exceeds restore limit');
    }
    if (pending.length) throw new Error('Truncated PostgreSQL records file');
  } finally {
    await file.close();
  }
}

/** All SQL identifiers and types are compiled allowlists. Archived values are parameters. */
export async function restorePostgres(options: {
  server: string;
  operationId: string;
  directory: string;
  ownerId: string;
  dotIds: string[];
  threads: { id: string; dotId: string; required: boolean }[];
  signal: AbortSignal;
  onCreated?: (oid: string) => Promise<void>;
}): Promise<{ url: string; counts: Record<string, number>; seal: string }> {
  const { server, operationId, directory, ownerId, dotIds, signal } = options;
  const admin = restorePool(server);
  const url = restoredDatabaseUrl(server, operationId);
  const pool = restorePool(url);
  let created = false;
  try {
    signal.throwIfAborted();
    // No IF NOT EXISTS: an existing database is never a restoration target.
    await admin.query(
      `CREATE DATABASE "${restoredDatabaseName(operationId)}" TEMPLATE template0`,
    );
    created = true;
    await pool.query(
      'CREATE TABLE dots_restore_identity(operation_id text PRIMARY KEY)',
    );
    await pool.query('INSERT INTO dots_restore_identity VALUES($1)', [
      operationId,
    ]);
    const identity = await admin.query(
      'SELECT oid::text FROM pg_database WHERE datname=$1',
      [restoredDatabaseName(operationId)],
    );
    await options.onCreated?.(identity.rows[0].oid);
    const schema = new PostgresConversations(url, ownerId);
    try {
      await schema.initialize();
    } finally {
      await schema.close();
    }
    const client = await pool.connect();
    const counts: Record<string, number> = {};
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL timezone='UTC'");
      for (const [table, definition] of Object.entries(POSTGRES_RECORDS)) {
        const columns = Object.keys(definition);
        let header = false;
        let count = 0;
        for await (const value of records(
          join(directory, `postgres/${table}.jsonl`),
          signal,
        )) {
          if (!header) {
            if (
              JSON.stringify(value) !==
              JSON.stringify({ version: 1, table, columns: definition })
            )
              throw new Error('Unsupported PostgreSQL restore schema');
            header = true;
            continue;
          }
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Invalid PostgreSQL record');
          const row = value as Record<string, unknown>;
          if (
            Object.keys(row).length !== columns.length ||
            columns.some(
              (key) => row[key] !== null && typeof row[key] !== 'string',
            ) ||
            row.owner_id !== ownerId ||
            (row.agent_id !== undefined &&
              !dotIds.includes(String(row.agent_id))) ||
            (row.dot_id !== undefined && !dotIds.includes(String(row.dot_id)))
          )
            throw new Error('Invalid PostgreSQL ownership or record');
          await client.query(
            `INSERT INTO "${table}" (${columns.map((name) => `"${name}"`).join(',')}) VALUES (${Object.values(
              definition,
            )
              .map((type, i) => `$${i + 1}::${type}`)
              .join(',')})`,
            columns.map((key) => row[key]),
          );
          count++;
        }
        if (!header) throw new Error('Missing PostgreSQL record header');
        const actual = await client.query(
          `SELECT count(*)::text AS n FROM "${table}"`,
        );
        if (Number(actual.rows[0].n) !== count)
          throw new Error('Restored PostgreSQL record count mismatch');
        counts[table] = count;
      }
      await validatePostgresGraph(client, ownerId, dotIds);
      const bindings = new Map<string, string>();
      for (const thread of options.threads) {
        if (
          !dotIds.includes(thread.dotId) ||
          (bindings.has(thread.id) && bindings.get(thread.id) !== thread.dotId)
        )
          throw new Error('Invalid restored conversation binding');
        bindings.set(thread.id, thread.dotId);
      }
      const restored = await client.query<{ id: string; agent_id: string }>(
        'SELECT id,agent_id FROM local_ai_threads',
      );
      const actual = new Map(
        restored.rows.map((row) => [row.id, row.agent_id]),
      );
      if (
        restored.rows.some((row) => bindings.get(row.id) !== row.agent_id) ||
        options.threads.some(
          (row) => row.required && actual.get(row.id) !== row.dotId,
        )
      )
        throw new Error('Invalid restored conversation binding');
      await client.query(
        "UPDATE local_ai_runs SET status='interrupted' WHERE status='running'",
      );
      await client.query(
        "UPDATE memory_jobs SET state=CASE WHEN state IN ('queued','running') THEN 'cancelled' ELSE state END, lease_token=NULL,lease_until=NULL,call_started_at=NULL",
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    const seal = await postgresSeal(pool, operationId, signal);
    return { url, counts, seal };
  } catch (error) {
    await pool.end();
    if (created)
      await admin
        .query(`DROP DATABASE "${restoredDatabaseName(operationId)}"`)
        .catch(() => {});
    throw error;
  } finally {
    if (!pool.ended) await pool.end();
    await admin.end();
  }
}
async function hashTable(
  client: PoolClient,
  table: string,
  columns: string[],
  hash: ReturnType<typeof createHash>,
  signal: AbortSignal,
) {
  const projection = columns
    .map((name) => `"${name}"::text AS "${name}"`)
    .join(',');
  await client.query(
    `DECLARE restore_rows NO SCROLL CURSOR FOR SELECT ${projection} FROM "${table}" ORDER BY ${columns.map((_, i) => i + 1).join(',')}`,
  );
  try {
    for (;;) {
      signal.throwIfAborted();
      const rows = await client.query('FETCH FORWARD 100 FROM restore_rows');
      if (!rows.rowCount) break;
      for (const row of rows.rows) hash.update(JSON.stringify(row) + '\n');
    }
  } finally {
    await client.query('CLOSE restore_rows');
  }
}
export async function postgresSeal(
  pool: Pool,
  operationId: string,
  signal: AbortSignal,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL timezone='UTC'");
    await assertRestoredRelations(client);
    const identity = await client.query(
      'SELECT operation_id FROM dots_restore_identity',
    );
    if (
      identity.rows.length !== 1 ||
      identity.rows[0].operation_id !== operationId
    )
      throw new Error('Restored database ownership changed');
    const hash = createHash('sha256');
    for (const [table, definition] of Object.entries(POSTGRES_RECORDS)) {
      hash.update(table + '\n');
      await hashTable(client, table, Object.keys(definition), hash, signal);
    }
    await client.query('COMMIT');
    return hash.digest('hex');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export async function assertRestoredRelations(database: Pool | PoolClient) {
  const allowed = new Set([
    ...Object.keys(POSTGRES_RECORDS),
    'dots_restore_identity',
    'memory_index_meta',
    'memory_schema_version',
  ]);
  const result = await database.query<{ schema: string; name: string }>(
    "SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','m','v','f','S') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'",
  );
  if (
    result.rows.some((row) => row.schema !== 'public' || !allowed.has(row.name))
  )
    throw new Error('Restored database contains unexpected relations');
}
