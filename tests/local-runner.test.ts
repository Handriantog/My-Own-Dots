import { afterEach, expect, it, vi } from 'vitest';
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from '@ag-ui/client';
import { Observable, Subject, lastValueFrom, of, toArray } from 'rxjs';
import { LocalAgentRunner } from '../src/server/local-runner.js';
import {
  replayRun,
  type ConversationSnapshot,
  type LocalConversationStore,
  type ThreadLease,
} from '../src/server/local-conversations.js';

class MemoryStore implements LocalConversationStore {
  ownerId = 'owner';
  snapshot: ConversationSnapshot = { messages: [], state: {} };
  locked = false;
  failure?: 'begin' | 'append' | 'read' | 'finish';
  ids = new Set<string>();
  async getOrCreateThread() {
    return {
      id: 'thread',
      agentId: 'dot',
      organizationId: 'local',
      createdById: 'owner',
      name: null,
      archived: false,
      createdAt: '',
      updatedAt: '',
    };
  }
  async getSnapshot() {
    if (this.failure === 'read') throw new Error('offline');
    const copy = structuredClone(this.snapshot);
    return copy.lastRun
      ? {
          ...copy,
          ...(await replayRun(copy.lastRun.input, copy.lastRun.events)),
        }
      : copy;
  }
  async isRunning() {
    return this.locked;
  }
  async acquireThread(): Promise<ThreadLease | null> {
    if (this.locked) return null;
    this.locked = true;
    return {
      signal: new AbortController().signal,
      read: () => this.getSnapshot(),
      beginRun: async (input) => {
        if (this.failure === 'begin') throw new Error('offline');
        if (this.ids.has(input.runId)) throw new Error('Run already used');
        this.ids.add(input.runId);
        this.snapshot = {
          messages: structuredClone(input.messages),
          state: structuredClone(input.state),
          lastRun: {
            input: structuredClone(input),
            runId: input.runId,
            events: [],
            status: 'running',
          },
        };
      },
      appendEvent: async (event) => {
        if (this.failure === 'append') throw new Error('offline');
        this.snapshot.lastRun!.events.push(structuredClone(event));
      },
      finishRun: async (messages, state, status, terminal) => {
        if (this.failure === 'finish') throw new Error('offline');
        if (terminal)
          this.snapshot.lastRun!.events.push(structuredClone(terminal));
        this.snapshot.messages = structuredClone(messages);
        this.snapshot.state = structuredClone(state);
        this.snapshot.lastRun!.status = status;
      },
      release: async () => {
        this.locked = false;
      },
    };
  }
}
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

it('retains pending approvals and accepts their result on a later turn', async () => {
  const store = new MemoryStore();
  const first = new TestAgent((i) =>
    of<BaseEvent[]>(
      { type: EventType.RUN_STARTED, threadId: i.threadId, runId: i.runId },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: 'approval',
        toolCallName: 'review_space_page',
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
    const append = lease.appendEvent;
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
