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
    CREATE INDEX IF NOT EXISTS memory_episodes_search ON memory_episode_chunks USING gin(search);
    CREATE INDEX IF NOT EXISTS memory_episodes_thread ON memory_episode_chunks(owner_id,thread_id,created_at,source_id);
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
