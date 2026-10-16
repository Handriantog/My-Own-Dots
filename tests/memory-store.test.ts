import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MemoryStore } from '../src/server/memory-store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function setup(owner = 'owner') {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  return { db, memory: new MemoryStore(db, owner) };
}
const input = {
  scope: { kind: 'owner' as const },
  title: 'Reports',
  text: 'Prefer concise reports',
};

it('imports explicit preferences once without losing IDs, long text, or timestamps after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-memory-'));
  try {
    const path = join(dir, 'memory.sqlite');
    const first = new DatabaseSync(path);
    const memory = new MemoryStore(first, 'owner');
    const rows = [{ id: 'legacy', text: 'x'.repeat(3000), createdAt: 123 }];
    memory.importLegacy(rows);
    memory.importLegacy(rows);
    expect(memory.listOwner({}).items).toHaveLength(1);
    expect(memory.get('legacy')).toMatchObject({
      ...rows[0],
      status: 'active',
      pinned: false,
      revision: 1,
      scope: { kind: 'owner' },
    });
    first.close();
    const reopened = new DatabaseSync(path);
    const again = new MemoryStore(reopened, 'owner');
    again.importLegacy([{ ...rows[0], text: 'stale legacy write' }]);
    expect(again.get('legacy')?.text).toBe('x'.repeat(3000));
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rejects stale edits, immutable owner changes, invalid scope, and oversized manual facts', () => {
  const { memory } = setup();
  const item = memory.create(input);
  const changed = memory.edit(item.id, 1, { text: 'Prefer detailed reports' });
  expect(changed).toMatchObject({
    revision: 2,
    text: 'Prefer detailed reports',
  });
  expect(() => memory.edit(item.id, 1, { text: 'stale' })).toThrow(/revision/i);
  expect(() =>
    memory.create({ ...input, ownerId: 'foreign' } as never),
  ).toThrow();
  expect(() =>
    memory.edit(item.id, 2, { ownerId: 'foreign' } as never),
  ).toThrow();
  expect(() =>
    memory.create({ ...input, scope: { kind: 'space', id: '' } }),
  ).toThrow();
  expect(() => memory.create({ ...input, text: 'x'.repeat(2001) })).toThrow();
  expect(memory.get(item.id)?.text).toBe('Prefer detailed reports');
});

it('rolls back an entire revision batch and does not expose another owner records', () => {
  const { db, memory } = setup();
  const item = memory.create(input);
  expect(() =>
    memory.atomic(() => {
      memory.edit(item.id, 1, { text: 'rolled back' });
      memory.create({ ...input, title: '' });
    }),
  ).toThrow();
  expect(memory.get(item.id)).toEqual(item);
  expect(memory.revisions(item.id)).toHaveLength(1);
  const other = new MemoryStore(db, 'someone-else');
  expect(other.get(item.id)).toBeUndefined();
  expect(other.listOwner({}).items).toEqual([]);
});

it('bounds owner listing and supports FTS on the installed SQLite runtime', () => {
  const { db, memory } = setup();
  for (let i = 0; i < 12; i++)
    memory.create({ ...input, title: `Report ${i}` });
  const page = memory.listOwner({ limit: 10 });
  expect(page.items).toHaveLength(10);
  expect(
    memory.listOwner({ limit: 10, cursor: page.nextCursor }).items,
  ).toHaveLength(2);
  db.exec('CREATE VIRTUAL TABLE fts_probe USING fts5(text)');
  db.prepare('INSERT INTO fts_probe VALUES (?)').run('hello memory');
  expect(
    db
      .prepare('SELECT text FROM fts_probe WHERE fts_probe MATCH ?')
      .get('memory')?.text,
  ).toBe('hello memory');
});

it('exposes curated memory on the workspace connection', () => {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    expect(workspace.memory.create(input).ownerId).toBe('owner');
  } finally {
    workspace.close();
  }
});
