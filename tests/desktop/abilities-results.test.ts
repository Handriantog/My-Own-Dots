import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OwnerResultStore } from '../../src/desktop/host/abilities/results.ts';
import {
  desktopAbilityMethods,
  ownerViewSchema,
} from '../../src/shared/abilities/desktop.ts';
import type {
  InvocationContext,
  OwnerResult,
} from '../../src/shared/abilities/types.ts';
const context = (): InvocationContext => ({
  workspaceId: 'workspace',
  sessionId: 'session',
  dotId: 'dot',
  bindingId: randomUUID(),
  digest: 'a'.repeat(64),
  grantRevision: 1,
  invocationId: randomUUID(),
  threadId: 'thread',
  tool: 'search',
});
const result: OwnerResult = {
  kind: 'list',
  title: 'OWNER_ONLY_SENTINEL',
  items: [
    {
      label: '<script>OWNER_ONLY_SENTINEL</script>',
      url: 'https://open.spotify.com/track/example',
      action: { uri: 'spotify:track:PRIVATE_ID' },
    },
  ],
};
describe('transient owner results', () => {
  it('rejects injected authority in desktop requests and private action data in UI replies', () => {
    expect(() =>
      desktopAbilityMethods.select.input.parse({
        dotId: 'dot',
        handle: randomUUID(),
        itemId: randomUUID(),
        digest: 'a'.repeat(64),
      }),
    ).toThrow();
    expect(() =>
      ownerViewSchema.parse({
        kind: 'list',
        title: 'List',
        items: [
          {
            id: randomUUID(),
            label: 'Item',
            selectable: true,
            action: { uri: 'private' },
          },
        ],
      }),
    ).toThrow();
  });
  it('mints opaque item/selection handles and keeps action data out of the owner view', () => {
    const store = new OwnerResultStore(),
      ctx = context(),
      handle = store.put(ctx, result);
    const view = store.read(ctx.dotId, handle)!;
    expect(store.read('other-dot', handle)).toBeUndefined();
    expect(view.kind).toBe('list');
    if (view.kind !== 'list') throw new Error('list');
    expect(view.items[0].label).toBe(result.items[0].label);
    expect(JSON.stringify(view)).not.toContain('PRIVATE_ID');
    const selection = store.select(ctx.dotId, handle, view.items[0].id);
    expect(selection).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      store.take({ ...ctx, dotId: 'other-dot' }, selection),
    ).toBeUndefined();
    expect(
      store.take(
        { ...ctx, invocationId: randomUUID(), tool: 'play' },
        selection,
      ),
    ).toEqual({ uri: 'spotify:track:PRIVATE_ID' });
    expect(store.take(ctx, selection)).toBeUndefined();
  });
  it.each([
    'workspaceId',
    'sessionId',
    'threadId',
    'bindingId',
    'digest',
    'grantRevision',
  ])('rejects a selection across %s', (field) => {
    const store = new OwnerResultStore(),
      ctx = context(),
      handle = store.put(ctx, result);
    const view = store.read(ctx.dotId, handle)!;
    if (view.kind !== 'list') throw new Error('list');
    const selection = store.select(ctx.dotId, handle, view.items[0].id);
    expect(
      store.take(
        { ...ctx, [field]: field === 'grantRevision' ? 2 : 'different' },
        selection,
      ),
    ).toBeUndefined();
  });
  it('expires results and selections exactly at ten minutes', () => {
    let now = 100;
    const store = new OwnerResultStore({ now: () => now });
    const ctx = context(),
      handle = store.put(ctx, result);
    const view = store.read(ctx.dotId, handle)!;
    if (view.kind !== 'list') throw new Error('list');
    const selection = store.select(ctx.dotId, handle, view.items[0].id);
    now += 599999;
    expect(store.read(ctx.dotId, handle)).toBeDefined();
    now++;
    expect(store.read(ctx.dotId, handle)).toBeUndefined();
    expect(store.take(ctx, selection)).toBeUndefined();
  });
  it('clears a binding and quit state, evicts bounded results, and returns defensive copies', () => {
    const store = new OwnerResultStore({ maxResults: 2 }),
      a = context(),
      b = context();
    b.dotId = 'b';
    const first = store.put(a, result),
      second = store.put(b, result);
    store.put(b, result);
    expect(store.read(a.dotId, first)).toBeUndefined();
    const view = store.read(b.dotId, second)!;
    if (view.kind !== 'list') throw new Error('list');
    view.items[0].label = 'changed';
    expect(store.read(b.dotId, second)).not.toEqual(view);
    store.clearBinding(a.bindingId);
    expect(store.read(b.dotId, second)).toBeDefined();
    store.clear();
    expect(store.read(b.dotId, second)).toBeUndefined();
  });
  it.each([
    'javascript:alert(1)',
    'https://127.0.0.1/private',
    'https://user:password@example.com/',
    'https://example.com:444/',
  ])('rejects unsafe UI links: %s', (url) => {
    expect(() =>
      new OwnerResultStore().put(context(), {
        ...result,
        items: [{ label: 'Link', url }],
      }),
    ).toThrow();
  });
  it('rejects oversized payloads and unknown markup fields', () => {
    const store = new OwnerResultStore();
    expect(() =>
      store.put(context(), { kind: 'text', text: 'a'.repeat(1024 * 1024) }),
    ).toThrow();
    expect(() =>
      store.put(context(), {
        kind: 'text',
        text: 'safe',
        html: '<img>',
      } as OwnerResult),
    ).toThrow();
  });
});
