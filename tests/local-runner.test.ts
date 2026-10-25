import { MemoryStore } from './fixtures/memory-conversations.js';
import { afterEach, expect, it, vi } from 'vitest';
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from '@ag-ui/client';
import { Observable, Subject, lastValueFrom, of, toArray } from 'rxjs';
import { LocalAgentRunner } from '../src/server/local-runner.js';

class TestAgent extends AbstractAgent {
  calls: RunAgentInput[] = [];
  aborted = false;
  constructor(private events: (input: RunAgentInput) => Observable<BaseEvent>) {
    super({ agentId: 'dot' });
  }
  run(input: RunAgentInput) {
    this.calls.push(structuredClone(input));
    return this.events(input);
  }
  abortRun() {
    this.aborted = true;
  }
}
const input = (runId = 'run'): RunAgentInput => ({
  threadId: 'thread',
  runId,
  messages: [{ id: 'u', role: 'user', content: 'Hello' }],
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
});
const collect = (stream: Observable<BaseEvent>) =>
  lastValueFrom(stream.pipe(toArray()));
const answer = (i: RunAgentInput) =>
  of<BaseEvent[]>(
    { type: EventType.RUN_STARTED, threadId: i.threadId, runId: i.runId },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: `a-${i.runId}`,
      role: 'assistant',
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: `a-${i.runId}`,
      delta: 'Saved answer',
    },
    { type: EventType.TEXT_MESSAGE_END, messageId: `a-${i.runId}` },
    { type: EventType.RUN_FINISHED, threadId: i.threadId, runId: i.runId },
  );
afterEach(() => vi.restoreAllMocks());

it('notifies voice observers only after each text event is saved and reports run failure', async () => {
  for (const failTextWrite of [false, true]) {
    const store = new MemoryStore();
    const acquire = store.acquireThread.bind(store);
    vi.spyOn(store, 'acquireThread').mockImplementation(async () => {
      const lease = await acquire();
      const append = lease!.appendEvent;
      lease!.appendEvent = async (event) => {
        if (failTextWrite && event.type === EventType.TEXT_MESSAGE_CONTENT)
          throw Error('offline');
        await append(event);
      };
      return lease;
    });
    const heard: string[] = [];
    const settled = vi.fn();
    const agent = Object.assign(new TestAgent(answer), {
      onPersistedEvent: (_input: RunAgentInput, event: BaseEvent) => {
        if (event.type !== EventType.TEXT_MESSAGE_CONTENT) return;
        expect(store.snapshot.lastRun!.events).toContainEqual(event);
        heard.push(String(event.delta));
      },
      onRunSettled: settled,
    });
    const runner = new LocalAgentRunner(store);
    await collect(runner.run({ threadId: 'thread', agent, input: input() }));
    expect(heard).toEqual(failTextWrite ? [] : ['Saved answer']);
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread' }),
      failTextWrite,
    );
    await runner.close();
  }
});

it('runs with saved history and reconnects after replacing the runner instance', async () => {
  const store = new MemoryStore();
  const runner = new LocalAgentRunner(store);
  const agent = new TestAgent(answer);
  await collect(runner.run({ threadId: 'thread', agent, input: input() }));
  expect(agent.calls[0].threadId).toBe('thread');
  expect(agent.calls[0].messages).toEqual(input().messages);
  const reconnected = await collect(
    new LocalAgentRunner(store).connect({ threadId: 'thread' }),
  );
  expect(reconnected).toContainEqual({
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [
      input().messages[0],
      { id: 'a-run', role: 'assistant', content: 'Saved answer' },
    ],
  });
  const next = new TestAgent(answer);
  await collect(
    runner.run({
      threadId: 'thread',
      agent: next,
      input: {
        ...input('next'),
        messages: [{ id: 'u2', role: 'user', content: 'Next' }],
        state: { forged: true },
      },
    }),
  );
  expect(next.calls[0].messages).toHaveLength(3);
  expect(next.calls[0].state).toEqual({});
});

it('persists each event before publishing it and does not rerun duplicate IDs', async () => {
  const store = new MemoryStore();
  const runner = new LocalAgentRunner(store);
  const agent = new TestAgent(answer);
  const seen: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) =>
    runner.run({ threadId: 'thread', agent, input: input() }).subscribe({
      next: (event) => {
        expect(store.snapshot.lastRun?.events).toContainEqual(event);
        seen.push(event);
      },
      complete: resolve,
      error: reject,
    }),
  );
  expect(seen.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  const duplicate = new TestAgent(answer);
  expect(
    (
      await collect(
        runner.run({ threadId: 'thread', agent: duplicate, input: input() }),
      )
    ).at(-1),
  ).toMatchObject({
    type: EventType.RUN_ERROR,
    message: expect.stringMatching(/already/i),
  });
  expect(duplicate.calls).toHaveLength(0);
  expect(store.locked).toBe(false);
});

