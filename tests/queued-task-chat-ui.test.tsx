import { createElement, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HttpAgent } from '@ag-ui/client';

const harness = vi.hoisted(() => {
  const agent = {
    agentId: 'chat-worker',
    threadId: 'worker',
    messages: [],
    state: {},
    pendingInterrupts: [],
    addMessage: vi.fn(),
    subscribe: vi.fn(() => ({ unsubscribe() {} })),
  };
  return {
    agent,
    reviews: [] as Array<{
      name: string;
      render: (props: unknown) => { props: { threadId: string } };
    }>,
    target: { threadId: 'parent', dotId: 'dot', taskId: 'job' } as null | {
      threadId: string;
      dotId: string;
      taskId: string;
    },
    api: vi.fn<(path: string) => Promise<unknown>>(),
    copilotkit: {
      subscribe: vi.fn(() => ({ unsubscribe() {} })),
      connectAgent: vi.fn(async () => ({})),
      stopAgent: vi.fn(),
      runAgent: vi.fn(async () => ({ newMessages: [{ role: 'assistant' }] })),
    },
  };
});
vi.mock('../src/client/api', () => ({
  api: harness.api,
  authHeaders: () => ({}),
}));
vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotChatToolCallsView: () => null,
  useRenderTool: vi.fn(),
  useHumanInTheLoop: (review: (typeof harness.reviews)[number]) => {
    harness.reviews.push(review);
  },
  useAgent: ({ threadId }: { threadId: string }) => {
    harness.agent.threadId = threadId;
    return { agent: harness.agent, isReady: true };
  },
  useCopilotKit: () => ({ copilotkit: harness.copilotkit }),
}));
vi.mock('../src/client/PageReviewCard', () => ({ PageReviewCard: () => null }));
vi.mock('../src/client/ConnectionActionCard', () => ({
  ConnectionActionCard: () => null,
}));
vi.mock('../src/client/FolderAccessCard', () => ({
  FolderAccessCard: () => null,
}));
vi.mock('../src/client/FolderAccessSettings', () => ({
  FolderAccessSettings: () => null,
}));
vi.mock('../src/client/ComputerToolCard', () => ({
  ComputerToolCard: () => null,
}));
vi.mock('../src/client/ChatTranscript', () => ({
  ChatTranscript: () => null,
  isInternalVoiceReceipt: () => false,
  revealChatMessage: vi.fn(),
}));
vi.mock('../src/client/Mascot', () => ({ Mascot: () => null }));
vi.mock('../src/client/CallView', () => ({ CallView: () => null }));
vi.mock('../src/client/local-voice/VoiceSettings', () => ({
  VoiceSettings: () => null,
}));
vi.mock('../src/client/local-voice/VoiceTasks', () => ({
  useVoiceTasks: () => ({
    jobs: [],
    error: '',
    stopping: undefined,
    stop: vi.fn(),
  }),
}));
vi.mock('../src/client/abilities/AbilityResultCard', () => ({
  AbilityToolCard: () => null,
  RecentAbilityResults: () => null,
}));
vi.mock('../src/client/useVoice', () => ({
  useVoice: () => ({ status: 'idle', error: '', end: vi.fn() }),
}));
vi.mock('../src/client/local-voice/useLocalVoice', () => ({
  useLocalVoice: () => ({
    status: 'idle',
    error: '',
    start: vi.fn(),
    end: vi.fn(),
    interrupt: vi.fn(),
  }),
}));

import { Chat } from '../src/client/Chat';

const props: Parameters<typeof Chat>[0] = {
  thread: {
    id: 'worker',
    dotId: 'dot',
    ownerId: 'owner',
    title: 'Voice task',
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
let root: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {});
  vi.clearAllMocks();
  harness.agent.messages = [];
  harness.agent.addMessage.mockReset();
  harness.reviews.length = 0;
  harness.target = { threadId: 'parent', dotId: 'dot', taskId: 'job' };
  harness.api.mockImplementation(async (path) =>
    path.endsWith('/chat-target')
      ? harness.target
      : path === '/message-marks'
        ? []
        : null,
  );
  harness.copilotkit.connectAgent.mockImplementation(async () => ({}));
  harness.copilotkit.runAgent.mockImplementation(async () => ({
    newMessages: [{ role: 'assistant' }],
  }));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});
const draft = () =>
  root!.root.findByProps({ 'aria-label': 'Message your Dot' });
async function submit(text: string) {
  await act(async () => draft().props.onChange({ target: { value: text } }));
  expect(
    root!.root.findByProps({ 'aria-label': 'Send message' }).props.disabled,
  ).toBe(false);
  await act(async () =>
    root!.root.findByType('form').props.onSubmit({ preventDefault() {} }),
  );
}

