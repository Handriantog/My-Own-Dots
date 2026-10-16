import { expect, it } from 'vitest';
import { InferenceScheduler } from '../src/server/inference-scheduler.js';
it('cancels background inference and reserves the provider for the whole interactive turn', async () => {
  const scheduler = new InferenceScheduler(),
    signal = new AbortController().signal;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let backgroundSignal!: AbortSignal;
  const background = scheduler
    .run('dream', signal, async (s) => {
      backgroundSignal = s;
      started();
      await new Promise<void>((_, reject) =>
        s.addEventListener('abort', () => reject(s.reason), { once: true }),
      );
    })
    .catch(() => 'cancelled');
  await ready;
  const release = await scheduler.enterForeground(signal);
  expect(backgroundSignal.aborted).toBe(true);
  expect(await background).toBe('cancelled');
  const order: string[] = [];
  const queued = scheduler.run('dream', signal, async () => {
    order.push('dream');
  });
  await scheduler.run('foreground', signal, async () => {
    order.push('chat');
  });
  await Promise.resolve();
  expect(order).toEqual(['chat']);
  release();
  await queued;
  expect(order).toEqual(['chat', 'dream']);
  await scheduler.close();
});
it('removes cancelled pending work and rejects admission after close', async () => {
  const scheduler = new InferenceScheduler(),
    controller = new AbortController();
  const release = await scheduler.enterForeground(new AbortController().signal);
  let executed = false;
  const queued = scheduler.run('compact', controller.signal, async () => {
    executed = true;
  });
  controller.abort();
  await expect(queued).rejects.toThrow();
  release();
  await scheduler.close();
  expect(executed).toBe(false);
  await expect(
    scheduler.run('foreground', new AbortController().signal, async () => 1),
  ).rejects.toThrow(/closed/i);
});

it('routes maintenance inference through the same foreground reservation', async () => {
  const { MemoryInference } = await import('../src/server/memory-inference.js');
  const scheduler = new InferenceScheduler(),
    signal = new AbortController().signal;
  const release = await scheduler.enterForeground(signal);
  let executed = false;
  const inference = new MemoryInference(
    { provider: 'codex' },
    async () => {
      executed = true;
      return { result: { ok: true }, usage: {} };
    },
    scheduler,
  );
  const pending = inference.run({
    purpose: 'dream',
    prompt: 'Evidence',
    schema: { type: 'object' },
    signal,
    timeoutMs: 1000,
  });
  await Promise.resolve();
  expect(executed).toBe(false);
  release();
  expect(await pending).toEqual({ ok: true });
  await scheduler.close();
});