it('blocks a competing process and releases ownership after stop', async () => {
  const store = new MemoryStore();
  const runner = new LocalAgentRunner(store);
  const events = new Subject<BaseEvent>();
  const agent = new TestAgent(() => events);
  const running = collect(
    runner.run({ threadId: 'thread', agent, input: input() }),
  );
  await vi.waitFor(() => expect(agent.calls).toHaveLength(1));
  events.next({
    type: EventType.RUN_STARTED,
    threadId: 'thread',
    runId: 'run',
  });
  const competitor = new TestAgent(answer);
  expect(
    (
      await collect(
        new LocalAgentRunner(store).run({
          threadId: 'thread',
          agent: competitor,
          input: input('other'),
        }),
      )
    ).at(-1),
  ).toMatchObject({
    type: EventType.RUN_ERROR,
    message: expect.stringMatching(/running/i),
  });
  expect(competitor.calls).toHaveLength(0);
  expect(await runner.stop({ threadId: 'thread', runId: 'stale' })).toBe(false);
  expect(await runner.stop({ threadId: 'thread', runId: 'run' })).toBe(true);
  await running;
  expect(agent.aborted).toBe(true);
  expect(store.locked).toBe(false);
  expect(store.snapshot.lastRun?.status).toBe('stopped');
});

it('does not invoke a provider when saving input fails', async () => {
  const store = new MemoryStore();
  store.failure = 'begin';
  const agent = new TestAgent(answer);
  expect(
    (
      await collect(
        new LocalAgentRunner(store).run({
          threadId: 'thread',
          agent,
          input: input(),
        }),
      )
    ).at(-1),
  ).toMatchObject({
    type: EventType.RUN_ERROR,
    message: expect.stringMatching(/storage|offline/i),
  });
  expect(agent.calls).toHaveLength(0);
  expect(store.locked).toBe(false);
});

it('aborts on event storage failure and never publishes an unsaved answer', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const store = new MemoryStore();
  store.failure = 'append';
  const agent = new TestAgent(answer);
  const output: BaseEvent[] = [];
  const stream = new LocalAgentRunner(store).run({
    threadId: 'thread',
    agent,
    input: input(),
  });
  await new Promise<void>((resolve, reject) =>
    stream.subscribe({
      next: (e) => output.push(e),
      error: reject,
      complete: resolve,
    }),
  );
  expect(output).toEqual([
    expect.objectContaining({
      type: EventType.RUN_ERROR,
      message: expect.stringMatching(/storage|offline/i),
    }),
  ]);
  expect(agent.aborted).toBe(true);
  expect(store.locked).toBe(false);
});

it('reports finalization storage failure as RUN_ERROR without publishing success', async () => {
  const store = new MemoryStore();
  store.failure = 'finish';
  const events = await collect(
    new LocalAgentRunner(store).run({
      threadId: 'thread',
      agent: new TestAgent(answer),
      input: input(),
    }),
  );
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
  expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(false);
  expect(
    store.snapshot.lastRun?.events.some(
      (e) => e.type === EventType.RUN_FINISHED,
    ),
  ).toBe(false);
  expect(store.locked).toBe(false);
});

it('reports lock cleanup failure without emitting a preceding success terminal', async () => {
  const store = new MemoryStore();
  const acquire = store.acquireThread.bind(store);
  store.acquireThread = async () => {
    const lease = (await acquire())!;
    lease.release = async () => {
      store.locked = false;
      throw new Error('Connection lost');
    };
    return lease;
  };
  const events = await collect(
    new LocalAgentRunner(store).run({
      threadId: 'thread',
      agent: new TestAgent(answer),
      input: input(),
    }),
  );
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
  expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(false);
});

