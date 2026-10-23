import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  AbstractAgent,
  defaultApplyEvents,
  EventType,
  type AgentSubscriber,
  type BaseEvent,
  type RunAgentInput,
  type RunAgentParameters,
} from '@ag-ui/client';
import { CopilotKitCore, CopilotKitCoreErrorCode } from '@copilotkit/core';
import { from, lastValueFrom, Subject, throwError, toArray } from 'rxjs';
import { z } from 'zod';

const harness = vi.hoisted(() => {
  type Subscriber = {
    onRunErrorEvent?: (params: {
      event: { type: string; message: string };
    }) => void;
    onRunFinishedEvent?: (params: {
      event: { type: string };
      outcome: 'success' | 'interrupt';
      interrupts?: unknown[];
    }) => void;
    onError?: (params: { error: Error; code: string }) => void;
  };
  const agentSubscribers: Subscriber[] = [];
  const copilotSubscribers: Subscriber[] = [];
  const agent = {
    messages: [],
    state: {},
    pendingInterrupts: [],
    addMessage: vi.fn(),
    subscribe: vi.fn((subscriber: Subscriber) => {
      agentSubscribers.push(subscriber);
      return {
        unsubscribe: () => {
          const index = agentSubscribers.indexOf(subscriber);
          if (index >= 0) agentSubscribers.splice(index, 1);
        },
      };
    }),
  };
  const copilotkit = {
    subscribe: vi.fn((subscriber: Subscriber) => {
      copilotSubscribers.push(subscriber);
      return {
        unsubscribe: () => {
          const index = copilotSubscribers.indexOf(subscriber);
          if (index >= 0) copilotSubscribers.splice(index, 1);
        },
      };
    }),
    connectAgent: vi.fn(async () => ({})),
    stopAgent: vi.fn(),
    runAgent: vi.fn(async () => ({
      newMessages: [] as Array<{ role: string }>,
    })),
    emitError(message: string, code: string) {
      const params = { error: new Error(message), code };
      for (const subscriber of [...copilotSubscribers])
        subscriber.onError?.(params);
    },
  };
  return {
    stopVoicePreview: vi.fn(),
    startLocalVoice: vi.fn(async () => {}),
    localVoiceStatus: 'idle' as 'idle' | 'active' | 'ending',
    localVoiceOptions: undefined as
      | undefined
      | {
          onCancelTranscript(messageId: string): Promise<void>;
          onTranscript(input: {
            messageId: string;
            text: string;
          }): Promise<void>;
        },
    agent,
    agentSubscribers,
    copilotkit,
    api: vi.fn<(path: string, ...args: unknown[]) => Promise<unknown>>(
      async () => null,
    ),
    useAgent: vi.fn(() => ({ agent, isReady: true })),
    useCopilotKit: vi.fn(() => ({ copilotkit })),
  };
});

vi.mock('../src/client/api', () => ({
  api: (path: string, ...args: unknown[]) =>
    path === '/message-marks'
      ? Promise.resolve([])
      : harness.api(path, ...args),
}));
vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotChatToolCallsView: () => null,
  useRenderTool: vi.fn(),
  useHumanInTheLoop: vi.fn(),
  useAgent: harness.useAgent,
  useCopilotKit: harness.useCopilotKit,
}));
vi.mock('../src/client/PageReviewCard', () => ({ PageReviewCard: () => null }));
vi.mock('../src/client/ComputerToolCard', () => ({
  ComputerToolCard: () => null,
}));
vi.mock('../src/client/ChatTranscript', () => ({
  ChatTranscript: () => null,
  isInternalVoiceReceipt: () => false,
}));
vi.mock('../src/client/Mascot', () => ({ Mascot: () => null }));
vi.mock('../src/client/CallView', () => ({ CallView: () => null }));
vi.mock('../src/client/local-voice/VoiceSettings', async () => {
  const { useImperativeHandle } = await import('react');
  return {
    VoiceSettings: ({
      ref,
    }: {
      ref: import('react').Ref<{ stopPreview(): void }>;
    }) => {
      useImperativeHandle(ref, () => ({
        stopPreview: harness.stopVoicePreview,
      }));
      return null;
    },
  };
});
vi.mock('../src/client/useVoice', () => ({
  useVoice: () => ({ status: 'idle', error: '', end: vi.fn() }),
}));
vi.mock('../src/client/local-voice/useLocalVoice', () => ({
  useLocalVoice: (options: {
    onCancelTranscript(messageId: string): Promise<void>;
    onTranscript(input: { messageId: string; text: string }): Promise<void>;
  }) => {
    harness.localVoiceOptions = options;
    return {
      status: harness.localVoiceStatus,
      error: '',
      start: harness.startLocalVoice,
      end: vi.fn(),
      interrupt: vi.fn(),
    };
  },
}));

