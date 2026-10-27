import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { initializeSQLiteSchema } from '../src/server/storage/sqlite-schema.js';
import { copyValidatedSQLite } from '../src/server/storage/restore-sqlite.js';
it.each(['legacy-postgres', 2, 8] as const)(
  'rejects corrupt call metadata in accepted inventory %s',
  async (version) => {
    const root = await mkdtemp(join(tmpdir(), 'call-history-validation-'));
    const source = join(root, 'source.sqlite');
    try {
      const store = new Store(source);
      store.close();
      const workspace = new WorkspaceStore(source, 'owner');
      const dot = workspace.dots()[0];
      workspace.bindThread('thread', dot.id, 'Chat');
      const first = workspace.createCall('thread');
      const second = workspace.createCall('thread');
      workspace.close();
      const db = new DatabaseSync(source);
      db.exec('PRAGMA journal_mode=DELETE');
      if (typeof version === 'number') {
        initializeSQLiteSchema(db, version);
        db.prepare(
          'INSERT INTO conversation_threads(owner_id,id,agent_id,created_at,updated_at) VALUES(?,?,?,?,?)',
        ).run('owner', 'thread', dot.id, 1, 1);
      }
      const engine = typeof version === 'number' ? 'sqlite' : 'legacy-postgres';
      const signal = new AbortController().signal;
      await copyValidatedSQLite(
        source,
        join(root, 'valid.sqlite'),
        'owner',
        signal,
        engine,
        typeof version === 'number' ? version : undefined,
      );
      for (const invalid of ['not-json', '{}', '[""]', '["same","same"]']) {
        db.prepare('UPDATE call_history SET messageIds=? WHERE callId=?').run(
          invalid,
          first.id,
        );
        await expect(
          copyValidatedSQLite(
            source,
            join(root, 'bad.sqlite'),
            'owner',
            signal,
            engine,
            typeof version === 'number' ? version : undefined,
          ),
        ).rejects.toThrow(/call history|JSON/);
      }
      db.prepare('UPDATE call_history SET messageIds=?').run('["duplicate"]');
      await expect(
        copyValidatedSQLite(
          source,
          join(root, 'bad.sqlite'),
          'owner',
          signal,
          engine,
          typeof version === 'number' ? version : undefined,
        ),
      ).rejects.toThrow(/call history|JSON/);
      db.prepare('UPDATE call_history SET messageIds=?').run('[]');
      db.prepare('UPDATE calls SET threadId=? WHERE id=?').run(
        'missing',
        second.id,
      );
      await expect(
        copyValidatedSQLite(
          source,
          join(root, 'bad.sqlite'),
          'owner',
          signal,
          engine,
          typeof version === 'number' ? version : undefined,
        ),
      ).rejects.toThrow(/call history|JSON/);
      db.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
