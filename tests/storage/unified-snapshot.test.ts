import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { StorageClient } from '../../src/server/storage/storage-client.js';
import { SQLiteConversations } from '../../src/server/storage/sqlite-conversations.js';
import { UnifiedSnapshotSource } from '../../src/server/storage/unified-snapshot.js';
import { MaintenanceGate } from '../../src/server/storage/maintenance.js';
import { RestoreService } from '../../src/server/storage/restore.js';
import { writeArchive } from '../../src/server/storage/archive.js';
import { readWorkspaceManifest } from '../../src/shared/workspace-manifest.js';
import {
  copyValidatedSQLite,
  restoreSQLite,
} from '../../src/server/storage/restore-sqlite.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dots-unified-backup-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ownerId = randomUUID(),
    workspaceId = randomUUID();
  const sqlitePath = join(root, 'workspace.sqlite');
  const storage = await StorageClient.open({ database: sqlitePath, ownerId });
  cleanups.push(() => storage.close());
  const { store, workspace } = storage.repositories;
  const dot = (await workspace.dots())[0];
  const conversations = new SQLiteConversations(storage);
  const thread = await conversations.createThread({
    userId: ownerId,
    agentId: dot.id,
    threadId: 'thread',
  });
  await workspace.bindThread(thread.id, dot.id, 'Backup conversation');
  const lease = (await conversations.acquireThread(thread.id))!;
  const messages = [
    { id: 'user', role: 'user' as const, content: 'I prefer jasmine tea.' },
  ];
  try {
    await lease.beginRun(
      {
        threadId: thread.id,
        runId: 'run',
        messages,
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      },
      { originDotId: dot.id, spaceIds: [], pageIds: [] },
    );
    await lease.finishRun(messages, {}, 'finished');
  } finally {
    await lease.release();
  }
  await storage.repositories.evidence.indexRun('run');
  await workspace.memory.create({
    scope: { kind: 'dot', id: dot.id },
    title: 'Tea',
    text: 'I prefer jasmine tea.',
  });
  await store.createTask('Never replay this schedule', 60);
  await workspace.computers.patch(dot.id, { enabled: true, files: true });
  const configurationPath = join(root, '.env');
  await writeFile(configurationPath, 'LLM_PROVIDER=fixture\n');
  const gate = new MaintenanceGate();
  const source = new UnifiedSnapshotSource({
    storage,
    sqlitePath,
    ownerId,
    workspaceId,
    gate,
    configurationPath,
  });
  return {
    root,
    sqlitePath,
    ownerId,
    workspaceId,
    storage,
    source,
    gate,
    dot,
    thread,
    conversations,
    workspace,
    store,
  };
}
it('captures all core records and restores them without a PostgreSQL server', async () => {
  const f = await fixture();
  const directory = join(f.root, 'snapshot');
  const manifest = await f.source.capture(
    directory,
    new AbortController().signal,
  );
  expect(manifest).toMatchObject({
    version: 2,
    minimumReader: 2,
    workspaceId: f.workspaceId,
    storage: { engine: 'sqlite', schema: 2 },
  });
  expect(manifest.entries.map((entry) => entry.path).sort()).toEqual([
    'core/workspace.sqlite',
    'recovery/configuration.json',
  ]);
  const archive = join(f.root, 'unified.dotsbackup');
  const passphrase = 'fixture recovery password';
  await writeArchive({
    sourceDirectory: directory,
    destination: archive,
    manifest,
    passphrase,
    signal: new AbortController().signal,
  });
  await f.storage.close();
  await rm(join(f.root, 'workspace.sqlite'));
  const profile = join(f.root, 'profile');
  const destination = join(f.root, 'restored');
  const stopWorkspace = vi.fn(async () => {});
  const service = new RestoreService({ profile, stopWorkspace });
  const preview = await service.prepareRestore({
    archive,
    passphrase,
    destination,
    signal: new AbortController().signal,
  });
  expect(preview.counts).toMatchObject({
    conversation_threads: 1,
    conversation_runs: 1,
    memory_episode_chunks: 1,
    memory_items: 1,
    tasks: 1,
  });
  await service.activateRestore(
    preview.operationId,
    'new',
    new AbortController().signal,
  );
  expect(stopWorkspace).toHaveBeenCalledTimes(1);
  const identity = (await readWorkspaceManifest(destination))!;
  expect(identity).toMatchObject({
    storage: 'sqlite',
    ownerId: f.ownerId,
    schema: 2,
  });
  const env = parseEnv(await readFile(join(destination, '.env'), 'utf8'));
  expect(env.LOCAL_DATABASE_URL).toBeUndefined();
  const restored = await StorageClient.open({
    database: join(destination, 'data/opendots.sqlite'),
    ownerId: identity.ownerId,
  });
  cleanups.push(() => restored.close());
  expect(
    (await new SQLiteConversations(restored).getSnapshot(f.thread.id))
      ?.messages,
  ).toEqual([{ id: 'user', role: 'user', content: 'I prefer jasmine tea.' }]);
  expect((await restored.repositories.store.tasks())[0]).toMatchObject({
    status: 'paused',
    nextRunAt: null,
  });
  expect(
    await restored.repositories.workspace.computers.permissions(f.dot.id),
  ).toMatchObject({ enabled: false });
  expect(
    (await restored.repositories.workspace.memory.listOwner()).items,
  ).toHaveLength(1);
  expect(await restored.repositories.evidence.coverage(f.dot.id)).toMatchObject(
    { indexedRuns: 1, eligibleRuns: 1, complete: true },
  );
}, 15000);
it('refuses active manual capture and preserves existing snapshot destinations', async () => {
  const f = await fixture();
  const destination = join(f.root, 'snapshot');
  const release = await f.gate.enterWrite(new AbortController().signal);
  try {
    await expect(
      f.source.capture(destination, new AbortController().signal),
    ).rejects.toThrow(/busy/);
  } finally {
    release();
  }
  await mkdir(destination);
  await writeFile(join(destination, 'sentinel'), 'keep');
  await expect(
    f.source.capture(destination, new AbortController().signal),
  ).rejects.toThrow();
  expect(await readFile(join(destination, 'sentinel'), 'utf8')).toBe('keep');
  expect((await stat(destination)).isDirectory()).toBe(true);
});
it.each([
  "UPDATE conversation_threads SET agent_id='missing'",
  "UPDATE conversation_threads SET last_run_id='missing'",
  "UPDATE thread_bindings SET id='missing'",
  "UPDATE memory_episode_chunks SET message_id='missing'",
  "UPDATE memory_evidence SET dot_id='missing'",
  "UPDATE conversation_runs SET input=json_remove(input,'$.threadId')",
])(
  'rejects a unified archive with a broken canonical reference: %s',
  async (corrupt) => {
    const f = await fixture();
    await f.storage.close();
    const db = new DatabaseSync(f.sqlitePath);
    try {
      db.exec(corrupt);
    } finally {
      db.close();
    }
    const destination = join(f.root, 'restored');
    await mkdir(join(destination, 'data'), { recursive: true });
    await mkdir(join(destination, 'recovery'));
    await expect(
      restoreSQLite(
        f.sqlitePath,
        join(destination, 'data/opendots.sqlite'),
        f.ownerId,
        new AbortController().signal,
        'sqlite',
      ),
    ).rejects.toThrow(/reference|binding|scope|evidence/i);
  },
);
it('uses a private schema baseline without touching an adjacent existing file', async () => {
  const f = await fixture();
  await f.storage.close();
  const destination = join(f.root, 'copy.sqlite');
  await writeFile(destination + '.schema', 'unrelated file');
  await copyValidatedSQLite(
    f.sqlitePath,
    destination,
    f.ownerId,
    new AbortController().signal,
    'sqlite',
  );
  expect(await readFile(destination + '.schema', 'utf8')).toBe(
    'unrelated file',
  );
});