it('routes typed worker text once while the worker connection is busy and leaves approvals bound to the worker', async () => {
  harness.copilotkit.connectAgent.mockImplementation(
    () => new Promise(() => {}),
  );
  const continueChat = vi.fn(() => true);
  await act(async () => {
    root = create(
      createElement(Chat, { ...props, onContinueChat: continueChat }),
    );
  });
  await submit('Please tell me the current status.');
  expect(continueChat).toHaveBeenCalledExactlyOnceWith(
    harness.target,
    'Please tell me the current status.',
  );
  expect(harness.agent.addMessage).not.toHaveBeenCalled();
  expect(harness.copilotkit.runAgent).not.toHaveBeenCalled();
  expect(harness.reviews.length).toBeGreaterThan(0);
  for (const review of harness.reviews)
    expect(review.render({}).props.threadId).toBe('worker');
});

it('keeps draft and source when the canonical parent becomes unavailable', async () => {
  const continueChat = vi.fn(() => true);
  await act(async () => {
    root = create(
      createElement(Chat, { ...props, onContinueChat: continueChat }),
    );
  });
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': 'Add source page link' })
      .props.onClick(),
  );
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': 'Source page URL' })
      .props.onChange({ target: { value: 'https://example.test/context' } }),
  );
  harness.api.mockImplementation(async (path) => {
    if (path.endsWith('/chat-target')) throw Error('Conversation not found.');
    return null;
  });
  await submit('Keep this thought.');
  expect(draft().props.value).toBe('Keep this thought.');
  expect(
    root!.root.findByProps({ 'aria-label': 'Source page URL' }).props.value,
  ).toBe('https://example.test/context');
  expect(continueChat).not.toHaveBeenCalled();
  expect(harness.copilotkit.runAgent).not.toHaveBeenCalled();
  expect(JSON.stringify(root!.toJSON())).toContain('Conversation not found.');
});

it('transfers a task follow-up and its source, then submits once in the parent', async () => {
  harness.api.mockImplementation(async (path) =>
    path === '/conversations/worker/chat-target'
      ? harness.target
      : path === '/message-marks'
        ? []
        : null,
  );
  function Conversation() {
    const [threadId, setThreadId] = useState('worker');
    const [initialPrompt, setInitialPrompt] = useState<string>();
    return createElement(Chat, {
      ...props,
      key: threadId,
      thread: { ...props.thread, id: threadId },
      initialPrompt,
      onConsumed: () => setInitialPrompt(undefined),
      onContinueChat: (target, text) => {
        setThreadId(target.threadId);
        setInitialPrompt(text);
        return true;
      },
    });
  }
  await act(async () => {
    root = create(createElement(Conversation));
  });
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': 'Add source page link' })
      .props.onClick(),
  );
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': 'Source page URL' })
      .props.onChange({ target: { value: 'https://example.test/context' } }),
  );
  await submit('What does this mean?');
  expect(harness.agent.threadId).toBe('parent');
  expect(harness.agent.addMessage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      role: 'user',
      content: 'From https://example.test/context:\n\nWhat does this mean?',
    }),
  );
  expect(harness.copilotkit.runAgent).toHaveBeenCalledOnce();
  expect(draft().props.value).toBe('');
});

it('submits a transferred parent prompt once and restores its draft on a busy failure', async () => {
  harness.target = null;
  harness.copilotkit.runAgent.mockRejectedValueOnce(
    Error('Thread already running.'),
  );
  const consumed = vi.fn();
  const next = {
    ...props,
    thread: { ...props.thread, id: 'parent' },
    initialPrompt: 'Keep this follow-up.',
    onConsumed: consumed,
  };
  await act(async () => {
    root = create(createElement(Chat, next));
  });
  expect(consumed).toHaveBeenCalledOnce();
  expect(harness.copilotkit.runAgent).toHaveBeenCalledOnce();
  expect(draft().props.value).toBe('Keep this follow-up.');
  await act(async () => root!.update(createElement(Chat, next)));
  expect(harness.copilotkit.runAgent).toHaveBeenCalledOnce();
});

it('keeps a transferred prompt visible when parent connection fails before submission', async () => {
  harness.target = null;
  harness.copilotkit.connectAgent.mockRejectedValueOnce(
    Error('Connection unavailable.'),
  );
  await act(async () => {
    root = create(
      createElement(Chat, {
        ...props,
        thread: { ...props.thread, id: 'parent' },
        initialPrompt: 'Keep my question.',
      }),
    );
  });
  expect(draft().props.value).toBe('Keep my question.');
  expect(harness.copilotkit.runAgent).not.toHaveBeenCalled();
});

it('keeps ordinary standalone text on its own conversation', async () => {
  harness.target = null;
  const continueChat = vi.fn(() => true);
  await act(async () => {
    root = create(
      createElement(Chat, {
        ...props,
        thread: { ...props.thread, id: 'ordinary' },
        onContinueChat: continueChat,
      }),
    );
  });
  await submit('Hello.');
  expect(continueChat).not.toHaveBeenCalled();
  expect(harness.agent.addMessage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ role: 'user', content: 'Hello.' }),
  );
  expect(harness.copilotkit.runAgent).toHaveBeenCalledOnce();
});

