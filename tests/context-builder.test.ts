import { afterEach, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { MemoryAccess } from '../src/server/memory-access.js';
import { MemoryRecall } from '../src/server/memory-recall.js';
import {
  ContextBuilder,
  type ContextLimits,
} from '../src/server/context-builder.js';
import { estimateTokens } from '../src/server/context-budget.js';
import { renderSubscriptionPrompt } from '../src/server/subscription-prompt.js';
const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((f) => f()));
function setup(limits: Partial<ContextLimits> = {}) {
  const ws = new WorkspaceStore(':memory:', 'owner'),
    store = new Store(':memory:');
  close.push(() => {
    ws.close();
    store.close();
  });
  const dot = ws.dots()[0];
  const recall = new MemoryRecall(
    ws.memory,
    {
      generation: async () => 0,
      coverage: async () => ({
        indexedRuns: 0,
        eligibleRuns: 0,
        complete: true,
      }),
      searchEpisodes: async () => ({
        matches: [],
        coverage: { indexedRuns: 0, eligibleRuns: 0, complete: true },
      }),
      sourceById: async () => undefined,
      readSource: async () => undefined,
    },
    new MemoryAccess(ws, store),
  );
  const builder = new ContextBuilder(recall, limits);
  const frame = {
    ownerId: 'owner',
    dotId: dot.id,
    threadId: 'thread',
    runId: 'run',
    canonicalMessages: [],
  };
  const payload = {
    systemPrompts: ['Trusted role'],
    messages: [
      { id: 'u', role: 'user' as const, content: 'Keep exact budget $123' },
    ],
    availableTools: [],
  };
  return { ws, store, dot, builder, frame, payload };
}
it('loads only essentials despite 10000 unrelated memories and preserves the input', async () => {
  const { ws, builder, frame, payload } = setup();
  ws.memory.atomic(() => {
    for (let i = 0; i < 10000; i++)
      ws.memory.create({
        scope: { kind: 'owner' },
        title: 'Noise',
        text: `unrelated-unpinned-fact ${i}`,
      });
  });
  ws.memory.create({
    scope: { kind: 'owner' },
    title: 'Tone',
    text: 'Use concise wording',
    pinned: true,
  });
  const original = structuredClone(payload);
  const projected = await builder.project(
    payload,
    frame,
    new AbortController().signal,
  );
  const rendered = renderSubscriptionPrompt(projected);
  expect(rendered).not.toContain('unrelated-unpinned-fact');
  expect(rendered).toContain('Use concise wording');
  expect(rendered).toContain('Keep exact budget $123');
  expect(estimateTokens(rendered)).toBeLessThanOrEqual(24000);
  expect(payload).toEqual(original);
});
it('accounts for Unicode, schemas, and final serialization before admitting inference', async () => {
  const { builder, frame, payload } = setup({ inputTokenLimit: 24_000 });
  await expect(
    builder.project(
      { ...payload, messages: [{ role: 'user', content: '漢'.repeat(9000) }] },
      frame,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/capacity/i);
  await expect(
    builder.project(
      {
        ...payload,
        availableTools: [
          { name: 'big', description: 'x'.repeat(25000), inputSchema: {} },
        ],
      },
      frame,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/capacity/i);
  await expect(
    builder.project(
      { ...payload, responseSchema: { description: 'x'.repeat(25000) } },
      frame,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/capacity/i);
});
it('still rejects requests larger than the default capacity', async () => {
  const { builder, frame, payload } = setup();
  await expect(
    builder.project(
      {
        ...payload,
        messages: [{ role: 'user', content: 'x'.repeat(65_000) }],
      },
      frame,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/capacity/i);
});
it('rejects pin overflow and immediately refreshes changed or disabled essential context', async () => {
  const { ws, store, builder, frame, payload } = setup();
  const item = ws.memory.create({
    scope: { kind: 'owner' },
    title: 'First',
    text: 'Old preference',
    pinned: true,
  });
  expect(
    renderSubscriptionPrompt(
      await builder.project(payload, frame, new AbortController().signal),
    ),
  ).toContain('Old preference');
  ws.memory.edit(item.id, 1, { text: 'New preference' });
  expect(
    renderSubscriptionPrompt(
      await builder.project(payload, frame, new AbortController().signal),
    ),
  ).toContain('New preference');
  expect(() =>
    ws.memory.create({
      scope: { kind: 'owner' },
      title: 'Too large',
      text: 'x'.repeat(1990),
      pinned: true,
    }),
  ).toThrow(/pinned.*capacity/i);
  store.updateSettings({ memoryAllowed: false });
  expect(
    renderSubscriptionPrompt(
      await builder.project(payload, frame, new AbortController().signal),
    ),
  ).not.toContain('New preference');
});
it('rechecks a pinned record after asynchronous source validation', async () => {
  const { publicationFixture } = await import('./fixtures/memory.js');
  const f = await publicationFixture();
  close.push(f.close);
  const record = f.add('I prefer weekly reports.').record;
  const item = f.workspace.memory.create({
    scope: { kind: 'dot', id: f.dot.id },
    title: 'Preference',
    text: record.text,
    pinned: true,
    sources: [record.source],
  });
  const builder = new ContextBuilder(f.recall);
  f.recall.episodes.readSource = async () => {
    f.workspace.memory.edit(item.id, 1, { status: 'forgotten', pinned: false });
    return record;
  };
  expect(await builder.essentials(f.dot.id)).toEqual([]);
});
it('does not return pinned context when source validation revokes memory permission', async () => {
  const { publicationFixture } = await import('./fixtures/memory.js');
  const f = await publicationFixture();
  close.push(f.close);
  const record = f.add('I prefer weekly reports.').record;
  f.workspace.memory.create({
    scope: { kind: 'dot', id: f.dot.id },
    title: 'Preference',
    text: record.text,
    pinned: true,
    sources: [record.source],
  });
  const builder = new ContextBuilder(f.recall);
  f.recall.episodes.readSource = async () => {
    f.store.updateSettings({ memoryAllowed: false });
    return record;
  };
  await expect(builder.essentials(f.dot.id)).rejects.toThrow(/disabled/);
});