import { Chat } from '../src/client/Chat';
import { CallView } from '../src/client/CallView';
import { VoiceSettings } from '../src/client/local-voice/VoiceSettings';

class ReplayAgent extends AbstractAgent {
  events: BaseEvent[] = [];

  run(_input: RunAgentInput) {
    return from(this.events);
  }

  // Connect replays can contain several runs; apply them without single-run verification.
  async connectAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ) {
    await lastValueFrom(
      defaultApplyEvents(
        this.prepareRunAgentInput(parameters),
        from(this.events),
        this,
        [...this.subscribers, subscriber ?? {}],
      ).pipe(toArray()),
    );
    return { newMessages: [], result: undefined };
  }
}

function useReplayAgent(events: BaseEvent[]) {
  const agent = new ReplayAgent({
    agentId: 'chat-thread',
    threadId: 'thread',
  });
  const copilotkit = new CopilotKitCore({});
  harness.useAgent.mockReturnValue({
    agent: agent as unknown as typeof harness.agent,
    isReady: true,
  });
  harness.useCopilotKit.mockReturnValue({
    copilotkit: copilotkit as unknown as typeof harness.copilotkit,
  });
  agent.events = events;
  return { agent, copilotkit };
}

function runInput(runId: string): RunAgentInput {
  return {
    threadId: 'thread',
    runId,
    state: {},
    messages: [],
    tools: [],
    context: [],
  };
}

function runStarted(runId: string): BaseEvent {
  return { type: EventType.RUN_STARTED, threadId: 'thread', runId };
}

function runError(runId: string, message: string): BaseEvent[] {
  return [runStarted(runId), { type: EventType.RUN_ERROR, message }];
}

function runFinished(
  runId: string,
  outcome: 'success' | 'interrupt' = 'success',
): BaseEvent[] {
  return [
    runStarted(runId),
    {
      type: EventType.RUN_FINISHED,
      threadId: 'thread',
      runId,
      ...(outcome === 'interrupt'
        ? { outcome: { type: 'interrupt' as const, interrupts: [] } }
        : { outcome: { type: 'success' as const } }),
    },
  ];
}

async function applySdkEvents(events: BaseEvent[]) {
  const started = events.find(
    (
      event,
    ): event is BaseEvent & {
      type: typeof EventType.RUN_STARTED;
      runId: string;
    } =>
      event.type === EventType.RUN_STARTED &&
      'runId' in event &&
      typeof event.runId === 'string',
  );
  if (!started)
    throw new Error('SDK event sequence must start with RUN_STARTED');
  await lastValueFrom(
    defaultApplyEvents(
      runInput(started.runId),
      from(events),
      harness.agent as unknown as Parameters<typeof defaultApplyEvents>[2],
      [...harness.agentSubscribers] as AgentSubscriber[],
    ).pipe(toArray()),
  );
}

let root: ReactTestRenderer;
const props: Parameters<typeof Chat>[0] = {
  thread: {
    id: 'thread',
    dotId: 'dot',
    ownerId: 'owner',
    title: 'Thread',
    createdAt: 0,
  },
  dot: {
    id: 'dot',
    spaceId: 'space',
    spaceIds: ['space'],
    name: 'Dot',
    instructions: '',
    researchAllowed: false,
    memoryAllowed: false,
    appsAllowed: false,
    composioToolkits: [],
    createdAt: 0,
  },
  onConsumed: vi.fn(),
  voiceReady: false,
  calls: [],
  paused: false,
  onSaved: vi.fn(),
  onSchedule: vi.fn(),
};

async function mountChat() {
  await act(async () => {
    root = create(createElement(Chat, props));
  });
}

async function submitMessage(text = 'Hello') {
  await act(async () => {
    root.root.findByProps({ 'aria-label': 'Message your Dot' }).props.onChange({
      target: { value: text },
    });
  });
  await act(async () => {
    root.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
}

function assistantResponse(runId: string): BaseEvent[] {
  return [
    runStarted(runId),
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'reply',
      role: 'assistant',
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'reply',
      delta: 'Hello back',
    },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' },
    ...runFinished(runId).slice(1),
  ];
}

function alertText(): string[] {
  return root.root
    .findAll((node) => node.props.role === 'alert')
    .map((node) => String(node.children[0]));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.api.mockClear();
  harness.stopVoicePreview.mockClear();
  harness.startLocalVoice.mockClear();
  harness.localVoiceStatus = 'idle';
  harness.agent.subscribe.mockClear();
  harness.copilotkit.subscribe.mockClear();
  harness.copilotkit.connectAgent.mockClear();
  harness.api.mockImplementation(async () => null);
  harness.useAgent.mockReturnValue({ agent: harness.agent, isReady: true });
  harness.useCopilotKit.mockReturnValue({ copilotkit: harness.copilotkit });
  vi.stubGlobal('window', { prompt: vi.fn(() => 'Saved conversation') });
});

