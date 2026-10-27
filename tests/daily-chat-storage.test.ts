import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
it('reuses daily identity, preserves names and advances after trash even after restore', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  const first = ws.dailyConversation(dot.id, '2026-10-27');
  ws.updateConversation(first.id, { title: 'Custom' });
  expect(ws.dailyConversation(dot.id, '2026-10-27').title).toBe('Custom');
  ws.deleteConversation(first.id);
  const second = ws.dailyConversation(dot.id, '2026-10-27');
  ws.restoreConversation(first.id);
  expect(second.id).not.toBe(first.id);
  expect(ws.dailyConversation(dot.id, '2026-10-27').id).toBe(second.id);
  expect(ws.dailyConversation(dot.id, '2026-10-28').id).not.toBe(second.id);
  ws.close();
});
it('persists explicit empty membership and rejects cross-call assignment', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  ws.bindThread('thread', ws.dots()[0].id, 'Chat');
  const a = ws.createCall('thread', 'previous');
  const b = ws.createCall('thread');
  expect(ws.call(a.id).messageIds).toEqual([]);
  expect(ws.call(a.id).afterMessageId).toBe('previous');
  ws.recordCallMessages(a.id, ['arbitrary', 'arbitrary']);
  ws.recordCallMessages(a.id, ['later']);
  expect(ws.call(a.id).messageIds).toEqual(['arbitrary', 'later']);
  expect(() => ws.recordCallMessages(b.id, ['arbitrary'])).toThrow();
  ws.close();
});

it('serializes competing real workers and persists daily and call history across restart', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { StorageClient } =
    await import('../src/server/storage/storage-client.js');
  const root = await mkdtemp(join(tmpdir(), 'daily-storage-'));
  const database = join(root, 'workspace.sqlite');
  const first = await StorageClient.open({
    database,
    ownerId: 'owner',
    engine: 'sqlite',
  });
  let second: Awaited<ReturnType<typeof StorageClient.open>> | undefined;
  try {
    const ws = first.repositories.workspace;
    const dot = (await ws.dots())[0];
    second = await StorageClient.open({
      database,
      ownerId: 'owner',
      engine: 'sqlite',
    });
    const all = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? ws : second!.repositories.workspace).dailyConversation(
          dot.id,
          '2026-10-27',
        ),
      ),
    );
    expect(new Set(all.map((row) => row.id)).size).toBe(1);
    const thread = all[0];
    await ws.updateConversation(thread.id, { title: 'Persistent title' });
    const call = await ws.createCall(thread.id, 'anchor');
    await ws.recordCallMessages(call.id, ['any-id']);
    expect(
      (await second.repositories.workspace.call(call.id)).messageIds,
    ).toEqual(['any-id']);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(database);
    expect(
      db
        .prepare(
          'SELECT count(*) AS n FROM conversation_threads WHERE owner_id=? AND id=?',
        )
        .get('owner', thread.id)?.n,
    ).toBe(1);
    db.close();
    await second.close();
    second = undefined;
    await first.close();
    second = await StorageClient.open({
      database,
      ownerId: 'owner',
      engine: 'sqlite',
    });
    expect(
      (
        await second.repositories.workspace.dailyConversation(
          dot.id,
          '2026-10-27',
        )
      ).title,
    ).toBe('Persistent title');
    expect(
      (await second.repositories.workspace.call(call.id)).messageIds,
    ).toEqual(['any-id']);
    expect(
      (await second.repositories.workspace.callForMessage(thread.id, 'any-id'))
        ?.id,
    ).toBe(call.id);
    const foreign = await StorageClient.open({
      database,
      ownerId: 'foreign',
      engine: 'sqlite',
    });
    try {
      await expect(
        foreign.repositories.workspace.recordCallMessages(call.id, ['steal']),
      ).rejects.toThrow();
      expect(await foreign.repositories.workspace.calls()).toEqual([]);
      await expect(
        foreign.repositories.workspace.callForMessage(thread.id, 'any-id'),
      ).rejects.toThrow();
    } finally {
      await foreign.close();
    }
  } finally {
    await second?.close();
    await first.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('restores exact historical schema8 DDL and preserves legacy calls without invented membership', async () => {
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { Store } = await import('../src/server/store.js');
  const { initializeSQLiteSchema } =
    await import('../src/server/storage/sqlite-schema.js');
  const { restoreSQLite } =
    await import('../src/server/storage/restore-sqlite.js');
  const root = await mkdtemp(join(tmpdir(), 'daily-schema8-'));
  const source = join(root, 'old.sqlite');
  const target = join(root, 'data', 'restored.sqlite');
  await mkdir(join(root, 'data'));
  await mkdir(join(root, 'recovery'));
  try {
    const store = new Store(source);
    store.close();
    const ws = new WorkspaceStore(source, 'owner');
    const dot = ws.dots()[0];
    ws.bindThread('old', dot.id, 'Old');
    const call = ws.createCall('old');
    ws.close();
    const db = new DatabaseSync(source);
    initializeSQLiteSchema(db, 8);
    db.exec('DROP TABLE call_history');
    db.prepare(
      'INSERT INTO conversation_threads(owner_id,id,agent_id,created_at,updated_at) VALUES(?,?,?,?,?)',
    ).run('owner', 'old', dot.id, 1, 1);
    db.close();
    await restoreSQLite(
      source,
      target,
      'owner',
      new AbortController().signal,
      'sqlite',
      8,
    );
    const restored = new WorkspaceStore(target, 'owner');
    expect(() =>
      restored.recordCallMessages(call.id, ['late-receipt']),
    ).not.toThrow();
    expect(() => restored.recordCallMessages(call.id, [''])).toThrow();
    expect(restored.call(call.id).messageIds).toBeUndefined();
    expect(restored.createCall('old').messageIds).toEqual([]);
    restored.close();
    const verify = new DatabaseSync(source);
    expect(
      verify
        .prepare('SELECT max(version) AS v FROM workspace_storage_schema')
        .get()?.v,
    ).toBe(8);
    verify.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('resolves exact call membership within the owned thread and keeps typed turns ungrouped', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.dots()[0];
  ws.bindThread('one', dot.id, 'One');
  ws.bindThread('two', dot.id, 'Two');
  const call = ws.createCall('one');
  ws.recordCallMessages(call.id, ['voice-user']);
  expect(ws.callForMessage('one', 'voice-user')?.id).toBe(call.id);
  expect(ws.callForMessage('one', 'typed-user')).toBeUndefined();
  expect(ws.callForMessage('two', 'voice-user')).toBeUndefined();
  expect(() => ws.callForMessage('unknown', 'voice-user')).toThrow();
  ws.close();
});
