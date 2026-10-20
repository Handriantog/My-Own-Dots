import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { storageWorkspace } from '../fixtures/storage-workspace.js';
import { LegacySnapshotSource } from '../../src/server/storage/legacy-snapshot.js';
import { migrateLegacySnapshot } from '../../src/server/storage/migrate-workspace.js';
import { StorageClient } from '../../src/server/storage/storage-client.js';
import { SQLiteConversations } from '../../src/server/storage/sqlite-conversations.js';
import { fileSeal } from '../../src/server/storage/restore-journal.js';
import { MemoryJobs } from '../../src/server/memory-jobs.js';
import { evidenceHash } from '../../src/server/conversation-memory.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'migrates canonical legacy records without a PostgreSQL target and retains the original capture',
  async () => {
    const f = await storageWorkspace();
    cleanup.push(f.dispose);
    f.store.createTask('Pause this schedule during migration', 60);
    f.workspace.computers.patch(f.dot.id, { enabled: true, files: true });
    const original = await f.conversations.getSnapshot(f.thread);
    const checkpoint = {
      id: randomUUID(),
      threadId: f.thread,
      schemaVersion: 1,
      sourceMessageIds: original.messages.map((message) => message.id),
      sourceHash: evidenceHash(original.messages),
      permissionGeneration: 'fixture',
      suppressionGeneration: f.workspace.memory.suppressionGeneration(),
      goal: 'Preserve history',
      constraints: [],
      decisions: [],
      completedWork: [],
      openQuestions: [],
      nextSteps: [],
      evidenceMessageIds: [],
      createdAt: Date.now(),
    };
    await f.pg.query(
      'INSERT INTO memory_checkpoints VALUES($1,$2,$3,$4,$5,now())',
      [
        f.ownerId,
        f.thread,
        checkpoint.id,
        original.messages.length,
        checkpoint,
      ],
    );
    const completed = await new MemoryJobs(f.pg, f.ownerId).enqueue({
      kind: 'dream',
      dotId: f.dot.id,
      sourceIds: f.job.sourceIds,
      origin: 'automatic',
      logicalKey: 'completed-fixture',
    });
    await f.pg.query(
      "UPDATE memory_jobs SET state='succeeded',admitted_day='2026-10-20' WHERE owner_id=$1 AND id=$2",
      [f.ownerId, completed.id],
    );
    await f.pg.query('INSERT INTO memory_daily_admissions VALUES($1,$2,$3,1)', [
      f.ownerId,
      f.dot.id,
      '2026-10-20',
    ]);
    await f.pg.query(
      'INSERT INTO memory_processed_sources SELECT owner_id,source_id,$2 FROM memory_episode_chunks WHERE owner_id=$1',
      [f.ownerId, completed.id],
    );
    await f.pg.query(
      'UPDATE memory_evidence SET processed_job_id=$2 WHERE owner_id=$1',
      [f.ownerId, completed.id],
    );
    f.workspace.memory.history.saveReceipt({
      id: randomUUID(),
      jobId: completed.id,
      dotId: f.dot.id,
      createdAt: Date.now(),
      changes: [],
    });
    f.workspace.memory.saveScanCursor('fixture', 'stable-cursor');
    const connections = f.workspace.connections.list(f.dot.id);
    const suppressionGeneration = f.workspace.memory.suppressionGeneration();
    const signal = new AbortController().signal;
    const manifest = await new LegacySnapshotSource({
      ...f,
      owned: true,
      conversationBackend: 'local',
    }).capture(f.directory, signal);
    const sourceSeal = await fileSeal(
      join(f.directory, 'core/workspace.sqlite'),
      signal,
    );
    await f.disconnect();
    await rename(f.sqlitePath, f.sqlitePath + '.offline');
    const destination = join(f.root, 'migrated');
    await mkdir(join(destination, 'data'), { recursive: true });
    await mkdir(join(destination, 'recovery'));
    const database = join(destination, 'data/opendots.sqlite');
    const result = await migrateLegacySnapshot({
      directory: f.directory,
      destination: database,
      ownerId: f.ownerId,
      signal,
    });
    expect(result.counts).toMatchObject({
      local_ai_threads: 1,
      local_ai_runs: 1,
      memory_episode_chunks: 2,
      memory_jobs: 2,
      memory_checkpoints: 1,
      memory_daily_admissions: 1,
      memory_processed_sources: 2,
    });
    for (const item of Object.values(result.verification)) {
      expect(item.actualHash).toBe(item.expectedHash);
      expect(item.actualCount).toBe(item.expectedCount);
    }
    expect(
      await fileSeal(join(f.directory, 'core/workspace.sqlite'), signal),
    ).toBe(sourceSeal);
    expect(manifest.entries).toHaveLength(11);
    const storage = await StorageClient.open({ database, ownerId: f.ownerId });
    cleanup.push(() => storage.close());
    const conversations = new SQLiteConversations(storage);
    expect(await conversations.getSnapshot(f.thread)).toEqual(original);
    const { workspace, store, evidence, jobs } = storage.repositories;
    expect(await workspace.connections.list(f.dot.id)).toEqual(connections);
    expect(await workspace.computers.permissions(f.dot.id)).toMatchObject({
      enabled: true,
      files: true,
    });
    expect((await workspace.memory.get(f.forgotten.id))?.status).toBe(
      'forgotten',
    );
    expect(await workspace.memory.suppressionGeneration()).toBe(
      suppressionGeneration,
    );
    expect(await evidence.coverage(f.dot.id)).toMatchObject({
      eligibleRuns: 1,
      indexedRuns: 1,
      complete: true,
    });
    expect(await evidence.latestCheckpoint(f.thread)).toEqual(checkpoint);
    expect(await workspace.memory.history.receipt(completed.id)).toMatchObject({
      changes: [],
    });
    expect(await workspace.memory.scanCursor('fixture')).toBe('stable-cursor');
    expect(await store.settings()).toMatchObject({ paused: true });
    expect((await store.tasks())[0]).toMatchObject({
      status: 'paused',
      nextRunAt: null,
    });
    expect(await jobs.get(f.job.id)).toMatchObject({
      state: 'cancelled',
      leaseToken: null,
      leaseUntil: null,
    });
    expect(
      await readFile(
        join(destination, 'recovery/migration-verification.json'),
        'utf8',
      ),
    ).toContain('local_ai_threads');
  },
);
it
  .skipIf(!process.env.LOCAL_TEST_DATABASE_URL)
  .each(['missing', 'schema', 'reference', 'collision'] as const)(
  'rejects %s migration input without changing source records',
  async (mode) => {
    const f = await storageWorkspace();
    cleanup.push(f.dispose);
    const signal = new AbortController().signal;
    await new LegacySnapshotSource({
      ...f,
      owned: true,
      conversationBackend: 'local',
    }).capture(f.directory, signal);
    const sourceSeal = await fileSeal(f.sqlitePath, signal);
    const destination = join(f.root, 'migrated');
    await mkdir(join(destination, 'data'), { recursive: true });
    await mkdir(join(destination, 'recovery'));
    const database = join(destination, 'data/opendots.sqlite');
    const path = join(f.directory, 'postgres/local_ai_threads.jsonl');
    if (mode === 'missing') await rename(path, path + '.missing');
    if (mode === 'schema') await writeFile(path, '{"version":999}\n');
    if (mode === 'reference') {
      const lines = (await readFile(path, 'utf8')).trim().split('\n');
      const row = JSON.parse(lines[1]);
      row.agent_id = 'missing-dot';
      lines[1] = JSON.stringify(row);
      await writeFile(path, lines.join('\n') + '\n');
    }
    if (mode === 'collision')
      await writeFile(database, 'keep this unrelated target');
    await expect(
      migrateLegacySnapshot({
        directory: f.directory,
        destination: database,
        ownerId: f.ownerId,
        signal,
      }),
    ).rejects.toThrow();
    expect(await fileSeal(f.sqlitePath, signal)).toBe(sourceSeal);
    expect((await f.conversations.getSnapshot(f.thread)).messages).toHaveLength(
      2,
    );
    if (mode === 'collision')
      expect(await readFile(database, 'utf8')).toBe(
        'keep this unrelated target',
      );
  },
);