it.each([
  'review_space_page',
  'request_connection_action',
  'review_local_folder_access',
])('continues a pending %s approval through the local runner', async (name) => {
  const store = new MemoryStore();
  const first = new TestAgent((i) =>
    of<BaseEvent[]>(
      { type: EventType.RUN_STARTED, threadId: i.threadId, runId: i.runId },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: 'approval',
        toolCallName: name,
        parentMessageId: 'a',
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'approval', delta: '{}' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'approval' },
      { type: EventType.RUN_FINISHED, threadId: i.threadId, runId: i.runId },
    ),
  );
  await collect(
    new LocalAgentRunner(store).run({
      threadId: 'thread',
      agent: first,
      input: input(),
    }),
  );
  const next = new TestAgent(answer);
  await collect(
    new LocalAgentRunner(store).run({
      threadId: 'thread',
      agent: next,
      input: {
        ...input('approved'),
        messages: [
          {
            id: 'result',
            role: 'tool',
            toolCallId: 'approval',
            content: '{"approved":true,"url":"/page"}',
          },
        ],
      },
    }),
  );
  expect(next.calls[0].messages).toHaveLength(3);
  expect(next.calls[0].messages[1]).toMatchObject({
    role: 'assistant',
    toolCalls: [{ id: 'approval' }],
  });
  expect(next.calls[0].messages[2]).toMatchObject({
    role: 'tool',
    content: '{"approved":true,"url":"/page"}',
  });
});

it('reconnects to a partial active stream without duplicating saved text', async () => {
  const store = new MemoryStore();
  const runner = new LocalAgentRunner(store);
  const events = new Subject<BaseEvent>();
  const provider = new TestAgent(() => events);
  const running = collect(
    runner.run({ threadId: 'thread', agent: provider, input: input() }),
  );
  await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
  events.next({
    type: EventType.RUN_STARTED,
    threadId: 'thread',
    runId: 'run',
  });
  events.next({
    type: EventType.TEXT_MESSAGE_START,
    messageId: 'a',
    role: 'assistant',
  });
  events.next({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'a',
    delta: 'First ',
  });
  await vi.waitFor(() =>
    expect(store.snapshot.lastRun?.events).toHaveLength(3),
  );
  const consumer = new TestAgent(() => runner.connect({ threadId: 'thread' }));
  const reconnected = consumer.runAgent();
  events.next({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'a',
    delta: 'last',
  });
  events.next({ type: EventType.TEXT_MESSAGE_END, messageId: 'a' });
  events.next({
    type: EventType.RUN_FINISHED,
    threadId: 'thread',
    runId: 'run',
  });
  events.complete();
  await Promise.all([running, reconnected]);
  expect(consumer.messages.find((m) => m.id === 'a')?.content).toBe(
    'First last',
  );
});

it('waits for an in-flight durable write before stop releases the thread lock', async () => {
  const store = new MemoryStore();
  let releaseWrite!: () => void;
  let writing = false;
  const acquire = store.acquireThread.bind(store);
  store.acquireThread = async () => {
    const lease = (await acquire())!;
    const append = lease!.appendEvent;
    lease.appendEvent = async (event) => {
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
        writing = true;
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      }
      await append(event);
    };
    return lease;
  };
  const events = new Subject<BaseEvent>();
  const provider = new TestAgent(() => events);
  const runner = new LocalAgentRunner(store);
  const running = collect(
    runner.run({ threadId: 'thread', agent: provider, input: input() }),
  );
  await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
  events.next({
    type: EventType.RUN_STARTED,
    threadId: 'thread',
    runId: 'run',
  });
  events.next({
    type: EventType.TEXT_MESSAGE_START,
    messageId: 'a',
    role: 'assistant',
  });
  events.next({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'a',
    delta: 'Committed',
  });
  await vi.waitFor(() => expect(writing).toBe(true));
  const stopping = runner.stop({ threadId: 'thread' });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  expect(store.locked).toBe(true);
  releaseWrite();
  await Promise.all([running, stopping]);
  expect((await store.getSnapshot()).messages.at(-1)?.content).toBe(
    'Committed',
  );
  expect(store.snapshot.lastRun?.events.at(-1)?.type).toBe(
    EventType.RUN_FINISHED,
  );
});

it('emits a valid saved lifecycle when stopped before the provider starts', async () => {
  const store = new MemoryStore();
  const runner = new LocalAgentRunner(store);
  const provider = new TestAgent(answer);
  const stream = runner.run({
    threadId: 'thread',
    agent: provider,
    input: input(),
  });
  const consumer = new TestAgent(() => stream);
  const observed = consumer.runAgent();
  await runner.stop({ threadId: 'thread' });
  await observed;
  expect(provider.calls).toHaveLength(0);
  expect(store.snapshot.lastRun?.status).toBe('stopped');
});

it('rejects an invalid provider terminal before publishing it and saves an interrupted result', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const store = new MemoryStore();
  const provider = new TestAgent((i) =>
    of<BaseEvent[]>(
      { type: EventType.RUN_STARTED, threadId: i.threadId, runId: i.runId },
      { type: EventType.TEXT_MESSAGE_START, messageId: 'a', role: 'assistant' },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'a',
        delta: 'Partial',
      },
      { type: EventType.RUN_FINISHED, threadId: i.threadId, runId: i.runId },
    ),
  );
  const events = await collect(
    new LocalAgentRunner(store).run({
      threadId: 'thread',
      agent: provider,
      input: input(),
    }),
  );
  expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
  expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(false);
  expect((await store.getSnapshot()).messages.at(-1)?.content).toBe('Partial');
});

