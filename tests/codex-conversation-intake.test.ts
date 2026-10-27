import { afterEach, expect, it, vi } from 'vitest';
import type {
  createExecutionSession,
  ExecutionEvent,
  ExecutionResult,
  ExecutionSession,
} from 'myown-llm-integrator';
import {
  codexConversationIntake,
  CodexConversationSession,
} from '../src/server/local-voice/codex-conversation-intake.js';

type SessionOptions = NonNullable<Parameters<typeof createExecutionSession>[0]>;
const provider = vi.hoisted(() => ({
  create: vi.fn(),
  run: vi.fn(),
  close: vi.fn(async () => {}),
  warm: vi.fn(async () => ({ version: 'fixture', nativeExecution: false })),
  events: vi.fn<(result: ExecutionResult) => ExecutionEvent[]>(),
}));
vi.mock('myown-llm-integrator', () => ({
  createExecutionSession: provider.create,
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
function completed(
  reply = 'Hello.',
  needsTask = false,
  usesTaskStatus = false,
): ExecutionResult {
  return {
    status: 'completed',
    text: JSON.stringify({ reply, needsTask, usesTaskStatus }),
    evidence: [],
  };
}
function fixture() {
  let options!: SessionOptions;
  provider.create.mockImplementation((value: SessionOptions) => {
    options = value;
    return {
      run: async (input: Parameters<ExecutionSession['run']>[0]) => {
        const result: ExecutionResult = await provider.run(input);
        for (const event of provider.events(result))
          await input.onEvent?.(event);
        return result;
      },
      close: provider.close,
      warm: provider.warm,
    };
  });
  provider.events.mockImplementation((result) => [
    { type: 'message', id: 'final', text: result.text, final: true },
  ]);
  provider.run.mockResolvedValue(completed());
  const request = {
    caption: 'How are you?',
    instructions: 'You are Whimsy.',
    context: {
      ownerMessages: [{ role: 'user', text: 'Hello' }],
      tasks: [],
      pending: [],
      executionBusy: false,
    },
    signal: new AbortController().signal,
  };
  return { request, options: () => options };
}

it.each([false, true])(
  'accepts a validated needsTask=%s decision without granting any tool or execution scope',
  async (needsTask) => {
    const f = fixture();
    provider.run.mockResolvedValue(completed('A contextual reply.', needsTask));
    expect(await codexConversationIntake(f.request)).toEqual({
      reply: 'A contextual reply.',
      needsTask,
      usesTaskStatus: false,
    });
    expect(f.options()).not.toHaveProperty('scope');
    expect(f.options()).not.toHaveProperty('onTool');
    expect(f.options().tools).toEqual([]);
    expect(f.options().reasoningEffort).toBe('low');
    expect(JSON.parse(provider.run.mock.calls[0][0].input)).toEqual({
      caption: 'How are you?',
      personaInstructions: 'You are Whimsy.',
      context: {
        ownerMessages: [{ role: 'user', text: 'Hello' }],
        tasks: [],
        pending: [],
        executionBusy: false,
      },
    });
    expect(provider.close).toHaveBeenCalledOnce();
  },
);

it.each([
  '',
  'Not a decision.',
  '```json\n{"reply":"Hello","needsTask":false,"usesTaskStatus":false}\n```',
  '{}',
  'null',
  '[]',
  JSON.stringify({ reply: '', needsTask: true, usesTaskStatus: false }),
  JSON.stringify({ reply: '   ', needsTask: true, usesTaskStatus: false }),
  JSON.stringify({
    reply: 'x'.repeat(401),
    needsTask: true,
    usesTaskStatus: false,
  }),
  JSON.stringify({ reply: 'Hello', needsTask: 'false', usesTaskStatus: false }),
  JSON.stringify({ reply: 'Hello', needsTask: false }),
  JSON.stringify({ reply: 'Hello', needsTask: false, usesTaskStatus: 'false' }),
  JSON.stringify({
    reply: 'Hello',
    needsTask: false,
    usesTaskStatus: false,
    cancel: true,
  }),
  JSON.stringify({
    reply: 'Hello',
    needsTask: false,
    usesTaskStatus: false,
    request: 'rewritten action',
  }),
])('rejects malformed or unauthorized decision output: %s', async (text) => {
  const f = fixture();
  provider.run.mockResolvedValue({ status: 'completed', text, evidence: [] });
  await expect(codexConversationIntake(f.request)).rejects.toThrow(/decision/i);
  expect(provider.close).toHaveBeenCalledOnce();
});

it.each([false, true])(
  'preserves a status dependency independently of needsTask=%s',
  async (needsTask) => {
    const f = fixture();
    provider.run.mockResolvedValue(
      completed('Your earlier task is still running.', needsTask, true),
    );
    expect(await codexConversationIntake(f.request)).toEqual({
      reply: 'Your earlier task is still running.',
      needsTask,
      usesTaskStatus: true,
    });
  },
);

it.each(['failed', 'uncertain', 'cancelled', 'paused'])(
  'does not release a decision from a %s provider turn',
  async (status) => {
    const f = fixture();
    provider.run.mockResolvedValue({ ...completed(), status });
    await expect(codexConversationIntake(f.request)).rejects.toThrow(
      /complete/i,
    );
  },
);

it('rejects commentary-only fallback text even when the adapter says completed', async () => {
  const f = fixture();
  provider.events.mockImplementation((result) => [
    { type: 'message', id: 'commentary', text: result.text, final: false },
  ]);
  await expect(codexConversationIntake(f.request)).rejects.toThrow(/final/i);
});

it('parses only the explicit final message, not the adapter fallback text', async () => {
  const f = fixture();
  provider.events.mockReturnValue([
    {
      type: 'message',
      id: 'final',
      text: JSON.stringify({
        reply: 'Authoritative final.',
        needsTask: true,
        usesTaskStatus: false,
      }),
      final: true,
    },
  ]);
  expect(await codexConversationIntake(f.request)).toEqual({
    reply: 'Authoritative final.',
    needsTask: true,
    usesTaskStatus: false,
  });
});

it('rejects conflicting final messages rather than choosing an arbitrary decision', async () => {
  const f = fixture();
  provider.events.mockReturnValue([
    {
      type: 'message',
      id: 'first',
      text: completed('First.', false).text,
      final: true,
    },
    {
      type: 'message',
      id: 'second',
      text: completed('Second.', true).text,
      final: true,
    },
  ]);
  await expect(codexConversationIntake(f.request)).rejects.toThrow(/final/i);
});

it('warms one process and supplies fresh context and persona in every turn', async () => {
  const f = fixture();
  const session = new CodexConversationSession();
  await session.warm(f.request.signal);
  await session.run(f.request);
  await session.run({
    ...f.request,
    caption: 'Are you still reviewing?',
    instructions: 'You are a concise reviewer.',
    context: { tasks: [{ status: 'running' }] },
  });
  expect(provider.create).toHaveBeenCalledOnce();
  expect(provider.warm).toHaveBeenCalledOnce();
  expect(provider.close).not.toHaveBeenCalled();
  expect(
    provider.run.mock.calls.map(([value]) => JSON.parse(value.input)),
  ).toEqual([
    {
      caption: 'How are you?',
      personaInstructions: 'You are Whimsy.',
      context: {
        ownerMessages: [{ role: 'user', text: 'Hello' }],
        tasks: [],
        pending: [],
        executionBusy: false,
      },
    },
    {
      caption: 'Are you still reviewing?',
      personaInstructions: 'You are a concise reviewer.',
      context: { tasks: [{ status: 'running' }] },
    },
  ]);
  await session.close();
  await session.close();
  expect(provider.close).toHaveBeenCalledOnce();
});

it('retires a failed process and recreates it only for a new request', async () => {
  const f = fixture();
  provider.run.mockResolvedValueOnce({
    status: 'uncertain',
    text: '',
    evidence: [],
  });
  provider.run.mockResolvedValueOnce(completed('Hello again.'));
  const session = new CodexConversationSession();
  await expect(session.run(f.request)).rejects.toThrow(/complete/i);
  expect(provider.run).toHaveBeenCalledOnce();
  expect(provider.close).toHaveBeenCalledOnce();
  expect(
    await session.run({ ...f.request, caption: 'Another question.' }),
  ).toEqual({ reply: 'Hello again.', needsTask: false, usesTaskStatus: false });
  expect(provider.create).toHaveBeenCalledTimes(2);
  expect(provider.run).toHaveBeenCalledTimes(2);
  await session.close();
  expect(provider.close).toHaveBeenCalledTimes(2);
});

it('honors cancellation before creating a provider session', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort(new Error('Stopped by owner.'));
  await expect(
    codexConversationIntake({ ...f.request, signal: controller.signal }),
  ).rejects.toThrow('Stopped by owner.');
  expect(provider.create).not.toHaveBeenCalled();
});

it('drops a valid decision if the owner cancels during standalone cleanup', async () => {
  const f = fixture();
  const controller = new AbortController();
  let release!: () => void;
  provider.close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const result = codexConversationIntake({
    ...f.request,
    signal: controller.signal,
  }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(provider.close).toHaveBeenCalledOnce());
  controller.abort(new Error('Owner interrupted the reply.'));
  expect(await result).toEqual(new Error('Owner interrupted the reply.'));
  release();
  expect(provider.close).toHaveBeenCalledOnce();
});

it('times out stalled startup without waiting for cleanup or accepting a late reply', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let settle!: (value: ExecutionResult) => void;
  provider.run.mockImplementation(
    () =>
      new Promise<ExecutionResult>((resolve) => {
        settle = resolve;
      }),
  );
  provider.close.mockImplementation(() => new Promise(() => {}));
  const result = codexConversationIntake({
    ...f.request,
    timeoutMs: 100,
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toEqual(new Error('Conversation intake timed out.'));
  expect(provider.run.mock.calls[0][0].signal.aborted).toBe(true);
  expect(provider.close).toHaveBeenCalledOnce();
  settle(completed('Late reply.'));
  await Promise.resolve();
  expect(await result).toEqual(new Error('Conversation intake timed out.'));
});

it('rejects an overlapping request without displacing the current reply', async () => {
  const f = fixture();
  let release!: (value: ExecutionResult) => void;
  provider.run.mockImplementation(
    () =>
      new Promise<ExecutionResult>((resolve) => {
        release = resolve;
      }),
  );
  const session = new CodexConversationSession();
  const first = session.run(f.request);
  await expect(
    session.run({ ...f.request, caption: 'Second request.' }),
  ).rejects.toThrow(/in progress/i);
  release(completed('First answer.'));
  expect(await first).toEqual({
    reply: 'First answer.',
    needsTask: false,
    usesTaskStatus: false,
  });
  expect(provider.run).toHaveBeenCalledOnce();
  await session.close();
});

it('rejects warming when the call closes and drains cleanup', async () => {
  const f = fixture();
  let release!: () => void;
  provider.warm.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ version: 'fixture', nativeExecution: false });
      }),
  );
  const session = new CodexConversationSession();
  const warming = session
    .warm(f.request.signal)
    .catch((error: unknown) => error);
  await session.close();
  release();
  expect(await warming).toEqual(
    expect.objectContaining({ message: expect.stringMatching(/closed/i) }),
  );
  expect(provider.close).toHaveBeenCalledOnce();
  await expect(session.run(f.request)).rejects.toThrow(/closed/i);
});