it('stops voice previews synchronously before starting a call and locks settings during it', async () => {
  const next = { ...props, localVoiceEnabled: true, localVoiceReady: true };
  await act(async () => {
    root = create(createElement(Chat, next));
  });
  expect(root.root.findByType(VoiceSettings).props.callActive).toBe(false);
  harness.startLocalVoice.mockImplementationOnce(async () => {
    expect(harness.stopVoicePreview).toHaveBeenCalledOnce();
  });
  await act(async () => {
    root.root.findByProps({ 'aria-label': 'Start voice call' }).props.onClick();
  });
  expect(harness.startLocalVoice).toHaveBeenCalledOnce();
  harness.localVoiceStatus = 'active';
  await act(async () => root.update(createElement(Chat, next)));
  expect(root.root.findByType(VoiceSettings).props.callActive).toBe(true);
});

it('shows connecting immediately and starts native Talk once after chat is ready', async () => {
  let connected!: () => void;
  harness.copilotkit.connectAgent.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        connected = () => resolve({});
      }),
  );
  const target = new EventTarget();
  const activate = vi.fn(async () => {
    target.dispatchEvent(new Event('dot-voice-start'));
  });
  vi.stubGlobal(
    'window',
    Object.assign(target, {
      dotVoice: { activate, setReady: vi.fn(async () => {}) },
    }),
  );
  const consumed = vi.fn();
  const next = {
    ...props,
    localVoiceReady: true,
    localVoiceEnabled: true,
    voiceIntent: 1,
    onVoiceConsumed: consumed,
  };
  await act(async () => {
    root = create(createElement(Chat, next));
  });
  expect(root.root.findByType(CallView).props.voice.status).toBe('connecting');
  expect(harness.startLocalVoice).not.toHaveBeenCalled();
  await act(async () => {
    connected();
  });
  expect(activate).toHaveBeenCalledOnce();
  expect(harness.startLocalVoice).toHaveBeenCalledOnce();
  expect(consumed).toHaveBeenCalledOnce();
  await act(async () => {
    root.update(createElement(Chat, { ...next, calls: [] }));
  });
  expect(harness.startLocalVoice).toHaveBeenCalledOnce();
  expect(root.root.findAllByProps({ children: 'Start call' })).toHaveLength(0);
});

it('registers cold native readiness before requesting the Talk activation', async () => {
  const target = new EventTarget();
  let registered!: () => void;
  const setReady = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        registered = resolve;
      }),
  );
  const activate = vi.fn(async () => {
    target.dispatchEvent(new Event('dot-voice-start'));
  });
  vi.stubGlobal(
    'window',
    Object.assign(target, { dotVoice: { setReady, activate } }),
  );
  const next = {
    ...props,
    localVoicePending: true,
    voiceIntent: 1,
    onVoiceConsumed: vi.fn(),
  };
  await act(async () => {
    root = create(createElement(Chat, next));
  });
  expect(activate).not.toHaveBeenCalled();
  await act(async () => {
    root.update(
      createElement(Chat, {
        ...next,
        localVoicePending: false,
        localVoiceReady: true,
      }),
    );
  });
  expect(setReady).toHaveBeenCalledWith(true);
  expect(activate).not.toHaveBeenCalled();
  await act(async () => registered());
  expect(activate).toHaveBeenCalledOnce();
  expect(harness.startLocalVoice).toHaveBeenCalledOnce();
});

it('reports unavailable local voice instead of starting a deferred or paid call', async () => {
  const consumed = vi.fn();
  const next = {
    ...props,
    voiceReady: true,
    localVoiceEnabled: true,
    localVoiceReason: 'Install the selected speech model.',
    voiceIntent: 1,
    onVoiceConsumed: consumed,
  };
  await act(async () => {
    root = create(createElement(Chat, next));
  });
  expect(alertText()).toContain('Install the selected speech model.');
  expect(consumed).toHaveBeenCalledOnce();
  await act(async () => {
    root.update(createElement(Chat, { ...next, localVoiceReady: true }));
  });
  expect(harness.startLocalVoice).not.toHaveBeenCalled();
});

