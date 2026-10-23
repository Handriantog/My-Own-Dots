import { describe, expect, it } from 'vitest';
import { AbilityAppControl } from '../../src/desktop/host/abilities/app-control';
import { AbilityFailure } from '../../src/shared/abilities/bridge';
import { parseManifest } from '../../src/shared/abilities/manifest';
import manifestFixture from '../fixtures/abilities/manifest.json';
import type {
  Binding,
  InvocationContext,
} from '../../src/shared/abilities/types';

const context = {
  workspaceId: 'w',
  sessionId: 's',
  dotId: 'dot',
  bindingId: 'binding',
  digest: 'a'.repeat(64),
  grantRevision: 1,
  invocationId: 'invoke',
  tool: 'play',
  threadId: 'thread',
} satisfies InvocationContext;
function fixture() {
  const binding: Binding = {
    id: 'binding',
    dotId: 'dot',
    digest: context.digest,
    revision: 1,
    enabled: true,
    restored: false,
    approvedAt: 1,
    settings: {},
    grants: ['player'],
    manifest: parseManifest({
      ...manifestFixture,
      permissions: [
        {
          id: 'player',
          kind: 'app-control',
          application: 'com.spotify.client',
          actions: ['play', 'pause', 'volume'],
          purpose: 'Control Spotify.',
        },
      ],
    }),
  };
  return binding;
}
const request = {
  kind: 'app-control' as const,
  ruleId: 'player',
  command: { action: 'play' as const },
};
describe('application command broker', () => {
  it('blocks previously bound mixed-visibility packages before reading private data', async () => {
    const binding = fixture(),
      effects: string[] = [];
    binding.manifest.tools.push({
      ...binding.manifest.tools[0],
      id: 'forward_private_state',
      visibility: 'model-visible',
    });
    const broker = new AbilityAppControl({
      authorize: async () => binding,
      dispatch: async (command) => {
        effects.push(command.action);
        return {
          ok: true,
          kind: 'app-control',
          status: 'success',
          result: { kind: 'text', text: 'PRIVATE_SPOTIFY_SENTINEL' },
        };
      },
    });
    expect(
      await broker.request(context, request, new AbortController().signal),
    ).toEqual({ ok: false, code: 'permission_denied' });
    expect(effects).toEqual([]);
  });
  it('executes only approved application actions', async () => {
    const binding = fixture(),
      effects: string[] = [];
    const broker = new AbilityAppControl({
      authorize: async () => binding,
      dispatch: async (command) => {
        effects.push(command.action);
        return { ok: true, kind: 'app-control', status: 'success' };
      },
    });
    expect(
      await broker.request(context, request, new AbortController().signal),
    ).toEqual({ ok: true, kind: 'app-control', status: 'success' });
    binding.grants = [];
    expect(
      await broker.request(context, request, new AbortController().signal),
    ).toEqual({ ok: false, code: 'permission_denied' });
    binding.grants = ['player'];
    expect(
      await broker.request(
        context,
        {
          ...request,
          command: { action: 'search', query: 'song', category: 'tracks' },
        },
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, code: 'permission_denied' });
    expect(effects).toEqual(['play']);
  });
  it('rejects malformed commands before any side effect', async () => {
    const effects: string[] = [];
    const broker = new AbilityAppControl({
      authorize: async () => fixture(),
      dispatch: async (command) => {
        effects.push(command.action);
        return { ok: true, kind: 'app-control', status: 'success' };
      },
    });
    expect(
      (
        await broker.request(
          context,
          { ...request, command: { action: 'volume', percent: 101 } } as never,
          new AbortController().signal,
        )
      ).ok,
    ).toBe(false);
    expect(effects).toEqual([]);
  });
  it('rechecks authority after waiting for another command', async () => {
    let release!: () => void,
      revoked = false;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effects: string[] = [];
    const broker = new AbilityAppControl({
      authorize: async (c) => {
        if (c.invocationId === 'second' && revoked)
          throw new AbilityFailure('permission_denied');
        return fixture();
      },
      dispatch: async (command) => {
        effects.push(command.action);
        await blocked;
        return { ok: true, kind: 'app-control', status: 'success' };
      },
    });
    const first = broker.request(
      context,
      request,
      new AbortController().signal,
    );
    const second = broker.request(
      { ...context, invocationId: 'second' },
      request,
      new AbortController().signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    revoked = true;
    release();
    await first;
    expect(await second).toEqual({ ok: false, code: 'permission_denied' });
    expect(effects).toEqual(['play']);
  });
  it('keeps unknown delivery uncertain and never retries', async () => {
    let effects = 0;
    const broker = new AbilityAppControl({
      authorize: async () => fixture(),
      dispatch: async () => {
        effects++;
        throw new Error('lost after send');
      },
    });
    expect(
      await broker.request(context, request, new AbortController().signal),
    ).toEqual({ ok: true, kind: 'app-control', status: 'uncertain' });
    expect(effects).toBe(1);
  });
  it('aborts before dispatch and discards a late success after cancellation', async () => {
    let effects = 0;
    const controller = new AbortController();
    const broker = new AbilityAppControl({
      authorize: async () => fixture(),
      dispatch: async () => {
        effects++;
        controller.abort();
        return { ok: true, kind: 'app-control', status: 'success' };
      },
    });
    expect(await broker.request(context, request, controller.signal)).toEqual({
      ok: true,
      kind: 'app-control',
      status: 'uncertain',
    });
    expect((await broker.request(context, request, controller.signal)).ok).toBe(
      false,
    );
    expect(effects).toBe(1);
  });
  it('returns a known OS permission denial without raw native error text', async () => {
    const broker = new AbilityAppControl({
      authorize: async () => fixture(),
      dispatch: async () => ({ ok: false, code: 'permission_denied' }),
    });
    expect(
      await broker.request(context, request, new AbortController().signal),
    ).toEqual({ ok: false, code: 'permission_denied' });
  });
});