it('reserves foreground activity before the conversation lock and releases it after persistence', async () => {
  const store = new MemoryStore();
  const order: string[] = [];
  const runner = new LocalAgentRunner(store, {
    enterForeground: async () => {
      expect(store.locked).toBe(false);
      order.push('reserve');
      return () => {
        expect(store.locked).toBe(false);
        order.push('release');
      };
    },
  });
  const events = await collect(
    runner.run({
      threadId: 'thread',
      agent: new TestAgent(answer),
      input: input(),
    }),
  );
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  expect(store.snapshot.lastRun?.status).toBe('finished');
  expect(order).toEqual(['reserve', 'release']);
});

it('settles streamed approval continuations with the canonical user context on failure', async () => {
  const store = new MemoryStore();
  store.snapshot.messages = [
    { id: 'u', role: 'user', content: 'Choose a folder' },
    {
      id: 'a',
      role: 'assistant',
      toolCalls: [
        {
          id: 'approval',
          type: 'function',
          function: { name: 'review_local_folder_access', arguments: '{}' },
        },
      ],
    },
  ];
  const provider = new TestAgent((i) =>
    of<BaseEvent[]>(
      { type: EventType.RUN_STARTED, threadId: i.threadId, runId: i.runId },
      { type: EventType.RUN_ERROR, message: 'Provider stopped' },
    ),
  );
  const settled = vi.fn();
  Object.assign(provider, { onRunSettled: settled });
  const runner = new LocalAgentRunner(store);
  await collect(
    runner.run({
      threadId: 'thread',
      agent: provider,
      input: {
        ...input(),
        messages: [
          {
            id: 'result',
            role: 'tool',
            toolCallId: 'approval',
            content: '{"approved":false}',
          },
        ],
      },
    }),
  );
  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({
      messages: expect.arrayContaining([
        { id: 'u', role: 'user', content: 'Choose a folder' },
      ]),
    }),
    true,
  );
});

it('keeps streamed runs and their final receipt inside workspace admission', async () => {
  const { MaintenanceGate } =
    await import('../src/server/storage/maintenance.js');
  const gate = new MaintenanceGate();
  const store = new MemoryStore();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let atFinish = false;
  const acquire = store.acquireThread.bind(store);
  vi.spyOn(store, 'acquireThread').mockImplementation(async () => {
    const lease = await acquire();
    const savedFinish = lease!.finishRun.bind(lease);
    lease!.finishRun = async (...args) => {
      atFinish = true;
      await pending;
      await savedFinish(...args);
    };
    return lease;
  });
  let receipt = false;
  const agent = Object.assign(new TestAgent(answer), {
    onRunSettled: () => {
      expect(gate.status().activeWrites).toBeGreaterThan(0);
      receipt = true;
    },
  });
  const runner = new LocalAgentRunner(store, undefined, gate);
  const running = collect(
    runner.run({ threadId: 'thread', agent, input: input() }),
  );
  await vi.waitFor(() => expect(atFinish).toBe(true));
  let captured = false;
  const snapshot = gate
    .acquire({ origin: 'automatic', signal: new AbortController().signal })
    .then((lease) => {
      captured = true;
      return lease;
    });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(captured).toBe(false);
  } finally {
    finish();
  }
  await running;
  const lease = await snapshot;
  expect(receipt).toBe(true);
  expect(store.snapshot.lastRun?.status).toBe('finished');
  lease.release();
  await runner.close();
});

it('does not start providers while manual snapshot admission is held', async () => {
  const { MaintenanceGate } =
    await import('../src/server/storage/maintenance.js');
  const gate = new MaintenanceGate();
  const lease = await gate.acquire({
    origin: 'manual',
    signal: new AbortController().signal,
  });
  const agent = new TestAgent(answer);
  const runner = new LocalAgentRunner(new MemoryStore(), undefined, gate);
  const running = collect(
    runner.run({ threadId: 'thread', agent, input: input() }),
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(agent.calls).toHaveLength(0);
  } finally {
    lease.release();
  }
  await running;
  expect(agent.calls).toHaveLength(1);
  await vi.waitFor(() => expect(gate.status().activeWrites).toBe(0));
  await runner.close();
});

