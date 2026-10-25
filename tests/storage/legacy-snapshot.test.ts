import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacySnapshotSource } from '../../src/server/storage/legacy-snapshot.js';
import { storageWorkspace } from '../fixtures/storage-workspace.js';
import { MemoryJobs } from '../../src/server/memory-jobs.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});
async function fixture() {
  const f = await storageWorkspace();
  cleanups.push(f.dispose);
  return f;
}
describe.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'legacy workspace capture',
  () => {
    it('yields to foreground work while a PostgreSQL snapshot read is blocked', async () => {
      const f = await fixture();
      const locker = await f.pg.connect();
      const pid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE memory_jobs IN ACCESS EXCLUSIVE MODE');
      const source = new LegacySnapshotSource({
        ...f,
        conversationBackend: 'local',
        owned: true,
      });
      const capture = source
        .capture(f.directory, new AbortController().signal, 'automatic')
        .then(
          () => 'completed',
          () => 'cancelled',
        );
      let foreground: Promise<() => void> | undefined;
      let admitted = false;
      try {
        await vi.waitFor(async () => {
          const blocked = await f.pg.query(
            'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
            [pid],
          );
          expect(blocked.rowCount).toBeGreaterThan(0);
        });
        foreground = f.gate
          .enterWrite(new AbortController().signal)
          .then((release) => {
            admitted = true;
            return release;
          });
        await vi.waitFor(() => expect(admitted).toBe(true), { timeout: 1000 });
        expect(await capture).toBe('cancelled');
        await expect(stat(f.directory)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await locker.query('ROLLBACK');
        locker.release();
        await capture;
        (await foreground)?.();
      }
    });
    it('rejects cross-workspace memory source references', async () => {
      const f = await fixture();
      await f.pg.query(
        'UPDATE memory_jobs SET source_ids=$3 WHERE owner_id=$1 AND id=$2',
        [f.ownerId, f.job.id, JSON.stringify(['unowned-source'])],
      );
      const source = new LegacySnapshotSource({
        ...f,
        conversationBackend: 'local',
        owned: true,
      });
      await expect(
        source.capture(f.directory, new AbortController().signal),
      ).rejects.toThrow(/reference/i);
      await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('still rejects compaction jobs pointing outside the workspace', async () => {
      const f = await fixture();
      await new MemoryJobs(f.pg, f.ownerId).enqueue({
        kind: 'compact',
        dotId: f.dot.id,
        threadId: 'unowned-thread',
        sourceIds: ['a'.repeat(64)],
        origin: 'manual',
        logicalKey: 'compact:unowned-thread',
      });
      const source = new LegacySnapshotSource({
        ...f,
        conversationBackend: 'local',
        owned: true,
      });
      await expect(
        source.capture(f.directory, new AbortController().signal),
      ).rejects.toThrow(/memory job reference/i);
      await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it.each(['evidence', 'processed source'])(
      'rejects cross-workspace %s references',
      async (kind) => {
        const f = await fixture();
        if (kind === 'evidence')
          await f.pg.query(
            'UPDATE memory_evidence SET dot_id=$2 WHERE owner_id=$1',
            [f.ownerId, 'another-workspace'],
          );
        else
          await f.pg.query(
            'INSERT INTO memory_processed_sources SELECT owner_id,source_id,$2 FROM memory_episode_chunks WHERE owner_id=$1',
            [f.ownerId, 'another-workspace-job'],
          );
        const source = new LegacySnapshotSource({
          ...f,
          conversationBackend: 'local',
          owned: true,
        });
        await expect(
          source.capture(f.directory, new AbortController().signal),
        ).rejects.toThrow(/reference/i);
        await expect(stat(f.directory)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      },
    );
    it('rejects ambiguous shared Dot threads', async () => {
      const f = await fixture();
      const unknown = 'unbound-thread';
      await f.conversations.createThread({
        threadId: unknown,
        agentId: f.dot.id,
        userId: f.ownerId,
      });
      const source = new LegacySnapshotSource({
        ...f,
        conversationBackend: 'local',
        owned: true,
      });
      await expect(
        source.capture(f.directory, new AbortController().signal),
      ).rejects.toThrow(/ambiguous/i);
      await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('cleans failed disk writes without modifying the source', async () => {
      const f = await fixture();
      const { rm } = await import('node:fs/promises');
      const source = new LegacySnapshotSource({
        ...f,
        conversationBackend: 'local',
        owned: true,
        onSQLiteCaptured: async () => {
          const path = join(f.directory, 'postgres');
          await rm(path, { recursive: true });
          await writeFile(path, 'simulate unavailable destination');
        },
      });
      await expect(
        source.capture(f.directory, new AbortController().signal),
      ).rejects.toThrow();
      await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        (await f.conversations.getSnapshot(f.thread)).messages,
      ).toHaveLength(2);
      expect(f.gate.status().held).toBe(false);
    });
    it('snapshot contains final committed rows from both stores', async () => {
      const f = await fixture();
      const source = new LegacySnapshotSource({
        ...f,
        conversationBackend: 'local',
        owned: true,
      });
      const manifest = await source.capture(
        f.directory,
        new AbortController().signal,
      );
      expect(manifest).toMatchObject({
        workspaceId: f.workspaceId,
        ownerId: f.ownerId,
        kind: 'workspace-backup',
      });
      for (const entry of manifest.entries) {
        const bytes = await readFile(join(f.directory, entry.path));
        expect(bytes.length).toBe(entry.bytes);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(
          entry.sha256,
        );
      }
      const db = new DatabaseSync(join(f.directory, 'core/workspace.sqlite'), {
        readOnly: true,
      });
      try {
        expect(
          db.prepare('SELECT text FROM memories WHERE id=?').get('wal-memory')
            ?.text,
        ).toBe('Committed SQLite WAL memory');
        expect(
          db.prepare('SELECT transcript FROM calls WHERE id=?').get(f.call.id)
            ?.transcript,
        ).toBe('Saved voice transcript');
        expect(
          db.prepare('SELECT id FROM memory_items WHERE id=?').get(f.memory.id),
        ).toBeDefined();
        expect(
          db.prepare('SELECT count(*) AS n FROM mcp_approvals').get()?.n,
        ).toBe(1);
        expect(
          db
            .prepare('SELECT status FROM memory_items WHERE id=?')
            .get(f.forgotten.id)?.status,
        ).toBe('forgotten');
        expect(
          Number(
            db.prepare('SELECT count(*) AS n FROM memory_suppressions').get()
              ?.n,
          ),
        ).toBeGreaterThan(0);
      } finally {
        db.close();
      }
      const jobs = await readFile(
        join(f.directory, 'postgres/memory_jobs.jsonl'),
        'utf8',
      );
      expect(jobs).toContain('9007199254740993');
      expect(jobs).toContain(f.job.id);
      const threads = await readFile(
        join(f.directory, 'postgres/local_ai_threads.jsonl'),
        'utf8',
      );
      expect(threads).toContain(f.thread);
      expect(threads).toContain('Retained answer');
      expect(threads).not.toContain('OTHER_OWNER_SENTINEL');
      expect(threads).not.toContain('OTHER_WORKSPACE_SENTINEL');
      expect(manifest.coverage).toContainEqual(
        expect.objectContaining({
          component: 'computer-volumes',
          state: 'excluded',
        }),
      );
      const recovery = JSON.parse(
        await readFile(
          join(f.directory, 'recovery/configuration.json'),
          'utf8',
        ),
      );
      expect(recovery.activatable).toBe(false);
      expect(f.gate.status()).toEqual({ held: false, activeWrites: 0 });
      f.store.saveMemory('Still usable');
    });
    it('rejects incomplete PostgreSQL and unsupported external attachment without partial capture', async () => {
      const f = await fixture();
      for (const extra of [
        { postgresUrl: undefined },
        { owned: false },
        { conversationBackend: 'intelligence' as const },
      ]) {
        const source = new LegacySnapshotSource({
          ...f,
          conversationBackend: 'local',
          owned: true,
          ...extra,
        });
        await expect(
          source.capture(f.directory, new AbortController().signal),
        ).rejects.toThrow();
        await expect(stat(f.directory)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      expect(f.gate.status().held).toBe(false);
    });
    it('rejects a changed configuration and leaves unrelated destination files intact', async () => {
      const f = await fixture();
      const source = new LegacySnapshotSource({
        ...f,
        conversationBackend: 'local',
        owned: true,
      });
      await source.capture(f.directory, new AbortController().signal);
      const before = await readdir(f.directory);
      await expect(
        source.capture(f.directory, new AbortController().signal),
      ).rejects.toThrow();
      expect(await readdir(f.directory)).toEqual(before);
      await writeFile(f.configurationPath, 'OWNER_ID=different\n');
      await expect(
        source.capture(join(f.root, 'changed'), new AbortController().signal),
      ).rejects.toThrow(/configuration/i);
    });
    it('cancels between stores and releases admission only after partial files are removed', async () => {
      const f = await fixture();
      const signal = new AbortController();
      const source = new LegacySnapshotSource({
        ...f,
        conversationBackend: 'local',
        owned: true,
        onSQLiteCaptured: () => signal.abort(),
      });
      await expect(
        source.capture(f.directory, signal.signal),
      ).rejects.toThrow();
      await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.gate.status()).toEqual({ held: false, activeWrites: 0 });
      f.store.saveMemory('Still usable');
    });
  },
);
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'detects committed changes without counting its own reads and defers while busy',
  async () => {
    // activity() includes database-wide counters, so parallel fixtures must
    // not write to this database between the two read-only samples.
    const admin = new Pool({
      connectionString: process.env.LOCAL_TEST_DATABASE_URL!,
    });
    const name = 'dots_snapshot_test_' + randomUUID().replaceAll('-', '');
    const url = new URL(process.env.LOCAL_TEST_DATABASE_URL!);
    url.pathname = '/' + name;
    let f: Awaited<ReturnType<typeof storageWorkspace>> | undefined;
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      f = await storageWorkspace(url.href);
      const source = new LegacySnapshotSource({
        ...f,
        owned: true,
        conversationBackend: 'local',
      });
      // Flush committed fixture statistics before taking the baseline.
      await f.pg.query('SELECT pg_stat_force_next_flush()');
      await f.pg.query('SELECT 1');
      const before = await source.activity();
      expect(before.idle).toBe(true);
      expect((await source.activity()).revision).toBe(before.revision);
      f.store.saveMemory('new change', 'changed');
      const sqlite = await source.activity();
      expect(sqlite.revision).not.toBe(before.revision);
      await f.pg.query('UPDATE local_ai_threads SET name=$1 WHERE id=$2', [
        'changed',
        f.thread,
      ]);
      await f.pg.query('SELECT pg_stat_force_next_flush()');
      await f.pg.query('SELECT 1');
      expect((await source.activity()).revision).not.toBe(sqlite.revision);
      const release = await f.gate.enterWrite(new AbortController().signal);
      try {
        expect((await source.activity()).idle).toBe(false);
      } finally {
        release();
      }
    } finally {
      try {
        await f?.dispose();
        if (created) await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
    }
  },
);