it('does not activate when a Talk is cancelled while readiness registration is pending', async () => {
  let registered!: () => void;
  const activate = vi.fn(async () => {});
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      dotVoice: {
        setReady: () =>
          new Promise<void>((resolve) => {
            registered = resolve;
          }),
        activate,
      },
    }),
  );
  const next = {
    ...props,
    localVoiceReady: true,
    voiceIntent: 1,
    onVoiceConsumed: vi.fn(),
  };
  await act(async () => {
    root = create(createElement(Chat, next));
  });
  await act(async () => {
    root.update(createElement(Chat, { ...next, voiceIntent: 0 }));
  });
  await act(async () => registered());
  expect(activate).not.toHaveBeenCalled();
  expect(harness.startLocalVoice).not.toHaveBeenCalled();
});

it('cancels a waiting Talk and never starts it when chat later loads', async () => {
  let connected!: () => void;
  harness.copilotkit.connectAgent.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        connected = () => resolve({});
      }),
  );
  const consumed = vi.fn();
  await act(async () => {
    root = create(
      createElement(Chat, {
        ...props,
        localVoiceReady: true,
        voiceIntent: 1,
        onVoiceConsumed: consumed,
      }),
    );
  });
  await act(async () => {
    await root.root.findByType(CallView).props.voice.end();
  });
  await act(async () => {
    connected();
  });
  expect(consumed).toHaveBeenCalledOnce();
  expect(harness.startLocalVoice).not.toHaveBeenCalled();
});

