import type { Pool } from 'pg';
export type MemoryDatabase = Pick<Pool, 'query'>;
export async function initializeConversationMemorySchema(pg: MemoryDatabase) {
  await pg.query(`
    ALTER TABLE local_ai_runs ADD COLUMN IF NOT EXISTS evidence_guard jsonb;
    ALTER TABLE local_ai_runs ADD COLUMN IF NOT EXISTS prior_message_ids jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE local_ai_runs ADD COLUMN IF NOT EXISTS evidence_messages jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE local_ai_runs ADD COLUMN IF NOT EXISTS provenance_complete boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS memory_episode_chunks (
      owner_id text NOT NULL, source_id text NOT NULL, thread_id text NOT NULL, run_id text NOT NULL,
      message_id text NOT NULL, content_hash text NOT NULL, start_offset integer NOT NULL,
      text text NOT NULL, role text NOT NULL, source jsonb NOT NULL, created_at timestamptz NOT NULL,
      search tsvector GENERATED ALWAYS AS (to_tsvector('simple',text)) STORED,
      PRIMARY KEY(owner_id,source_id),
      FOREIGN KEY(owner_id,thread_id,run_id) REFERENCES local_ai_runs(owner_id,thread_id,run_id) ON DELETE CASCADE
    );
    ALTER TABLE memory_episode_chunks ADD COLUMN IF NOT EXISTS tool_name text;
    CREATE INDEX IF NOT EXISTS memory_episodes_search ON memory_episode_chunks USING gin(search);
    CREATE INDEX IF NOT EXISTS memory_episodes_thread ON memory_episode_chunks(owner_id,thread_id,created_at,source_id);
    CREATE TABLE IF NOT EXISTS memory_jobs (
      owner_id text NOT NULL,id text NOT NULL,kind text NOT NULL,dot_id text NOT NULL,thread_id text,source_ids jsonb NOT NULL,
      origin text NOT NULL,logical_key text NOT NULL,state text NOT NULL DEFAULT 'queued',lease_token text,lease_until bigint,
      attempts integer NOT NULL DEFAULT 0,model_calls integer NOT NULL DEFAULT 0,elapsed_ms bigint NOT NULL DEFAULT 0,call_started_at bigint,
      due_at bigint NOT NULL,created_at bigint NOT NULL,error text,PRIMARY KEY(owner_id,id)
    );
    ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS publication_policy text NOT NULL DEFAULT 'hybrid';
    ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS call_limit integer NOT NULL DEFAULT 3;
    ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS time_limit integer NOT NULL DEFAULT 300000;
    ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS retry_limit integer NOT NULL DEFAULT 2;
    ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS idle_ms integer NOT NULL DEFAULT 0;
    ALTER TABLE memory_jobs ADD COLUMN IF NOT EXISTS admitted_day text;
    CREATE TABLE IF NOT EXISTS memory_daily_admissions(owner_id text NOT NULL,dot_id text NOT NULL,day_key text NOT NULL,count integer NOT NULL,PRIMARY KEY(owner_id,dot_id,day_key));
    CREATE TABLE IF NOT EXISTS memory_processed_sources(owner_id text NOT NULL,source_id text NOT NULL,job_id text NOT NULL,PRIMARY KEY(owner_id,source_id));
    CREATE UNIQUE INDEX IF NOT EXISTS memory_jobs_logical ON memory_jobs(owner_id,logical_key) WHERE state IN ('queued','running');
    CREATE UNIQUE INDEX IF NOT EXISTS memory_jobs_active ON memory_jobs(owner_id,dot_id,kind) WHERE state='running';
    CREATE INDEX IF NOT EXISTS memory_jobs_due ON memory_jobs(owner_id,state,due_at);
    CREATE TABLE IF NOT EXISTS memory_evidence (
      owner_id text NOT NULL,id text NOT NULL,thread_id text NOT NULL,run_id text NOT NULL,dot_id text NOT NULL,
      workflow_complete boolean NOT NULL,processed_job_id text,completed_at bigint NOT NULL,
      PRIMARY KEY(owner_id,id),UNIQUE(owner_id,thread_id,run_id),
      FOREIGN KEY(owner_id,thread_id,run_id) REFERENCES local_ai_runs(owner_id,thread_id,run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS memory_evidence_pending ON memory_evidence(owner_id,dot_id,completed_at) WHERE processed_job_id IS NULL;
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      owner_id text NOT NULL,thread_id text NOT NULL,id text NOT NULL,covered_count integer NOT NULL,value jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(owner_id,id),FOREIGN KEY(owner_id,thread_id) REFERENCES local_ai_threads(owner_id,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS memory_checkpoints_latest ON memory_checkpoints(owner_id,thread_id,covered_count DESC,created_at DESC);
    CREATE TABLE IF NOT EXISTS memory_index_meta (owner_id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS memory_index_runs (
      owner_id text NOT NULL, thread_id text NOT NULL, run_id text NOT NULL, version integer NOT NULL,
      PRIMARY KEY(owner_id,thread_id,run_id),
      FOREIGN KEY(owner_id,thread_id,run_id) REFERENCES local_ai_runs(owner_id,thread_id,run_id) ON DELETE CASCADE
    );
  `);
}
