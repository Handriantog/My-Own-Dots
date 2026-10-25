import type { DatabaseSync } from 'node:sqlite';
import { beginSQLiteTransaction } from './sqlite-transaction.js';
import {
  initializeAbilitySchema,
  initializeAbilityManagementSchema,
} from '../abilities/store.js';
import { sqliteStorageSchema } from '../../shared/workspace-manifest.js';
export { sqliteStorageSchema } from '../../shared/workspace-manifest.js';
export function initializeSQLiteSchema(
  db: DatabaseSync,
  targetVersion: 2 | 3 | 4 | 5 | 6 | 7 = sqliteStorageSchema,
) {
  const transaction = beginSQLiteTransaction(db);
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS workspace_storage_schema(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)',
    );
    const version = Number(
      db
        .prepare(
          'SELECT coalesce(max(version),0) AS version FROM workspace_storage_schema',
        )
        .get()!.version,
    );
    if (version > targetVersion)
      throw new Error('Unsupported workspace storage schema');
    if (version < 1) {
      db.exec(`
        CREATE TABLE conversation_threads(
          owner_id TEXT NOT NULL,id TEXT NOT NULL,agent_id TEXT NOT NULL,name TEXT,
          state TEXT NOT NULL DEFAULT '{}',last_run_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
          lease_generation INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(owner_id,id));
        CREATE INDEX conversation_threads_list ON conversation_threads(owner_id,agent_id,updated_at DESC,id);
        CREATE TABLE conversation_runs(
          owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,input TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','finished','failed','stopped','interrupted')),
          created_at INTEGER NOT NULL,lease_generation INTEGER NOT NULL,next_event_seq INTEGER NOT NULL DEFAULT 0,
          evidence_guard TEXT,prior_message_ids TEXT NOT NULL,provenance_complete INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(owner_id,thread_id,run_id),FOREIGN KEY(owner_id,thread_id) REFERENCES conversation_threads(owner_id,id));
        CREATE INDEX conversation_runs_thread ON conversation_runs(owner_id,thread_id,created_at,run_id);
        CREATE INDEX conversation_runs_active ON conversation_runs(owner_id,status,thread_id);
        CREATE TABLE conversation_message_versions(
          owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,message_id TEXT NOT NULL,hash TEXT NOT NULL,value TEXT NOT NULL,
          PRIMARY KEY(owner_id,thread_id,message_id,hash),FOREIGN KEY(owner_id,thread_id) REFERENCES conversation_threads(owner_id,id));
        CREATE TABLE conversation_messages(
          owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,message_id TEXT NOT NULL,seq INTEGER NOT NULL,hash TEXT NOT NULL,
          PRIMARY KEY(owner_id,thread_id,message_id),UNIQUE(owner_id,thread_id,seq),
          FOREIGN KEY(owner_id,thread_id,message_id,hash) REFERENCES conversation_message_versions(owner_id,thread_id,message_id,hash));
        CREATE TABLE conversation_run_messages(
          owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('input','evidence')),
          seq INTEGER NOT NULL,message_id TEXT NOT NULL,hash TEXT NOT NULL,
          PRIMARY KEY(owner_id,thread_id,run_id,kind,seq),UNIQUE(owner_id,thread_id,run_id,kind,message_id),
          FOREIGN KEY(owner_id,thread_id,run_id) REFERENCES conversation_runs(owner_id,thread_id,run_id),
          FOREIGN KEY(owner_id,thread_id,message_id,hash) REFERENCES conversation_message_versions(owner_id,thread_id,message_id,hash));
        CREATE TABLE conversation_events(
          owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,seq INTEGER NOT NULL,
          type TEXT NOT NULL,terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),value TEXT NOT NULL,
          PRIMARY KEY(owner_id,thread_id,run_id,seq),FOREIGN KEY(owner_id,thread_id,run_id) REFERENCES conversation_runs(owner_id,thread_id,run_id));
        CREATE UNIQUE INDEX conversation_one_terminal ON conversation_events(owner_id,thread_id,run_id) WHERE terminal=1;
        CREATE TABLE memory_evidence(
          owner_id TEXT NOT NULL,id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,dot_id TEXT NOT NULL,
          workflow_complete INTEGER NOT NULL,completed_at INTEGER NOT NULL,
          PRIMARY KEY(owner_id,id),UNIQUE(owner_id,thread_id,run_id),
          FOREIGN KEY(owner_id,thread_id,run_id) REFERENCES conversation_runs(owner_id,thread_id,run_id));
      `);
      db.prepare('INSERT INTO workspace_storage_schema VALUES(1,?)').run(
        Date.now(),
      );
    }
    if (version < 2) {
      db.exec(`
        ALTER TABLE memory_evidence ADD COLUMN processed_job_id TEXT;
        CREATE INDEX memory_evidence_pending ON memory_evidence(owner_id,dot_id,completed_at) WHERE processed_job_id IS NULL;
        CREATE TABLE memory_episode_chunks(
          owner_id TEXT NOT NULL,source_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,message_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,start_offset INTEGER NOT NULL,text TEXT NOT NULL,role TEXT NOT NULL,source TEXT NOT NULL,
          created_at INTEGER NOT NULL,tool_name TEXT,PRIMARY KEY(owner_id,source_id),
          FOREIGN KEY(owner_id,thread_id,run_id) REFERENCES conversation_runs(owner_id,thread_id,run_id));
        CREATE INDEX memory_episodes_thread ON memory_episode_chunks(owner_id,thread_id,created_at,source_id);
        CREATE VIRTUAL TABLE memory_episodes_fts USING fts5(text,content='memory_episode_chunks',content_rowid='rowid');
        CREATE TRIGGER memory_episodes_insert AFTER INSERT ON memory_episode_chunks BEGIN INSERT INTO memory_episodes_fts(rowid,text) VALUES(new.rowid,new.text); END;
        CREATE TRIGGER memory_episodes_delete AFTER DELETE ON memory_episode_chunks BEGIN INSERT INTO memory_episodes_fts(memory_episodes_fts,rowid,text) VALUES('delete',old.rowid,old.text); END;
        CREATE TRIGGER memory_episodes_update AFTER UPDATE ON memory_episode_chunks BEGIN INSERT INTO memory_episodes_fts(memory_episodes_fts,rowid,text) VALUES('delete',old.rowid,old.text); INSERT INTO memory_episodes_fts(rowid,text) VALUES(new.rowid,new.text); END;
        CREATE TABLE memory_checkpoints(owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,id TEXT NOT NULL,covered_count INTEGER NOT NULL,value TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner_id,id),FOREIGN KEY(owner_id,thread_id) REFERENCES conversation_threads(owner_id,id));
        CREATE INDEX memory_checkpoints_latest ON memory_checkpoints(owner_id,thread_id,covered_count DESC,created_at DESC);
        CREATE TABLE memory_index_meta(owner_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE memory_index_runs(owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(owner_id,thread_id,run_id),FOREIGN KEY(owner_id,thread_id,run_id) REFERENCES conversation_runs(owner_id,thread_id,run_id));
        CREATE TABLE memory_index_progress(owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,run_id TEXT NOT NULL,message_seq INTEGER NOT NULL,offset INTEGER NOT NULL,PRIMARY KEY(owner_id,thread_id,run_id),FOREIGN KEY(owner_id,thread_id,run_id) REFERENCES conversation_runs(owner_id,thread_id,run_id));
        CREATE TABLE memory_jobs(
          owner_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,dot_id TEXT NOT NULL,thread_id TEXT,source_ids TEXT NOT NULL,
          origin TEXT NOT NULL,logical_key TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',lease_token TEXT,lease_until INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0,model_calls INTEGER NOT NULL DEFAULT 0,elapsed_ms INTEGER NOT NULL DEFAULT 0,call_started_at INTEGER,
          due_at INTEGER NOT NULL,created_at INTEGER NOT NULL,error TEXT,publication_policy TEXT NOT NULL DEFAULT 'hybrid',
          call_limit INTEGER NOT NULL DEFAULT 3,time_limit INTEGER NOT NULL DEFAULT 300000,retry_limit INTEGER NOT NULL DEFAULT 2,idle_ms INTEGER NOT NULL DEFAULT 0,admitted_day TEXT,PRIMARY KEY(owner_id,id));
        CREATE TABLE memory_daily_admissions(owner_id TEXT NOT NULL,dot_id TEXT NOT NULL,day_key TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(owner_id,dot_id,day_key));
        CREATE TABLE memory_processed_sources(owner_id TEXT NOT NULL,source_id TEXT NOT NULL,job_id TEXT NOT NULL,PRIMARY KEY(owner_id,source_id));
        CREATE UNIQUE INDEX memory_jobs_logical ON memory_jobs(owner_id,logical_key) WHERE state IN ('queued','running');
        CREATE UNIQUE INDEX memory_jobs_active ON memory_jobs(owner_id,dot_id,kind) WHERE state='running';
        CREATE INDEX memory_jobs_due ON memory_jobs(owner_id,state,due_at);
      `);
      db.prepare('INSERT INTO workspace_storage_schema VALUES(2,?)').run(
        Date.now(),
      );
    }
    if (version < 3 && targetVersion >= 3) {
      db.exec(`CREATE TABLE voice_delegations(
        owner_id TEXT NOT NULL,id TEXT NOT NULL,dot_id TEXT NOT NULL REFERENCES dots(id),call_id TEXT NOT NULL REFERENCES calls(id),
        parent_thread_id TEXT NOT NULL,worker_thread_id TEXT NOT NULL,utterance_id TEXT NOT NULL,source_message_id TEXT NOT NULL,source_text TEXT NOT NULL,request TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','approval','completed','failed','cancelled','interrupted')),
        run_id TEXT,lease_generation INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,
        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,result TEXT,error TEXT,receipt_message_id TEXT,delivered_at INTEGER,
        PRIMARY KEY(owner_id,id),UNIQUE(owner_id,call_id,utterance_id),UNIQUE(owner_id,worker_thread_id),
        FOREIGN KEY(owner_id,parent_thread_id) REFERENCES conversation_threads(owner_id,id),
        FOREIGN KEY(owner_id,worker_thread_id) REFERENCES conversation_threads(owner_id,id),
        FOREIGN KEY(owner_id,parent_thread_id,source_message_id) REFERENCES conversation_messages(owner_id,thread_id,message_id),
        FOREIGN KEY(owner_id,parent_thread_id,receipt_message_id) REFERENCES conversation_messages(owner_id,thread_id,message_id),
        CHECK(parent_thread_id<>worker_thread_id),CHECK(lease_generation>=0),
        CHECK((status='running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND run_id IS NOT NULL) OR (status<>'running' AND lease_token IS NULL AND lease_until IS NULL)),
        CHECK((receipt_message_id IS NULL AND delivered_at IS NULL) OR (receipt_message_id IS NOT NULL AND delivered_at IS NOT NULL AND status NOT IN ('queued','running'))));
        CREATE UNIQUE INDEX voice_delegations_active_dot ON voice_delegations(owner_id,dot_id) WHERE status IN ('queued','running','approval');
        CREATE INDEX voice_delegations_parent ON voice_delegations(owner_id,parent_thread_id,created_at);`);
      db.prepare('INSERT INTO workspace_storage_schema VALUES(3,?)').run(
        Date.now(),
      );
    }
    if (version < 4 && targetVersion >= 4) {
      initializeAbilitySchema(db);
      db.prepare('INSERT INTO workspace_storage_schema VALUES(4,?)').run(
        Date.now(),
      );
    }
    if (version < 5 && targetVersion >= 5) {
      initializeAbilityManagementSchema(db);
      db.prepare('INSERT INTO workspace_storage_schema VALUES(5,?)').run(
        Date.now(),
      );
    }
    if (version < 6 && targetVersion >= 6) {
      db.exec(`DROP INDEX voice_delegations_active_dot;
        CREATE UNIQUE INDEX voice_delegations_active_dot ON voice_delegations(owner_id,dot_id) WHERE status IN ('running','approval');
        CREATE TABLE voice_input_receipts(ownerId TEXT NOT NULL,id TEXT NOT NULL,dotId TEXT NOT NULL,callId TEXT NOT NULL,parentThreadId TEXT NOT NULL,caption TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('request','status','stop')),reply TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('received','interrupted')),createdAt INTEGER NOT NULL,deliveredAt INTEGER,PRIMARY KEY(ownerId,id),FOREIGN KEY(ownerId,parentThreadId) REFERENCES conversation_threads(owner_id,id),FOREIGN KEY(callId) REFERENCES calls(id));`);
      db.prepare('INSERT INTO workspace_storage_schema VALUES(6,?)').run(
        Date.now(),
      );
    }
    if (version < 7 && targetVersion >= 7) {
      db.exec(`DROP INDEX voice_delegations_active_dot;
        CREATE UNIQUE INDEX voice_delegations_active_dot ON voice_delegations(owner_id,dot_id) WHERE status='running';`);
      db.prepare('INSERT INTO workspace_storage_schema VALUES(7,?)').run(
        Date.now(),
      );
    }
    transaction.commit();
  } catch (error) {
    transaction.rollback();
    throw error;
  }
}
