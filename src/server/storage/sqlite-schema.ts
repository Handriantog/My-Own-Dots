import type { DatabaseSync } from 'node:sqlite';
import { beginSQLiteTransaction } from './sqlite-transaction.js';
export const sqliteStorageSchema = 1;
export function initializeSQLiteSchema(db: DatabaseSync) {
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
    if (version > sqliteStorageSchema)
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
    transaction.commit();
  } catch (error) {
    transaction.rollback();
    throw error;
  }
}