it.each(['Edited before connection.', ''])(
  'preserves an edited transferred draft without auto-sending the old text (%j)',
  async (edited) => {
    harness.target = null;
    let connected!: () => void;
    harness.copilotkit.connectAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          connected = () => resolve({});
        }),
    );
    await act(async () => {
      root = create(
        createElement(Chat, {
          ...props,
          thread: { ...props.thread, id: 'parent' },
          initialPrompt: 'Original transfer.',
        }),
      );
    });
    await act(async () =>
      draft().props.onChange({ target: { value: edited } }),
    );
    await act(async () => connected());
    expect(harness.copilotkit.runAgent).not.toHaveBeenCalled();
    expect(draft().props.value).toBe(edited);
  },
);

it('does not submit a late handoff after leaving the task view', async () => {
  const continueChat = vi.fn(() => true);
  await act(async () => {
    root = create(
      createElement(Chat, { ...props, onContinueChat: continueChat }),
    );
  });
  let resolved!: () => void;
  harness.api.mockImplementation((path) =>
    path.endsWith('/chat-target')
      ? new Promise((resolve) => {
          resolved = () => resolve(harness.target);
        })
      : Promise.resolve(null),
  );
  await submit('Do not send after navigation.');
  await act(async () => root!.unmount());
  root = undefined;
  await act(async () => resolved());
  expect(continueChat).not.toHaveBeenCalled();
});

it('retains edits made while parent resolution is pending instead of navigating with stale text', async () => {
  const continueChat = vi.fn(() => true);
  await act(async () => {
    root = create(
      createElement(Chat, { ...props, onContinueChat: continueChat }),
    );
  });
  let resolved!: () => void;
  harness.api.mockImplementation((path) =>
    path.endsWith('/chat-target')
      ? new Promise((resolve) => {
          resolved = () => resolve(harness.target);
        })
      : Promise.resolve(null),
  );
  await submit('Original thought.');
  await act(async () =>
    draft().props.onChange({ target: { value: 'Revised thought.' } }),
  );
  await act(async () => resolved());
  expect(continueChat).not.toHaveBeenCalled();
  expect(draft().props.value).toBe('Revised thought.');
});

it('reuses the real SDK optimistic message when manually retrying a rejected transferred prompt', async () => {
  harness.target = null;
  const actual = new HttpAgent({
    url: 'http://127.0.0.1:1',
    threadId: 'parent',
  });
  harness.agent.addMessage.mockImplementation((message) => {
    actual.addMessage(message);
    harness.agent.messages = actual.messages as never[];
  });
  const inputs: unknown[][] = [];
  harness.copilotkit.runAgent.mockImplementation(async () => {
    inputs.push(structuredClone(actual.messages));
    if (inputs.length === 1) throw Error('Thread already running.');
    return { newMessages: [{ role: 'assistant' }] };
  });
  await act(async () => {
    root = create(
      createElement(Chat, {
        ...props,
        thread: { ...props.thread, id: 'parent' },
        initialPrompt: 'Retry this question.',
      }),
    );
  });
  expect(inputs).toHaveLength(1);
  await submit('Retry this question.');
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toEqual(inputs[0]);
  expect(actual.messages).toHaveLength(1);
  await submit('Retry this question.');
  expect(inputs).toHaveLength(3);
  expect(actual.messages).toHaveLength(2);
  expect(actual.messages[1].id).not.toBe(actual.messages[0].id);
});

it('keeps a newer handoff pending when the cancelled lookup completes', async () => {
  const continueChat = vi.fn(() => true);
  await act(async () => {
    root = create(
      createElement(Chat, { ...props, onContinueChat: continueChat }),
    );
  });
  const resolutions: Array<() => void> = [];
  harness.api.mockImplementation((path) =>
    path.endsWith('/chat-target')
      ? new Promise((resolve) => {
          resolutions.push(() => resolve(harness.target));
        })
      : Promise.resolve(null),
  );
  await submit('Old thought.');
  await submit('New thought.');
  await act(async () => resolutions[0]());
  expect(continueChat).not.toHaveBeenCalled();
  expect(
    root!.root.findByProps({ 'aria-label': 'Send message' }).props.disabled,
  ).toBe(true);
  await act(async () => resolutions[1]());
  expect(continueChat).toHaveBeenCalledExactlyOnceWith(
    harness.target,
    'New thought.',
  );
});

it.each(['Revised after send.', ''])(
  'preserves a draft edited during a rejected transfer (%j)',
  async (edited) => {
    harness.target = null;
    let reject!: () => void;
    harness.copilotkit.runAgent.mockImplementation(
      () =>
        new Promise((_resolve, rejectRun) => {
          reject = () => rejectRun(Error('Thread already running.'));
        }),
    );
    await act(async () => {
      root = create(
        createElement(Chat, {
          ...props,
          thread: { ...props.thread, id: 'parent' },
          initialPrompt: 'Original transfer.',
        }),
      );
    });
    await act(async () =>
      draft().props.onChange({ target: { value: edited } }),
    );
    await act(async () => reject());
    expect(draft().props.value).toBe(edited);
    expect(harness.copilotkit.runAgent).toHaveBeenCalledOnce();
  },
);
