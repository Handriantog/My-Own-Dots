import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import type { ArchiveEntry } from '../../shared/storage-archive.js';

const kinds = {
  s: 'text',
  i: 'integer',
  b: 'bigint',
  j: 'jsonb',
  t: 'timestamp with time zone',
  z: 'boolean',
} as const;
function columns(definition: string) {
  return Object.fromEntries(
    definition.split(' ').map((field) => {
      const [name, kind] = field.split(':');
      return [name, kinds[kind as keyof typeof kinds]];
    }),
  );
}
// This is both the capture inventory and the restore allowlist. SQL identifiers
// come exclusively from these definitions; archived input is never SQL.
export const POSTGRES_RECORDS = {
  local_ai_threads: columns(
    'owner_id:s id:s agent_id:s name:s messages:j state:j last_run_id:s created_at:t updated_at:t',
  ),
  local_ai_runs: columns(
    'owner_id:s thread_id:s run_id:s input:j events:j status:s created_at:t evidence_guard:j prior_message_ids:j evidence_messages:j provenance_complete:z',
  ),
  memory_episode_chunks: columns(
    'owner_id:s source_id:s thread_id:s run_id:s message_id:s content_hash:s start_offset:i text:s role:s source:j created_at:t tool_name:s',
  ),
  memory_jobs: columns(
    'owner_id:s id:s kind:s dot_id:s thread_id:s source_ids:j origin:s logical_key:s state:s lease_token:s lease_until:b attempts:i model_calls:i elapsed_ms:b call_started_at:b due_at:b created_at:b error:s publication_policy:s call_limit:i time_limit:i retry_limit:i idle_ms:i admitted_day:s',
  ),
  memory_daily_admissions: columns('owner_id:s dot_id:s day_key:s count:i'),
  memory_processed_sources: columns('owner_id:s source_id:s job_id:s'),
  memory_evidence: columns(
    'owner_id:s id:s thread_id:s run_id:s dot_id:s workflow_complete:z processed_job_id:s completed_at:b',
  ),
  memory_checkpoints: columns(
    'owner_id:s thread_id:s id:s covered_count:i value:j created_at:t',
  ),
  memory_index_runs: columns('owner_id:s thread_id:s run_id:s version:i'),
} as const;
export type PostgresRecordTable = keyof typeof POSTGRES_RECORDS;
export const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const selectedThreads =
  'SELECT id FROM local_ai_threads WHERE owner_id=$1 AND agent_id=ANY($2::text[])';
const selectedSources = `SELECT source_id FROM memory_episode_chunks WHERE owner_id=$1 AND thread_id IN (${selectedThreads})`;
const selectedJobs =
  'SELECT id FROM memory_jobs WHERE owner_id=$1 AND dot_id=ANY($2::text[])';
function scope(table: PostgresRecordTable): string {
  if (table === 'local_ai_threads') return 'agent_id=ANY($2::text[])';
  if (table === 'memory_jobs' || table === 'memory_daily_admissions')
    return 'dot_id=ANY($2::text[])';
  if (table === 'memory_processed_sources')
    return `(source_id IN (${selectedSources}) OR job_id IN (${selectedJobs}))`;
  return `thread_id IN (${selectedThreads})`;
}

export async function validatePostgresGraph(
  client: PoolClient,
  ownerId: string,
  dotIds: string[],
): Promise<void> {
  const installed = await client.query(
    'SELECT version FROM memory_schema_version',
  );
  if (installed.rows.length !== 1 || installed.rows[0].version !== 1)
    throw new Error('Unsupported PostgreSQL memory schema');
  const cross = await client.query(
    `SELECT id FROM memory_jobs WHERE owner_id=$1 AND dot_id=ANY($2::text[]) AND thread_id IS NOT NULL AND thread_id NOT IN (${selectedThreads}) LIMIT 1`,
    [ownerId, dotIds],
  );
  if (cross.rowCount)
    throw new Error('Ambiguous cross-workspace memory job reference');
  // Compact jobs store conversation boundary hashes in source_ids. Only Dream
  // jobs refer to episode chunks; both kinds still require owned thread links.
  const sources = await client.query(
    `SELECT id FROM memory_jobs j WHERE owner_id=$1 AND dot_id=ANY($2::text[]) AND kind='dream'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(j.source_ids) source(id)
       WHERE source.id NOT IN (${selectedSources})) LIMIT 1`,
    [ownerId, dotIds],
  );
  if (sources.rowCount)
    throw new Error('Ambiguous cross-workspace memory source reference');
  const evidence = await client.query(
    `SELECT e.id FROM memory_evidence e JOIN local_ai_threads t ON t.owner_id=e.owner_id AND t.id=e.thread_id
     WHERE e.owner_id=$1 AND t.agent_id=ANY($2::text[]) AND
       (e.dot_id<>t.agent_id OR (e.processed_job_id IS NOT NULL AND e.processed_job_id NOT IN (${selectedJobs}))) LIMIT 1`,
    [ownerId, dotIds],
  );
  const processed = await client.query(
    `SELECT source_id FROM memory_processed_sources WHERE owner_id=$1 AND ${scope('memory_processed_sources')}
     AND (source_id NOT IN (${selectedSources}) OR job_id NOT IN (${selectedJobs})) LIMIT 1`,
    [ownerId, dotIds],
  );
  if (evidence.rowCount || processed.rowCount)
    throw new Error('Ambiguous cross-workspace memory evidence reference');
}
export async function capturePostgresRecords(
  client: PoolClient,
  directory: string,
  ownerId: string,
  dotIds: string[],
  signal: AbortSignal,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await validatePostgresGraph(client, ownerId, dotIds);
  for (const table of Object.keys(POSTGRES_RECORDS) as PostgresRecordTable[]) {
    signal.throwIfAborted();
    const definition = POSTGRES_RECORDS[table];
    const actual = await client.query<{
      column_name: string;
      data_type: string;
      is_generated: string;
    }>(
      "SELECT column_name,data_type,is_generated FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
      [table],
    );
    if (
      actual.rows.filter((column) => column.is_generated === 'NEVER').length !==
        Object.keys(definition).length ||
      Object.entries(definition).some(
        ([name, type]) =>
          !actual.rows.some(
            (column) =>
              column.column_name === name && column.data_type === type,
          ),
      )
    )
      throw new Error('Unsupported PostgreSQL record schema');
    const path = `postgres/${table}.jsonl`;
    const output = await open(join(directory, path), 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    const write = async (value: unknown) => {
      signal.throwIfAborted();
      const line = Buffer.from(JSON.stringify(value) + '\n');
      if (line.length > MAX_RECORD_BYTES)
        throw new Error('PostgreSQL record exceeds backup limit');
      await output.writeFile(line);
      hash.update(line);
      bytes += line.length;
    };
    try {
      await write({ version: 1, table, columns: definition });
      const projection = Object.keys(definition)
        .map((name) => `"${name}"::text AS "${name}"`)
        .join(',');
      await client.query(
        `DECLARE capture_rows NO SCROLL CURSOR FOR SELECT ${projection} FROM "${table}" WHERE owner_id=$1 AND ${scope(table)}`,
        [ownerId, dotIds],
      );
      try {
        for (;;) {
          signal.throwIfAborted();
          const rows = await client.query('FETCH FORWARD 1 FROM capture_rows');
          if (!rows.rowCount) break;
          await write(rows.rows[0]);
        }
      } finally {
        await client.query('CLOSE capture_rows');
      }
      await output.sync();
    } finally {
      await output.close();
    }
    entries.push({ path, bytes, sha256: hash.digest('hex') });
  }
  return entries;
}
