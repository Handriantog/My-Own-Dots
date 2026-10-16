import { afterEach, expect, it, vi } from 'vitest';
import { runAgent } from 'myown-llm-integrator';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { MemoryAccess } from '../src/server/memory-access.js';
import { MemoryRecall } from '../src/server/memory-recall.js';
import type { SourceRef } from '../src/shared/memory.js';
import { sourceRef } from './fixtures/memory.js';
vi.mock('myown-llm-integrator', () => ({ runAgent: vi.fn() }));
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  vi.clearAllMocks();
});
function fixture() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const store = new Store(':memory:');
  cleanups.push(() => {
    workspace.close();
    store.close();
  });
  const dot = workspace.dots()[0];
  const other = workspace.createDot(dot.spaceId, 'Other', 'Help', true, true);
  const episodes = {
    generation: async () => 0,
    coverage: async () => ({
      indexedRuns: 0,
      eligibleRuns: 2,
      complete: false,
    }),
    searchEpisodes: async () => ({
      matches: [],
      coverage: { indexedRuns: 0, eligibleRuns: 2, complete: false },
    }),
    sourceById: async () => undefined,
    readSource: async (source: SourceRef) => ({
      id: 'source',
      ownerId: 'owner',
      source,
      guard: source.guard,
      text: 'Launch October 20',
      role: 'user',
      createdAt: 1,
    }),
  };
  const access = new MemoryAccess(workspace, store);
  const recall = new MemoryRecall(workspace.memory, episodes, access);
  return { workspace, store, dot, other, episodes, access, recall };
}
it('isolates private memories, excludes inactive facts, and reports partial coverage', async () => {
  const { workspace, dot, other, recall } = fixture();
  const item = workspace.memory.create({
    title: 'Launch',
    text: 'Launch SKU-001',
    scope: { kind: 'dot', id: dot.id },
  });
  workspace.memory.create({
    title: 'Expired',
    text: 'Launch outdated',
    scope: { kind: 'owner' },
    expiresAt: 1,
  });
  workspace.memory.create({
    title: 'Superseded',
    text: 'Launch discarded',
    scope: { kind: 'owner' },
    status: 'superseded',
  });
  const found = await recall.search(dot.id, { query: 'Launch' });
  expect(found.matches.map((m) => m.id)).toEqual([item.id]);
  expect(found.coverage.complete).toBe(false);
  expect((await recall.search(other.id, { query: 'Launch' })).matches).toEqual(
    [],
  );
  await expect(recall.read(other.id, item.id)).rejects.toThrow(/access/i);
  expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
});
it('invalidates warm recall after correction and enforces live permissions on direct reads', async () => {
  const { workspace, store, dot, recall } = fixture();
  const page = workspace.pages.create(dot.spaceId, { title: 'Source' });
  const item = workspace.memory.create({
    title: 'Launch',
    text: 'Launch October 20',
    scope: { kind: 'dot', id: dot.id },
    sources: [
      sourceRef({
        guard: {
          originDotId: dot.id,
          spaceIds: [dot.spaceId],
          pageIds: [page.id],
        },
      }),
    ],
  });
  expect(
    (await recall.search(dot.id, { query: 'Launch' })).matches[0].text,
  ).toContain('October 20');
  const cited = (await recall.search(dot.id, { query: 'Launch' })).matches[0];
  expect(cited.sourceIds).toHaveLength(1);
  expect(cited.sourceIds[0]).toMatch(/^[a-f0-9]{64}$/);
  workspace.memory.edit(item.id, 1, { text: 'Launch October 21' });
  expect(
    (await recall.search(dot.id, { query: 'Launch' })).matches[0].text,
  ).toContain('October 21');
  workspace.pages.delete(page.spaceId, page.id);
  await expect(recall.read(dot.id, item.id)).rejects.toThrow(/access/i);
  expect((await recall.search(dot.id, { query: 'Launch' })).matches).toEqual(
    [],
  );
  store.updateSettings({ memoryAllowed: false });
  await expect(recall.search(dot.id, { query: 'Launch' })).rejects.toThrow(
    /disabled/i,
  );
});
it('paginates large Unicode reads within budget and rejects transferred or tampered cursors', async () => {
  const { workspace, dot, other, recall } = fixture();
  const item = workspace.memory.create({
    kind: 'skill',
    title: 'Workflow',
    text: '漢'.repeat(6000),
    scope: { kind: 'owner' },
  });
  const first = await recall.read(dot.id, item.id);
  expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(2500);
  expect(first.nextCursor).toBeTruthy();
  const second = await recall.read(dot.id, item.id, first.nextCursor);
  expect(first.text.length + second.text.length).toBeGreaterThan(
    first.text.length,
  );
  await expect(
    recall.read(other.id, item.id, first.nextCursor),
  ).rejects.toThrow(/cursor/i);
  await expect(
    recall.read(dot.id, item.id, first.nextCursor + 'bad'),
  ).rejects.toThrow(/cursor/i);
  workspace.memory.edit(item.id, 1, { text: 'New procedure' });
  await expect(recall.read(dot.id, item.id, first.nextCursor)).rejects.toThrow(
    /cursor/i,
  );
});
it('bounds searches, handles punctuation, and keeps storage errors distinct from no matches', async () => {
  const { workspace, dot, recall, episodes } = fixture();
  for (let i = 0; i < 12; i++)
    workspace.memory.create({
      title: 'Launch',
      text: `Launch item ${i}`,
      scope: { kind: 'owner' },
    });
  const first = await recall.search(dot.id, { query: 'Launch' });
  expect(first.matches.length).toBeLessThanOrEqual(10);
  const next = await recall.search(dot.id, {
    query: 'Launch',
    cursor: first.nextCursor,
  });
  expect(
    next.matches.some((m) => first.matches.some((old) => old.id === m.id)),
  ).toBe(false);
  expect((await recall.search(dot.id, { query: '!!!' })).matches).toEqual([]);
  await expect(
    recall.search(dot.id, { query: 'x'.repeat(501) }),
  ).rejects.toThrow();
  episodes.generation = async () => {
    throw new Error('storage unavailable');
  };
  await expect(recall.search(dot.id, { query: 'new' })).rejects.toThrow(
    /unavailable/,
  );
});