it('consumes another Talk while already calling without restarting or leaving a pending request', async () => {
  harness.localVoiceStatus = 'active';
  const consumed = vi.fn();
  await act(async () => {
    root = create(
      createElement(Chat, {
        ...props,
        localVoiceReady: true,
        voiceIntent: 2,
        onVoiceConsumed: consumed,
      }),
    );
  });
  expect(consumed).toHaveBeenCalledOnce();
  expect(harness.startLocalVoice).not.toHaveBeenCalled();
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it('clears a historical run error when replay later finishes successfully', async () => {
  const { agent, copilotkit } = useReplayAgent(
    runError('old-failed', 'Old run failed'),
  );
  const connect = vi.spyOn(copilotkit, 'connectAgent');
  const forwardedError = vi.fn();
  copilotkit.subscribe({ onError: forwardedError });
  await mountChat();
  expect(alertText()).toContain('Old run failed');
  expect(root.root.findByProps({ children: 'Reconnect' })).toBeDefined();
  expect(forwardedError).toHaveBeenCalledWith(
    expect.objectContaining({
      code: CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT,
    }),
  );

  agent.events = [
    ...runError('replayed-failure', 'Old run failed'),
    ...runFinished('background-success'),
  ];
  await act(async () => {
    root.root.findByProps({ children: 'Reconnect' }).props.onClick();
  });
  expect(connect).toHaveBeenCalledTimes(2);
  expect(forwardedError).toHaveBeenCalledTimes(2);
  expect(alertText()).toHaveLength(0);
  expect(root.root.findAllByProps({ children: 'Reconnect' })).toHaveLength(0);
});

it('preserves the SDK transport failure when the submitted turn resolves empty', async () => {
  const { agent } = useReplayAgent([]);
  await mountChat();
  vi.spyOn(agent, 'run').mockReturnValueOnce(
    throwError(() => new Error('Runtime connection refused')),
  );
  await submitMessage();
  expect(alertText()).toEqual(['Runtime connection refused']);
});

it('preserves a current RUN_ERROR instead of replacing it with no response', async () => {
  const { agent } = useReplayAgent([]);
  await mountChat();
  vi.spyOn(agent, 'run').mockImplementationOnce((input) =>
    from(runError(input.runId, 'Provider session expired')),
  );
  await submitMessage();
  expect(alertText()).toEqual(['Provider session expired']);
});

it('preserves a failure from the SDK tool follow-up within the submitted turn', async () => {
  const { agent, copilotkit } = useReplayAgent([]);
  copilotkit.addTool({
    name: 'fixture',
    parameters: z.object({}),
    handler: async () => 'Done',
  });
  vi.spyOn(agent, 'run')
    .mockImplementationOnce((input) =>
      from([
        runStarted(input.runId),
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: 'tool',
          toolCallName: 'fixture',
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tool', delta: '{}' },
        { type: EventType.TOOL_CALL_END, toolCallId: 'tool' },
        ...runFinished(input.runId).slice(1),
      ]),
    )
    .mockImplementationOnce((input) =>
      from(runError(input.runId, 'Follow-up session expired')),
    );
  await mountChat();
  await submitMessage();
  expect(alertText()).toEqual(['Follow-up session expired']);
});

it('rejects a voice turn with the SDK failure that caused its empty result', async () => {
  const { agent } = useReplayAgent([]);
  await mountChat();
  vi.spyOn(agent, 'run').mockReturnValueOnce(
    throwError(() => new Error('Runtime connection refused')),
  );
  await act(async () => {
    await expect(
      harness.localVoiceOptions!.onTranscript({
        messageId: 'failed-voice',
        text: 'Hello',
      }),
    ).rejects.toThrow('Runtime connection refused');
  });
});

it('does not let an old replay failure poison a new successful turn', async () => {
  const { agent } = useReplayAgent([]);
  const events = new Subject<BaseEvent>();
  let currentRunId = '';
  vi.spyOn(agent, 'run').mockImplementationOnce((input) => {
    currentRunId = input.runId;
    return events;
  });
  await mountChat();
  await submitMessage();
  agent.events = runError('historical-failure', 'Old failure');
  await act(async () => {
    await agent.connectAgent();
    for (const event of assistantResponse(currentRunId)) events.next(event);
    events.complete();
  });
  expect(alertText()).toEqual([]);
});

it('does not mistake a replay failure for the cause of a current empty turn', async () => {
  const { agent } = useReplayAgent([]);
  const events = new Subject<BaseEvent>();
  let currentRunId = '';
  vi.spyOn(agent, 'run').mockImplementationOnce((input) => {
    currentRunId = input.runId;
    return events;
  });
  await mountChat();
  await submitMessage();
  agent.events = runError('historical-failure', 'Old failure');
  await act(async () => {
    await agent.connectAgent();
    for (const event of runFinished(currentRunId)) events.next(event);
    events.complete();
  });
  expect(alertText()).toEqual([
    'The current turn returned no response. Check the runtime connection and retry.',
  ]);
});

it('keeps the composer unavailable after an SDK connect failure', async () => {
  const { agent } = useReplayAgent([]);
  vi.spyOn(agent, 'connectAgent').mockRejectedValueOnce(
    new Error('Runtime is unavailable'),
  );
  await mountChat();
  await submitMessage();
  expect(alertText()).toEqual(['Runtime is unavailable']);
  expect(
    root.root.findByProps({ 'aria-label': 'Send message' }).props.disabled,
  ).toBe(true);
  expect(agent.messages).toEqual([]);
});

it('keeps the composer unavailable when initial connect returns a bare runtime error', async () => {
  const { agent, copilotkit } = useReplayAgent([
    {
      type: EventType.RUN_ERROR,
      code: 'LOCAL_CONVERSATION_ERROR',
      message: 'Connection terminated unexpectedly',
    },
  ]);
  const run = vi.spyOn(copilotkit, 'runAgent');
  await mountChat();
  await act(async () => {
    root.root.findByProps({ 'aria-label': 'Message your Dot' }).props.onChange({
      target: { value: 'Hello' },
    });
  });
  expect(alertText()).toEqual(['Connection terminated unexpectedly']);
  expect(
    root.root.findByProps({ 'aria-label': 'Send message' }).props.disabled,
  ).toBe(true);
  expect(agent.messages).toEqual([]);
  expect(run).not.toHaveBeenCalled();
});

it.each([
  runStarted('historical-run'),
  { type: EventType.MESSAGES_SNAPSHOT, messages: [] },
  { type: EventType.STATE_SNAPSHOT, snapshot: {} },
])(
  'allows sending after replay starts with $type and contains a historical error',
  async (event) => {
    useReplayAgent([
      event,
      {
        type: EventType.RUN_ERROR,
        code: 'LOCAL_CONVERSATION_ERROR',
        message: 'Previous run failed',
      },
    ]);
    await mountChat();
    await act(async () => {
      root.root
        .findByProps({ 'aria-label': 'Message your Dot' })
        .props.onChange({
          target: { value: 'Hello' },
        });
    });
    expect(alertText()).toEqual(['Previous run failed']);
    expect(
      root.root.findByProps({ 'aria-label': 'Send message' }).props.disabled,
    ).toBe(false);
  },
);

it('shows a pending reconnect and its success without rerunning the failed turn', async () => {
  const { agent, copilotkit } = useReplayAgent([]);
  const run = vi.spyOn(copilotkit, 'runAgent');
  await mountChat();
  vi.spyOn(agent, 'run').mockReturnValueOnce(
    throwError(() => new Error('Runtime connection refused')),
  );
  await submitMessage();
  let finish!: () => void;
  vi.spyOn(agent, 'connectAgent').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ newMessages: [], result: undefined });
      }),
  );
  await act(async () => {
    root.root.findByProps({ children: 'Reconnect' }).props.onClick();
  });
  expect(
    root.root
      .findAllByType('button')
      .find((node) => node.children[0] === 'Reconnecting…')?.props.disabled,
  ).toBe(true);
  expect(
    root.root
      .findAllByProps({ role: 'status' })
      .map((node) => node.children.join('')),
  ).toContain('Reconnecting…');
  await act(async () => finish());
  expect(
    root.root
      .findAllByProps({ role: 'status' })
      .map((node) => node.children.join('')),
  ).toContain('Reconnected. Send a message to try again.');
  expect(run).toHaveBeenCalledOnce();
});

