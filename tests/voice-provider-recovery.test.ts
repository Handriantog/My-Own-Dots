import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VoiceProviderSession } from '../src/server/local-voice/inference.js';

const engine = vi.hoisted(() => ({
  warm: vi.fn(),
  runDecision: vi.fn(),
  close: vi.fn(),
}));
vi.mock('myown-llm-integrator', async (original) => ({
  ...(await original<object>()),
  createProviderSession: () => engine,
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const request = () => ({
  prompt: 'private conversation',
  toolNames: [],
  signal: new AbortController().signal,
});
const response = {
  result: { text: 'Hello.', toolCalls: [] },
  usage: {},
  timings: {},
};
beforeEach(() => {
  vi.resetAllMocks();
  engine.warm.mockResolvedValue({ startupMs: 1 });
  engine.close.mockResolvedValue(undefined);
  engine.runDecision.mockImplementation(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Error('cancelled')), {
          once: true,
        });
      }),
  );
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
async function interrupted() {
  const session = new VoiceProviderSession('call');
  const lifetime = new AbortController();
  await session.warm(lifetime.signal);
  const warm = deferred<{ startupMs: number }>();
  engine.warm.mockReturnValueOnce(warm.promise);
  const controller = new AbortController();
  const pending = session.runDecision({
    ...request(),
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
  return { session, lifetime, warm };
}
it('warms immediately after cancellation and shares that warmup with the next request', async () => {
  const f = await interrupted();
  try {
    expect(engine.warm).toHaveBeenCalledTimes(2);
    const warmSignal = engine.warm.mock.calls[1][0].signal;
    expect(warmSignal.aborted).toBe(false);
    engine.runDecision.mockResolvedValueOnce(response);
    const pending = f.session.runDecision(request());
    await Promise.resolve();
    expect(engine.runDecision).toHaveBeenCalledTimes(1);
    f.warm.resolve({ startupMs: 1000 });
    await expect(pending).resolves.toEqual(response);
    expect(engine.warm).toHaveBeenCalledTimes(2);
  } finally {
    await f.session.close();
  }
});
it('a second interruption cancels only its waiting request and never duplicates warmup', async () => {
  const f = await interrupted();
  try {
    const controller = new AbortController();
    const waiting = f.session.runDecision({
      ...request(),
      signal: controller.signal,
    });
    await expect(f.session.runDecision(request())).rejects.toThrow(/progress/);
    controller.abort(Error('second interruption'));
    await expect(waiting).rejects.toThrow('second interruption');
    expect(engine.warm.mock.calls[1][0].signal.aborted).toBe(false);
    expect(engine.runDecision).toHaveBeenCalledTimes(1);
    f.warm.resolve({ startupMs: 1 });
    engine.runDecision.mockResolvedValueOnce(response);
    await expect(f.session.runDecision(request())).resolves.toEqual(response);
    expect(engine.warm).toHaveBeenCalledTimes(2);
  } finally {
    await f.session.close();
  }
});
it('hangup aborts recovery and prevents any later inference or resurrection', async () => {
  const f = await interrupted();
  await f.session.close();
  expect(engine.warm.mock.calls[1][0].signal.aborted).toBe(true);
  f.warm.resolve({ startupMs: 1 });
  await expect(f.session.runDecision(request())).rejects.toThrow();
  expect(engine.runDecision).toHaveBeenCalledTimes(1);
  expect(engine.close).toHaveBeenCalledTimes(1);
});
it('call lifetime cancellation does not start a replacement', async () => {
  const session = new VoiceProviderSession('call');
  const lifetime = new AbortController();
  await session.warm(lifetime.signal);
  const controller = new AbortController();
  const pending = session.runDecision({
    ...request(),
    signal: controller.signal,
  });
  lifetime.abort();
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(engine.warm).toHaveBeenCalledTimes(1);
  await session.close();
});
it('surfaces a failed recovery once, with no unhandled rejection or automatic retry', async () => {
  const f = await interrupted();
  try {
    f.warm.reject(Error('recovery failed'));
    await new Promise((resolve) => setImmediate(resolve));
    await expect(f.session.runDecision(request())).rejects.toThrow(
      'recovery failed',
    );
    expect(engine.warm).toHaveBeenCalledTimes(2);
    expect(engine.runDecision).toHaveBeenCalledTimes(1);
    // The failed warmup is reported once. A later explicit request may recover;
    // no request is replayed and no background inference is started.
    engine.runDecision.mockResolvedValueOnce(response);
    await expect(f.session.runDecision(request())).resolves.toEqual(response);
    expect(engine.runDecision).toHaveBeenCalledTimes(2);
    expect(engine.warm).toHaveBeenCalledTimes(2);
  } finally {
    await f.session.close();
  }
});
it('does not prewarm or retry after an ordinary provider failure', async () => {
  const session = new VoiceProviderSession('call');
  await session.warm(new AbortController().signal);
  engine.runDecision.mockRejectedValueOnce(Error('provider failure'));
  await expect(session.runDecision(request())).rejects.toThrow(
    'provider failure',
  );
  expect(engine.warm).toHaveBeenCalledTimes(1);
  expect(engine.runDecision).toHaveBeenCalledTimes(1);
  await session.close();
});
