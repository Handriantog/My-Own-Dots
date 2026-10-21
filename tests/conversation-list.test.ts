import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace';

it('upgrades existing chats and persists independent title and pin changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-chat-list-'));
  const path = join(dir, 'workspace.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
    INSERT INTO thread_bindings VALUES ('existing', 'dot', 'owner', 'Original', 1);`);
  legacy.close();
  let store = new WorkspaceStore(path, 'owner');
  try {
    expect(store.requireThread('existing')).toMatchObject({
      title: 'Original',
      pinnedAt: null,
    });
    const pinned = store.updateConversation('existing', { pinned: true });
    store.updateConversation('existing', { title: 'Renamed' });
    expect(
      store.updateConversation('existing', { pinned: true }).pinnedAt,
    ).toBe(pinned.pinnedAt);
    store.close();
    store = new WorkspaceStore(path, 'owner');
    expect(store.requireThread('existing')).toMatchObject({
      title: 'Renamed',
      pinnedAt: expect.any(Number),
      createdAt: 1,
    });
    expect(
      store.updateConversation('existing', { pinned: false }),
    ).toMatchObject({ title: 'Renamed', pinnedAt: null });
    const other = new WorkspaceStore(path, 'another-owner');
    try {
      expect(() =>
        other.updateConversation('existing', {
          title: 'Not mine',
          pinned: true,
        }),
      ).toThrow(/owner/);
      expect(store.requireThread('existing').title).toBe('Renamed');
    } finally {
      other.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps deleted chats and their saved messages out of active lists and restores them after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-chat-trash-'));
  const path = join(dir, 'workspace.sqlite');
  let store = new WorkspaceStore(path, 'owner');
  try {
    const dot = store.dots()[0];
    store.bindThread('deleted', dot.id, 'Keep for recovery');
    store.bindThread('kept', dot.id, 'Other chat');
    store.updateConversation('deleted', { pinned: true });
    store.setMessageMark(
      'deleted',
      { id: 'message', role: 'user', content: 'Saved text' },
      'bookmark',
      true,
    );
    store.deleteConversation('deleted');
    expect(store.conversations().map((thread) => thread.id)).toEqual(['kept']);
    expect(store.messageMarks()).toEqual([]);
    expect(() => store.requireThread('deleted')).toThrow(/owner/);
    store.close();
    store = new WorkspaceStore(path, 'owner');
    expect(store.deletedConversations()).toMatchObject([
      { id: 'deleted', deletedAt: expect.any(Number) },
    ]);
    const other = new WorkspaceStore(path, 'another-owner');
    try {
      expect(other.deletedConversations()).toEqual([]);
      expect(() => other.restoreConversation('deleted')).toThrow(/owner/);
      expect(() => other.deleteConversation('kept')).toThrow(/owner/);
    } finally {
      other.close();
    }
    expect(store.restoreConversation('deleted')).toMatchObject({
      title: 'Keep for recovery',
      deletedAt: null,
      pinnedAt: expect.any(Number),
    });
    expect(store.deletedConversations()).toEqual([]);
    expect(store.messageMarks()).toMatchObject([
      { threadId: 'deleted', content: 'Saved text' },
    ]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