it('shows a failed reconnect and keeps sending disabled when the SDK resolves its error', async () => {
  const { agent, copilotkit } = useReplayAgent([]);
  const run = vi.spyOn(copilotkit, 'runAgent');
  await mountChat();
  vi.spyOn(agent, 'run').mockReturnValueOnce(
    throwError(() => new Error('Runtime connection refused')),
  );
  await submitMessage();
  vi.spyOn(agent, 'connectAgent').mockRejectedValueOnce(
    new Error('Runtime still unavailable'),
  );
  await act(async () => {
    root.root.findByProps({ children: 'Reconnect' }).props.onClick();
  });
  expect(alertText()).toEqual(['Runtime still unavailable']);
  await submitMessage('Try again');
  expect(
    root.root.findByProps({ 'aria-label': 'Send message' }).props.disabled,
  ).toBe(true);
  expect(
    root.root
      .findAllByProps({ role: 'status' })
      .map((node) => node.children.join('')),
  ).not.toContain('Reconnected. Send a message to try again.');
  expect(run).toHaveBeenCalledOnce();
});

it('does not report reconnect success when the runtime returns a bare connection error', async () => {
  const { agent, copilotkit } = useReplayAgent([]);
  const run = vi.spyOn(copilotkit, 'runAgent');
  await mountChat();
  vi.spyOn(agent, 'run').mockReturnValueOnce(
    throwError(() => new Error('Runtime connection refused')),
  );
  await submitMessage();
  agent.events = [
    {
      type: EventType.RUN_ERROR,
      code: 'LOCAL_CONVERSATION_ERROR',
      message: 'Connection terminated unexpectedly',
    },
  ];
  await act(async () => {
    root.root.findByProps({ children: 'Reconnect' }).props.onClick();
  });
  await act(async () => {
    root.root.findByProps({ 'aria-label': 'Message your Dot' }).props.onChange({
      target: { value: 'Try again' },
    });
  });
  expect(alertText()).toEqual(['Connection terminated unexpectedly']);
  expect(
    root.root.findByProps({ 'aria-label': 'Send message' }).props.disabled,
  ).toBe(true);
  expect(
    root.root
      .findAllByProps({ role: 'status' })
      .map((node) => node.children.join('')),
  ).not.toContain('Reconnected. Send a message to try again.');
  expect(run).toHaveBeenCalledOnce();
});

it('keeps a latest historical failure visible without a later success', async () => {
  await mountChat();
  await act(async () => {
    await applySdkEvents(runError('latest-failed', 'Latest run failed'));
  });
  expect(alertText()).toContain('Latest run failed');
});

it('preserves a page-save failure when a background run finishes successfully', async () => {
  harness.api.mockImplementationOnce(async () => null);
  harness.api.mockRejectedValueOnce(new Error('Could not save this page'));
  await mountChat();

  await act(async () => {
    await root.root
      .findByProps({ 'aria-label': 'Save conversation as page' })
      .props.onClick();
  });
  expect(alertText()).toContain('Could not save this page');
  expect(harness.api).toHaveBeenCalledWith(
    '/conversations/thread/page',
    'POST',
    {
      title: 'Saved conversation',
    },
  );

  await act(async () => {
    await applySdkEvents(runFinished('scheduled-success'));
  });
  expect(alertText()).toContain('Could not save this page');
});

it('preserves a page-save failure while a failed run later recovers', async () => {
  await mountChat();
  harness.api.mockRejectedValueOnce(new Error('Could not save this page'));
  await act(async () => {
    await root.root
      .findByProps({ 'aria-label': 'Save conversation as page' })
      .props.onClick();
    await applySdkEvents(runError('prior-failed', 'Old run failed'));
    await applySdkEvents(runFinished('recovered-success'));
  });
  expect(alertText()).toContain('Could not save this page');
});

