import { expect, it } from 'vitest';
import { CodexExecutionCoordinator } from '../src/server/codex-runtime.js';

it('serializes voice and text work for the same Dot while other Dots remain independent', async () => {
  const coordinator = new CodexExecutionCoordinator();
  const controller = new AbortController();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const voice = coordinator.run('dot', 'voice', controller.signal, async () => {
    order.push('voice');
    await gate;
    order.push('voice done');
  });
  const text = coordinator.run('dot', 'text', controller.signal, async () => {
    order.push('text');
  });
  await coordinator.run('other', 'other', controller.signal, async () => {
    order.push('other');
  });
  expect(order).toEqual(['voice', 'other']);
  expect(coordinator.status('dot')).toMatchObject({
    activeRunId: 'voice',
    queued: 1,
  });
  release();
  await Promise.all([voice, text]);
  expect(order).toEqual(['voice', 'other', 'voice done', 'text']);
});

it('removes cancelled queued work without dispatching it or losing the active run', async () => {
  const coordinator = new CodexExecutionCoordinator();
  let release!: () => void;
  const active = coordinator.run(
    'dot',
    'first',
    new AbortController().signal,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  let dispatched = false;
  const queued = coordinator.run(
    'dot',
    'queued',
    controller.signal,
    async () => {
      dispatched = true;
    },
  );
  controller.abort();
  await expect(queued).rejects.toThrow();
  expect(dispatched).toBe(false);
  release();
  await active;
});

it('rejects a repeated run identity instead of repeating its mutations', async () => {
  const coordinator = new CodexExecutionCoordinator();
  const signal = new AbortController().signal;
  let calls = 0;
  await coordinator.run('dot', 'same-run', signal, async () => {
    calls++;
  });
  await expect(
    coordinator.run('dot', 'same-run', signal, async () => {
      calls++;
    }),
  ).rejects.toThrow(/already|duplicate/i);
  expect(calls).toBe(1);
});

it('reserves the executor for a resumed approval and releases it without dispatching cancelled waits', async () => {
  const coordinator = new CodexExecutionCoordinator();
  const signal = new AbortController().signal;
  const release = await coordinator.acquire(
    'dot',
    'first',
    signal,
    'first-thread',
  );
  const controller = new AbortController();
  const waiting = coordinator.acquire(
    'dot',
    'cancelled',
    controller.signal,
    'cancelled-thread',
  );
  expect(coordinator.status('dot')).toMatchObject({
    activeRunId: 'first',
    queued: 1,
  });
  controller.abort();
  await expect(waiting).rejects.toThrow();
  const next = coordinator.acquire('dot', 'next', signal, 'next-thread');
  await release();
  const releaseNext = await next;
  expect(coordinator.status('dot')).toMatchObject({
    activeRunId: 'next',
    activeThreadId: 'next-thread',
  });
  await releaseNext();
});
