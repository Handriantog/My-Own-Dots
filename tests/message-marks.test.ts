import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace';

it('keeps pins and bookmarks independent, scoped to their conversation, and durable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-message-marks-'));
  const path = join(dir, 'workspace.sqlite');
  let store = new WorkspaceStore(path, 'owner');
  try {
    const dot = store.dots()[0];
    store.bindThread('first', dot.id, 'First chat');
    store.bindThread('second', dot.id, 'Second chat');
    const message = {
      id: 'message',
      role: 'assistant' as const,
      content: 'Keep this answer',
    };
    store.setMessageMark('first', message, 'pin', true);
    store.setMessageMark('first', message, 'bookmark', true);
    store.setMessageMark(
      'second',
      { ...message, content: 'Another answer' },
      'bookmark',
      true,
    );
    const pinnedAt = store.messageMarks('first')[0].pinnedAt;
    store.setMessageMark('first', message, 'pin', true);
    expect(store.messageMarks('first')[0].pinnedAt).toBe(pinnedAt);
    store.close();
    store = new WorkspaceStore(path, 'owner');
    expect(store.messageMarks()).toHaveLength(2);
    expect(store.messageMarks('first')[0]).toMatchObject({
      content: 'Keep this answer',
      threadTitle: 'First chat',
      dotId: dot.id,
      pinnedAt: expect.any(Number),
      bookmarkedAt: expect.any(Number),
    });
    store.setMessageMark('first', message, 'pin', false);
    expect(store.messageMarks('first')[0]).toMatchObject({
      pinnedAt: null,
      bookmarkedAt: expect.any(Number),
    });
    store.setMessageMark('first', message, 'bookmark', false);
    expect(store.messageMarks('first')).toEqual([]);
    expect(store.messageMarks('second')).toHaveLength(1);
    const other = new WorkspaceStore(path, 'another-owner');
    try {
      expect(other.messageMarks()).toEqual([]);
      expect(() =>
        other.setMessageMark('second', message, 'pin', true),
      ).toThrow(/owner/);
    } finally {
      other.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