it('preserves an unrelated CopilotKit connection error after a successful run', async () => {
  await mountChat();
  await act(async () => {
    harness.copilotkit.emitError(
      'Connection failed',
      CopilotKitCoreErrorCode.AGENT_CONNECT_FAILED,
    );
    await applySdkEvents(runFinished('background-success'));
  });
  expect(alertText()).toContain('Connection failed');
});

it('clears a run transport failure forwarded through CopilotKit after recovery', async () => {
  const { agent, copilotkit } = useReplayAgent([]);
  const forwardedError = vi.fn();
  copilotkit.subscribe({ onError: forwardedError });
  await mountChat();
  vi.spyOn(agent, 'run').mockReturnValueOnce(
    throwError(() => new Error('Run transport failed')),
  );
  await act(async () => {
    await copilotkit.runAgent({ agent });
  });
  expect(alertText()).toContain('Run transport failed');
  expect(forwardedError.mock.calls.map(([event]) => event.code)).toEqual([
    CopilotKitCoreErrorCode.AGENT_RUN_FAILED_EVENT,
    CopilotKitCoreErrorCode.AGENT_RUN_FAILED,
  ]);
  agent.events = runFinished('recovered-success');
  await act(async () => {
    await copilotkit.connectAgent({ agent });
  });
  expect(alertText()).toHaveLength(0);
});

it('clears a failed current turn after a later successful run', async () => {
  await mountChat();
  await act(async () => {
    root.root.findByProps({ 'aria-label': 'Message your Dot' }).props.onChange({
      target: { value: 'Hello' },
    });
  });
  await act(async () => {
    root.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
  });
  expect(alertText()).toContain(
    'The current turn returned no response. Check the runtime connection and retry.',
  );
  expect(
    root.root.findAllByProps({ 'aria-label': 'Stop response' }),
  ).toHaveLength(0);
  await act(async () => {
    await applySdkEvents(runFinished('recovered-success'));
  });
  expect(alertText()).toHaveLength(0);
});

it('shows a new failure after a successful run clears the previous error', async () => {
  await mountChat();
  await act(async () => {
    await applySdkEvents(runError('prior-failed', 'Old run failed'));
    await applySdkEvents(runFinished('recovered-success'));
  });
  expect(alertText()).toHaveLength(0);
  expect(root.root.findAllByProps({ children: 'Reconnect' })).toHaveLength(0);
  await act(async () => {
    await applySdkEvents(runError('new-failed', 'New run failed'));
  });
  expect(alertText()).toContain('New run failed');
  expect(root.root.findByProps({ children: 'Reconnect' })).toBeDefined();
});

it('does not treat an interrupted run as a successful recovery', async () => {
  await mountChat();
  await act(async () => {
    await applySdkEvents(runError('previous-failed', 'Previous run failed'));
    await applySdkEvents(runFinished('interrupted-retry', 'interrupt'));
  });
  expect(alertText()).toContain('Previous run failed');
});

it('runs local Dream as an app command and preserves its draft on server failure', async () => {
  harness.agent.addMessage.mockClear();
  harness.copilotkit.runAgent.mockClear();
  harness.api.mockImplementation(async (path: string) =>
    path.endsWith('/memory-jobs')
      ? { jobs: [], changes: [], coverage: { complete: true } }
      : null,
  );
  await act(async () => {
    root = create(createElement(Chat, { ...props, localMemory: true }));
  });
  const settings = () => root.root.findByProps({ className: 'chat-settings' });
  expect(settings().props.hidden).toBe(true);
  const composer = () => root.root.findByProps({ className: 'chat-composer' });
  const draft = () => composer().findByType('textarea');
  await act(async () =>
    draft().props.onChange({ target: { value: '/dream' } }),
  );
  harness.api.mockImplementation(async (path: string) => {
    if (path.endsWith('/dream')) throw new Error('Storage unavailable');
    return { jobs: [], changes: [], coverage: { complete: true } };
  });
  await act(async () => composer().props.onSubmit({ preventDefault() {} }));
  expect(settings().props.hidden).toBe(false);
  expect(draft().props.value).toBe('/dream');
  expect(harness.agent.addMessage).not.toHaveBeenCalled();
  expect(harness.copilotkit.runAgent).not.toHaveBeenCalled();
  harness.api.mockImplementation(async (path: string) =>
    path.endsWith('/memory-jobs')
      ? {
          jobs: [
            {
              id: 'j',
              kind: 'dream',
              state: 'queued',
              origin: 'manual',
              modelCalls: 0,
            },
          ],
          changes: [],
          coverage: { complete: true },
        }
      : { id: 'j' },
  );
  await act(async () => composer().props.onSubmit({ preventDefault() {} }));
  expect(draft().props.value).toBe('');
  expect(JSON.stringify(root.toJSON())).toContain('Queued');
  expect(harness.agent.addMessage).not.toHaveBeenCalled();
  expect(harness.copilotkit.runAgent).not.toHaveBeenCalled();
});
it('does not show local memory controls in hosted chat', async () => {
  await mountChat();
  expect(JSON.stringify(root.toJSON())).not.toContain('Memory activity');
});