it('awaits a durable lifecycle gate before running and settles under maintenance admission', async () => {
  const store = new MemoryStore();
  const order: string[] = [];
  const { MaintenanceGate } =
    await import('../src/server/storage/maintenance.js');
  const maintenance = new MaintenanceGate();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lifecycle = {
    begin: vi.fn(async () => {
      order.push('begin');
      await blocked;
      return {
        settle: async (outcome: { failed: boolean; stopped: boolean }) => {
          expect(store.snapshot.lastRun?.status).toBe('finished');
          expect(maintenance.status().activeWrites).toBeGreaterThan(0);
          expect(outcome).toMatchObject({ failed: false, stopped: false });
          order.push('settled');
        },
      };
    }),
  };
  const agent = new TestAgent((i) => {
    order.push('agent');
    return answer(i);
  });
  const runner = new LocalAgentRunner(store, undefined, maintenance, lifecycle);
  const finished = collect(
    runner.run({ threadId: 'thread', agent, input: input() }),
  );
  await vi.waitFor(() => expect(order).toEqual(['begin']));
  expect(agent.calls).toHaveLength(0);
  release();
  await finished;
  expect(order).toEqual(['begin', 'agent', 'settled']);
  expect(lifecycle.begin).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: 'dot',
      input: expect.objectContaining({ threadId: 'thread' }),
    }),
  );
});

it('denies a terminal delegated thread before provider invocation', async () => {
  const store = new MemoryStore();
  const agent = new TestAgent(answer);
  const runner = new LocalAgentRunner(store, undefined, undefined, {
    begin: async () => {
      throw Error('Delegated task is already completed.');
    },
  });
  const events = await collect(
    runner.run({ threadId: 'thread', agent, input: input() }),
  );
  expect(agent.calls).toHaveLength(0);
  expect(events.at(-1)).toMatchObject({
    type: EventType.RUN_ERROR,
    message: expect.stringContaining('completed'),
  });
  expect(store.snapshot.lastRun).toBeUndefined();
});

it('binds pending approvals to the host engine across restart, ignoring client engine claims', async () => {
  const store = new MemoryStore();
  const first = Object.assign(
    new TestAgent((i) =>
      of<BaseEvent[]>(
        { type: EventType.RUN_STARTED, threadId: i.threadId, runId: i.runId },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: 'approval',
          toolCallName: 'review_local_folder_access',
          parentMessageId: 'a',
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'approval', delta: '{}' },
        { type: EventType.TOOL_CALL_END, toolCallId: 'approval' },
        { type: EventType.RUN_FINISHED, threadId: i.threadId, runId: i.runId },
      ),
    ),
    { executionIdentity: () => 'codex:0.163.0' },
  );
  await collect(
    new LocalAgentRunner(store).run({
      threadId: 'thread',
      agent: first,
      input: { ...input(), forwardedProps: { executionEngine: 'legacy' } },
    }),
  );
  expect(
    (store.snapshot.lastRun!.input.forwardedProps as Record<string, unknown>)
      .executionEngine,
  ).toBe('codex:0.163.0');
  await collect(
    new LocalAgentRunner(store).run({
      threadId: 'thread',
      agent: new TestAgent(answer),
      input: { ...input('host-receipt'), messages: [] },
    }),
  );
  expect(
    (store.snapshot.lastRun!.input.forwardedProps as Record<string, unknown>)
      .executionEngine,
  ).toBe('codex:0.163.0');
  const next = Object.assign(new TestAgent(answer), {
    executionIdentity: () => 'legacy',
  });
  const events = await collect(
    new LocalAgentRunner(store).run({
      threadId: 'thread',
      agent: next,
      input: {
        ...input('resume'),
        messages: [
          {
            id: 'result',
            role: 'tool',
            toolCallId: 'approval',
            content: '{"approved":true}',
          },
        ],
        forwardedProps: { executionEngine: 'codex:0.163.0' },
      },
    }),
  );
  expect(next.calls).toHaveLength(0);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: EventType.RUN_ERROR,
      message: expect.stringMatching(/engine changed/),
    }),
  );
  expect(store.snapshot.lastRun!.runId).toBe('host-receipt');
  const same = Object.assign(new TestAgent(answer), {
    executionIdentity: () => 'codex:0.163.0',
  });
  await collect(
    new LocalAgentRunner(store).run({
      threadId: 'thread',
      agent: same,
      input: {
        ...input('same-engine'),
        messages: [
          {
            id: 'result',
            role: 'tool',
            toolCallId: 'approval',
            content: '{"approved":true}',
          },
        ],
      },
    }),
  );
  expect(same.calls).toHaveLength(1);
});