it('keeps a late retired-provider result separate from the next request', async () => {
  const f = fixture();
  const controller = new AbortController();
  let oldResult!: (value: ExecutionResult) => void;
  provider.run.mockImplementationOnce(
    () =>
      new Promise<ExecutionResult>((resolve) => {
        oldResult = resolve;
      }),
  );
  const session = new CodexConversationSession();
  const first = session
    .run({ ...f.request, signal: controller.signal })
    .catch((error: unknown) => error);
  controller.abort(new Error('First reply interrupted.'));
  expect(await first).toEqual(new Error('First reply interrupted.'));
  provider.run.mockImplementationOnce(async () => {
    oldResult(completed('Stale first answer.', true));
    return completed('The current answer.');
  });
  expect(
    await session.run({ ...f.request, caption: 'Second question.' }),
  ).toEqual({
    reply: 'The current answer.',
    needsTask: false,
    usesTaskStatus: false,
  });
  expect(provider.run).toHaveBeenCalledTimes(2);
  await session.close();
});

it('waits for successful standalone cleanup before returning its decision', async () => {
  const f = fixture();
  let release!: () => void;
  provider.close.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let returned = false;
  const pending = codexConversationIntake(f.request).then(() => {
    returned = true;
  });
  await vi.waitFor(() => expect(provider.close).toHaveBeenCalledOnce());
  expect(returned).toBe(false);
  release();
  await pending;
  expect(returned).toBe(true);
});