it('submits a final voice transcript once through the chat agent and preserves the draft', async () => {
  harness.agent.addMessage.mockClear();
  harness.copilotkit.runAgent.mockClear();
  harness.copilotkit.runAgent.mockResolvedValueOnce({
    newMessages: [{ role: 'assistant' }],
  });
  await mountChat();
  const draft = () =>
    root.root.findByProps({ 'aria-label': 'Message your Dot' });
  await act(async () =>
    draft().props.onChange({
      target: { value: 'My unfinished typed thought' },
    }),
  );
  await act(async () =>
    harness.localVoiceOptions!.onTranscript({
      messageId: 'voice-final-id',
      text: 'Hello from voice',
    }),
  );
  await act(async () =>
    harness.localVoiceOptions!.onTranscript({
      messageId: 'voice-final-id',
      text: 'Hello from voice',
    }),
  );
  expect(harness.agent.addMessage).toHaveBeenCalledExactlyOnceWith({
    id: 'voice-final-id',
    role: 'user',
    content: 'Hello from voice',
  });
  expect(harness.copilotkit.runAgent).toHaveBeenCalledExactlyOnceWith({
    agent: harness.agent,
    runId: expect.any(String),
  });
  expect(draft().props.value).toBe('My unfinished typed thought');
});

it('cancels only its voice run without reporting intentional interruption as failure', async () => {
  harness.copilotkit.stopAgent.mockClear();
  let resolve!: (result: { newMessages: { role: string }[] }) => void;
  harness.copilotkit.runAgent.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await mountChat();
  await act(async () => {
    const pending = harness.localVoiceOptions!.onTranscript({
      messageId: 'cancel-me',
      text: 'Hello',
    });
    await harness.localVoiceOptions!.onCancelTranscript('unrelated');
    expect(harness.copilotkit.stopAgent).not.toHaveBeenCalled();
    const stopped = harness.localVoiceOptions!.onCancelTranscript('cancel-me');
    resolve({ newMessages: [] });
    await Promise.all([pending, stopped]);
  });
  expect(harness.copilotkit.stopAgent).toHaveBeenCalledExactlyOnceWith({
    agent: harness.agent,
  });
  expect(alertText()).toEqual([]);
});

it('accepts the next voice turn after cancellation before React commits the idle render', async () => {
  let resolve!: (result: { newMessages: { role: string }[] }) => void;
  harness.copilotkit.runAgent.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  harness.copilotkit.runAgent.mockResolvedValueOnce({
    newMessages: [{ role: 'assistant' }],
  });
  harness.agent.addMessage.mockClear();
  await mountChat();
  let first!: Promise<void>;
  await act(async () => {
    first = harness.localVoiceOptions!.onTranscript({
      messageId: 'first-voice',
      text: 'First thought',
    });
  });
  await act(async () => {
    const stopped =
      harness.localVoiceOptions!.onCancelTranscript('first-voice');
    resolve({ newMessages: [] });
    await Promise.all([first, stopped]);
    await harness.localVoiceOptions!.onTranscript({
      messageId: 'second-voice',
      text: 'Actually, second thought',
    });
  });
  expect(harness.agent.addMessage).toHaveBeenCalledTimes(2);
  expect(alertText()).toEqual([]);
});

it('waits for the previous call to finish saving before consuming a fresh Talk', async () => {
  harness.localVoiceStatus = 'ending';
  const target = new EventTarget();
  const activate = vi.fn(async () => {
    target.dispatchEvent(new Event('dot-voice-start'));
  });
  vi.stubGlobal(
    'window',
    Object.assign(target, {
      dotVoice: { activate, setReady: vi.fn(async () => {}) },
    }),
  );
  const consumed = vi.fn();
  const next = {
    ...props,
    localVoiceReady: true,
    voiceIntent: 2,
    onVoiceConsumed: consumed,
  };
  await act(async () => {
    root = create(createElement(Chat, next));
  });
  expect(consumed).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  harness.localVoiceStatus = 'idle';
  await act(async () => root.update(createElement(Chat, { ...next })));
  expect(activate).toHaveBeenCalledOnce();
  expect(harness.startLocalVoice).toHaveBeenCalledOnce();
  expect(consumed).toHaveBeenCalledOnce();
});
