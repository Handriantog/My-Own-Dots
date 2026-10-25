import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { AbilityActivities } from '../../src/desktop/host/abilities/activities';
import { parseManifest } from '../../src/shared/abilities/manifest';
import type {
  Binding,
  InvocationContext,
} from '../../src/shared/abilities/types';
import type {
  ActivityDriver,
  ActivityStatus,
} from '../../src/shared/abilities/activity';
import { ActivityDriverFailure } from '../../src/shared/abilities/activity';
import fixture from '../fixtures/abilities/manifest.json';
import activity from '../fixtures/abilities/activity.json';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  vi.useRealTimers();
});
function setup() {
  const manifest = parseManifest({
    ...fixture,
    activities: [activity],
    tools: fixture.tools.map((t) => ({ ...t, execution: 'interactive' })),
    permissions: [
      {
        id: 'motion',
        kind: 'companion-activity',
        purpose: 'Fixture',
        activities: ['orbit'],
        pointer: true,
        keepAwake: 'display',
      },
    ],
  });
  const binding: Binding = {
    id: randomUUID(),
    dotId: 'dot',
    digest: 'a'.repeat(64),
    manifest,
    grants: ['motion'],
    settings: {},
    revision: 1,
    enabled: true,
    restored: false,
    approvedAt: 1,
  };
  const context: InvocationContext = {
    workspaceId: 'workspace',
    sessionId: 'session',
    bindingId: binding.id,
    dotId: 'dot',
    digest: binding.digest,
    grantRevision: 1,
    invocationId: randomUUID(),
    threadId: 'thread',
    tool: 'search',
    interactive: true,
  };
  let owner: string | undefined,
    state: ActivityStatus = 'inactive',
    starts = 0,
    allowed = true;
  let starting: Promise<void> = Promise.resolve();
  const driver: ActivityDriver = {
    async start(who) {
      starts++;
      owner = who.bindingId;
      state = 'approaching';
      await starting;
    },
    async stop(id) {
      if (!id || owner === id) {
        state = 'inactive';
        owner = undefined;
      }
    },
    status(id) {
      return owner === id ? state : 'inactive';
    },
  };
  const broker = new AbilityActivities({
    driver: () => driver,
    authorize: async () => binding,
    renew: async () => {
      if (!allowed) throw Error('revoked');
      return binding;
    },
  });
  cleanups.push(() => broker.stop());
  const request = (
    action: 'start' | 'stop' | 'status',
    ctx = context,
    signal = new AbortController().signal,
    activityId = 'orbit',
    ruleId = 'motion',
  ) =>
    broker.request(
      ctx,
      { kind: 'companion-activity', ruleId, command: { action, activityId } },
      signal,
    );
  return {
    broker,
    binding,
    context,
    request,
    driver,
    starts: () => starts,
    state: () => state,
    revoke: () => {
      allowed = false;
    },
    starting: (p: Promise<void>) => {
      starting = p;
    },
  };
}
it('keeps a successful start after completion and handles duplicate starts and stops', async () => {
  const f = setup();
  expect(await f.request('start')).toMatchObject({ status: 'approaching' });
  await f.broker.finish(f.context.invocationId, true);
  await f.request('start', { ...f.context, invocationId: randomUUID() });
  expect(f.starts()).toBe(1);
  expect(await f.request('status')).toMatchObject({ status: 'approaching' });
  await f.request('stop');
  await f.request('stop');
  expect(f.state()).toBe('inactive');
});
it.each(['failure', 'cancel'])(
  'rolls back provisional start on %s',
  async (reason) => {
    const f = setup(),
      c = new AbortController();
    await f.request('start', f.context, c.signal);
    if (reason === 'cancel') c.abort();
    await f.broker.finish(f.context.invocationId, false);
    expect(f.state()).toBe('inactive');
  },
);
it('reports inactive after rolling back an unsuccessful provisional start', async () => {
  const f = setup();
  await f.request('start');
  expect(await f.broker.finish(f.context.invocationId, false)).toEqual({
    action: 'start',
    status: 'inactive',
  });
});
it('consumes a trusted refusal after retiring an in-flight start', async () => {
  const f = setup();
  let deny!: () => void;
  f.starting(
    new Promise<void>((_resolve, reject) => {
      deny = () => reject(new ActivityDriverFailure('setup_needed'));
    }),
  );
  const requested = f.request('start').catch((error: unknown) => error);
  await vi.waitFor(() => expect(f.starts()).toBe(1));
  const finished = f.broker.finish(f.context.invocationId, false);
  deny();
  expect(await requested).toMatchObject({ code: 'setup_needed' });
  expect(await finished).toEqual({
    action: 'start',
    status: 'inactive',
    reason: 'accessibility_required',
  });
  expect(f.state()).toBe('inactive');
  expect(await f.broker.finish(f.context.invocationId, false)).toBeUndefined();
  const later = { ...f.context, invocationId: randomUUID() };
  await f.request('status', later);
  expect(await f.broker.finish(later.invocationId, true)).toEqual({
    action: 'status',
    status: 'inactive',
  });
});
it.each(['status', 'stop', 'start'] as const)(
  'keeps a trusted start refusal through a later %s in the same invocation',
  async (action) => {
    const f = setup();
    const start = f.driver.start;
    f.driver.start = async () => {
      throw new ActivityDriverFailure('setup_needed');
    };
    await expect(f.request('start')).rejects.toMatchObject({
      code: 'setup_needed',
    });
    f.driver.start = start;
    await f.request(action);
    expect(await f.broker.finish(f.context.invocationId, true)).toEqual({
      action: 'start',
      status: 'inactive',
      reason: 'accessibility_required',
    });
    expect(f.state()).toBe('inactive');
    expect(
      await f.broker.finish(f.context.invocationId, false),
    ).toBeUndefined();
    const later = { ...f.context, invocationId: randomUUID() };
    await f.request('start', later);
    expect(await f.broker.finish(later.invocationId, true)).toEqual({
      action: 'start',
      status: 'approaching',
    });
  },
);
it('does not transfer ownership to a later failing query or duplicate start', async () => {
  const f = setup();
  await f.request('start');
  await f.broker.finish(f.context.invocationId, true);
  const later = { ...f.context, invocationId: randomUUID() };
  await f.request('start', later);
  await f.request('status', later);
  await f.broker.finish(later.invocationId, false);
  await f.broker.cancel(later.invocationId);
  expect(f.state()).toBe('approaching');
  await f.broker.cancel(f.context.invocationId);
  expect(f.state()).toBe('inactive');
});
it('stops a start racing activation before releasing ownership', async () => {
  const f = setup();
  let release!: () => void;
  f.starting(
    new Promise((r) => {
      release = r;
    }),
  );
  const start = f.request('start').catch(() => {});
  await vi.waitFor(() => expect(f.starts()).toBe(1));
  const stop = f.request('stop');
  release();
  await Promise.all([start, stop]);
  expect(f.state()).toBe('inactive');
});
it('rejects competing binding ownership and reconciles a native stop', async () => {
  const f = setup();
  await f.request('start');
  await f.broker.finish(f.context.invocationId, true);
  const other = {
    ...f.context,
    bindingId: randomUUID(),
    invocationId: randomUUID(),
  };
  f.binding.id = other.bindingId;
  await expect(f.request('start', other)).rejects.toMatchObject({
    code: 'busy',
  });
  await f.driver.stop();
  await f.request('start', other);
  expect(f.starts()).toBe(2);
});
it.each(['interactive', 'grant', 'activity', 'rule'])(
  'denies missing %s authority',
  async (kind) => {
    const f = setup();
    if (kind === 'grant') f.binding.grants = [];
    await expect(
      f.request(
        'start',
        {
          ...f.context,
          ...(kind === 'interactive' ? { interactive: false } : {}),
        },
        undefined,
        kind === 'activity' ? 'missing' : 'orbit',
        kind === 'rule' ? 'missing' : 'motion',
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(f.starts()).toBe(0);
  },
);
it('renews after invocation completion and retires a revoked lease', async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.request('start');
  await f.broker.finish(f.context.invocationId, true);
  await vi.advanceTimersByTimeAsync(600);
  expect(f.state()).toBe('approaching');
  f.revoke();
  await vi.advanceTimersByTimeAsync(600);
  expect(f.state()).toBe('inactive');
});
it('bounds a hung authority renewal', async () => {
  vi.useFakeTimers();
  const f = setup();
  const broker = new AbilityActivities({
    driver: () => f.driver,
    authorize: async () => f.binding,
    renew: () => new Promise(() => {}),
  });
  cleanups.push(() => broker.stop());
  await broker.request(
    f.context,
    {
      kind: 'companion-activity',
      ruleId: 'motion',
      command: { action: 'start', activityId: 'orbit' },
    },
    new AbortController().signal,
  );
  await broker.finish(f.context.invocationId, true);
  await vi.advanceTimersByTimeAsync(2500);
  expect(f.state()).toBe('inactive');
});
it('does not start after cancellation while reconciling native retirement', async () => {
  const f = setup();
  await f.request('start');
  await f.broker.finish(f.context.invocationId, true);
  await f.driver.stop();
  const stop = f.driver.stop.bind(f.driver);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.driver.stop = async (id) => {
    await gate;
    await stop(id);
  };
  const c = new AbortController();
  const restarting = f
    .request('start', { ...f.context, invocationId: randomUUID() }, c.signal)
    .catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  c.abort();
  release();
  await restarting;
  expect(f.starts()).toBe(1);
});
