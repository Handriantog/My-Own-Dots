import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { DatabaseSync } from 'node:sqlite';
import { copyValidatedSQLite } from '../src/server/storage/restore-sqlite.js';

it('saves customization independently and keeps exactly one desktop selection across restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-customization-'));
  const file = join(directory, 'workspace.sqlite');
  let store = new WorkspaceStore(file, 'owner');
  try {
    const a = store.dots()[0];
    const b = store.createDot(
      a.spaceId,
      'Scout',
      'Research carefully',
      true,
      true,
    );
    store.setDotCustomization(a.id, {
      color: '#ffbb00',
      muted: true,
      paused: true,
    });
    store.setDotCustomization(b.id, {
      color: '#aa33ff',
      volume: 0.7,
      reducedMotion: true,
    });
    store.selectDesktopDot(a.id);
    store.selectDesktopDot(b.id);
    store.close();
    store = new WorkspaceStore(file, 'owner');
    expect(store.desktopDot().dotId).toBe(b.id);
    expect(store.dot(a.id)?.customization).toMatchObject({
      color: '#ffbb00',
      muted: true,
      paused: true,
      reducedMotion: false,
    });
    expect(store.dot(b.id)?.customization).toMatchObject({
      color: '#aa33ff',
      volume: 0.7,
      muted: false,
      paused: false,
      reducedMotion: true,
    });
    const c = store.createDot(a.spaceId, 'Writer', 'Write clearly', true, true);
    expect(store.dot(c.id)?.customization).toMatchObject({
      color: '#45a7ff',
      muted: false,
    });
    expect(store.desktopDot().dotId).toBe(b.id);
    expect(() => store.selectDesktopDot('missing')).toThrow();
    expect(store.desktopDot().dotId).toBe(b.id);
    expect(() =>
      store.setDotCustomization(a.id, { talkShortcut: '' }),
    ).toThrow();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('copies legacy customization once without overwriting subsequent Dot edits or new Dots', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  try {
    const a = store.dots()[0];
    const b = store.createDot(
      a.spaceId,
      'Scout',
      'Research carefully',
      true,
      true,
    );
    store.initializeDotCustomization({ color: '#aabbcc', volume: 0.2 });
    expect(store.dot(a.id)?.customization?.color).toBe('#aabbcc');
    expect(store.dot(b.id)?.customization?.color).toBe('#aabbcc');
    store.setDotCustomization(a.id, { color: '#123456' });
    const c = store.createDot(a.spaceId, 'Writer', 'Write clearly', true, true);
    store.initializeDotCustomization({ color: '#ffffff' });
    expect(store.dot(a.id)?.customization?.color).toBe('#123456');
    expect(store.dot(b.id)?.customization?.color).toBe('#aabbcc');
    expect(store.dot(c.id)?.customization?.color).toBe('#45a7ff');
  } finally {
    store.close();
  }
});

it('restores a known workspace backup from before per-Dot customization', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-old-backup-'));
  const source = join(directory, 'old.sqlite');
  const destination = join(directory, 'restored.sqlite');
  try {
    new Store(source).close();
    new WorkspaceStore(source, 'owner').close();
    const old = new DatabaseSync(source);
    old.exec(
      'DROP TABLE desktop_dot; ALTER TABLE dots DROP COLUMN customization',
    );
    old.close();
    await copyValidatedSQLite(
      source,
      destination,
      'owner',
      new AbortController().signal,
    );
    const restored = new WorkspaceStore(destination, 'owner');
    expect(restored.dots()[0].customization?.color).toBe('#45a7ff');
    const dotId = restored.dots()[0].id;
    restored.setDotCustomization(dotId, { color: '#aabbcc' });
    restored.selectDesktopDot(dotId);
    restored.close();
    const secondRestore = join(directory, 'second-restore.sqlite');
    await copyValidatedSQLite(
      destination,
      secondRestore,
      'owner',
      new AbortController().signal,
    );
    const reopened = new WorkspaceStore(secondRestore, 'owner');
    expect(reopened.dot(dotId)?.customization?.color).toBe('#aabbcc');
    expect(reopened.desktopDot().dotId).toBe(dotId);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
