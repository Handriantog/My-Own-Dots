import {
  createElement,
  useEffect,
  useReducer,
  useState,
  type ReactNode,
} from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  AbstractAgent,
  EventType,
  type AgentSubscriber,
  type BaseEvent,
  type Message,
  type RunAgentInput,
  type RunAgentParameters,
} from '@ag-ui/client';
import { from, Subject, throwError } from 'rxjs';
import type { FolderApprovalState } from '../src/desktop/shared/approval-contract';
import { CopilotKitCoreReact } from '@copilotkit/react-core/v2/context';
import { FolderApprovalApp } from '../src/client/FolderApprovalApp';
import { FolderAccessCard } from '../src/client/FolderAccessCard';

const harness = vi.hoisted(() => ({
  agent: undefined as unknown as AbstractAgent,
  core: undefined as unknown as CopilotKitCoreReact,
  api: vi.fn(),
}));
vi.mock('../src/client/api', () => ({
  api: harness.api,
  authHeaders: () => ({}),
}));
vi.mock('@copilotkit/react-core/v2', async () => {
  const sdk = await import('@copilotkit/react-core/v2/headless');
  const { CopilotKitContext } =
    await import('@copilotkit/react-core/v2/context');
  return {
    ...sdk,
    CopilotKitProvider: ({ children }: { children: ReactNode }) => {
      const [executing, setExecuting] = useState<ReadonlySet<string>>(
        new Set(),
      );
      useEffect(() => {
        const subscription = harness.core.subscribe({
          onToolExecutionStart: ({ toolCallId }) =>
            setExecuting((current) => new Set([...current, toolCallId])),
          onToolExecutionEnd: ({ toolCallId }) =>
            setExecuting(
              (current) =>
                new Set([...current].filter((id) => id !== toolCallId)),
            ),
        });
        return () => subscription.unsubscribe();
      }, []);
      return (
        <CopilotKitContext.Provider
          value={{ copilotkit: harness.core, executingToolCallIds: executing }}
        >
          {children}
        </CopilotKitContext.Provider>
      );
    },
    CopilotChatToolCallsView: ({
      message,
      messages,
    }: {
      message: Extract<Message, { role: 'assistant' }>;
      messages: Message[];
    }) => {
      const renderTool = sdk.useRenderToolCall();
      return (
        <>
          {message.toolCalls?.map((toolCall) =>
            renderTool({
              toolCall,
              toolMessage: messages.find(
                (value): value is Extract<Message, { role: 'tool' }> =>
                  value.role === 'tool' && value.toolCallId === toolCall.id,
              ),
            }),
          )}
        </>
      );
    },
    useAgent: () => {
      const [, render] = useReducer((n) => n + 1, 0);
      useEffect(() => {
        const subscription = harness.agent.subscribe({
          onMessagesChanged: () => render(),
          onRunFinalized: () => render(),
        });
        return () => subscription.unsubscribe();
      }, []);
      return { agent: harness.agent, isReady: true };
    },
  };
});
const request = {
  requestId: 'd213a4fb-4476-4af8-90d1-c48b2a6c5100',
  threadId: 'thread',
  dotId: 'dot',
  dotName: 'Scout',
  toolCallId: 'folder-call',
};
const decision = { approved: false, message: 'Folder access declined.' };
const toolCall = {
  id: 'folder-call',
  type: 'function' as const,
  function: {
    name: 'review_local_folder_access',
    arguments: JSON.stringify({ requestId: request.requestId }),
  },
};
const pendingMessages: Extract<Message, { role: 'assistant' }>[] = [
  {
    id: 'assistant-request',
    role: 'assistant',
    content: 'private transcript',
    toolCalls: [toolCall],
  },
];
class ApprovalAgent extends AbstractAgent {
  snapshot: Message[] = structuredClone(pendingMessages);
  runs: RunAgentInput[] = [];
  failNextRun = false;
  connections = 0;
  heldRun?: Subject<BaseEvent>;
  beforeFinish?: () => void;
  run(input: RunAgentInput) {
    this.runs.push(structuredClone(input));
    if (this.failNextRun) {
      this.failNextRun = false;
      return throwError(() => new Error('Resume transport failed'));
    }
    if (this.heldRun) return this.heldRun;
    this.snapshot = structuredClone(input.messages);
    this.beforeFinish?.();
    return from([
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      },
    ] satisfies BaseEvent[]);
  }
  async connectAgent(
    _parameters?: RunAgentParameters,
    _subscriber?: AgentSubscriber,
  ) {
    this.connections++;
    this.setMessages(structuredClone(this.snapshot));
    return { newMessages: [], result: undefined };
  }
}
let agent: ApprovalAgent;
let root: ReactTestRenderer | undefined;
let hostState: (value: FolderApprovalState) => void;
let saved = false;
const base = `/conversations/thread/folder-requests/${request.requestId}`;
async function mount() {
  await act(async () => {
    root = create(createElement(FolderApprovalApp));
  });
}
function button(label: string) {
  return root!.root.findByProps({ 'aria-label': label });
}
async function waitForRuns(count: number) {
  // The SDK yields a macrotask before starting its automatic follow-up.
  await act(async () => {
    await vi.waitFor(() => expect(agent.runs).toHaveLength(count));
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  agent = new ApprovalAgent({ agentId: 'chat-thread', threadId: 'thread' });
  harness.agent = agent;
  harness.core = new CopilotKitCoreReact({
    agents__unsafe_dev_only: { 'chat-thread': agent },
  });
  saved = false;
  harness.api.mockReset().mockImplementation(async (path, method) => {
    if (path === `${base}/decision` && method === 'POST') {
      saved = true;
      return decision;
    }
    if (path === base || path === `${base}/resolve`)
      return {
        request: {
          id: request.requestId,
          threadId: 'thread',
          dotId: 'dot',
          reason: 'Read project notes',
          folderHint: '',
          requestedAccess: 'read',
          status: saved ? 'declined' : 'pending',
          expiresAt: Date.now() + 60000,
        },
        ...(saved ? { decision } : {}),
      };
    throw new Error(`Unexpected API request ${path}`);
  });
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      location: { hostname: 'workspace' },
      dotApproval: {
        state: async () => ({ request, count: 1 }),
        onState: (callback: typeof hostState) => {
          hostState = callback;
          return () => {};
        },
        next: async () => {},
        dismiss: async () => {},
      },
      dotFolders: { choose: vi.fn() },
    }),
  );
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});
it('uses real SDK HITL replay and automatic continuation with the full capability set', async () => {
  await mount();
  expect(agent.runs).toHaveLength(0);
  expect(button('Decline folder access')).toBeDefined();
  await act(async () => button('Decline folder access').props.onClick());
  expect(saved).toBe(true);
  await waitForRuns(1);
  expect(agent.runs[0].messages).toContainEqual(
    expect.objectContaining({
      role: 'tool',
      toolCallId: 'folder-call',
      content: JSON.stringify(decision),
    }),
  );
  expect(agent.runs[0].tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      'review_local_folder_access',
      'review_space_page',
      'request_connection_action',
    ]),
  );
});
it('restores Continue after the real SDK automatic resume fails without saving another grant', async () => {
  agent.failNextRun = true;
  await mount();
  await act(async () => button('Decline folder access').props.onClick());
  expect(saved).toBe(true);
  await waitForRuns(1);
  expect(button('Continue conversation').props.disabled).toBe(false);
  await act(async () => button('Continue conversation').props.onClick());
  await waitForRuns(2);
  expect(
    agent.runs[1].messages.filter((message) => message.role === 'tool'),
  ).toHaveLength(1);
});
it('continues through host removal after the saved tool result reaches the runtime', async () => {
  agent.beforeFinish = () => hostState({ request: null, count: 0 });
  await mount();
  await act(async () => button('Decline folder access').props.onClick());
  await waitForRuns(1);
  expect(agent.isRunning).toBe(false);
  expect(JSON.stringify(root!.toJSON())).toContain('No folder requests');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(
    harness.core.getTool({
      toolName: 'review_local_folder_access',
      agentId: 'chat-thread',
    }),
  ).toBeUndefined();
});

it('waits for the matching SDK resolver when one thread has two pending folder calls', async () => {
  const secondRequest = {
    ...request,
    toolCallId: 'second-folder-call',
    requestId: 'f6144c1f-04a0-47af-82bd-a22bd32824dc',
  };
  agent.snapshot = [
    {
      ...pendingMessages[0],
      role: 'assistant',
      toolCalls: [
        toolCall,
        {
          ...toolCall,
          id: secondRequest.toolCallId,
          function: {
            ...toolCall.function,
            arguments: JSON.stringify({ requestId: secondRequest.requestId }),
          },
        },
      ],
    },
  ];
  await mount();
  await act(async () => hostState({ request: secondRequest, count: 2 }));
  expect(
    root!.root.findAllByProps({ 'aria-label': 'Decline folder access' }),
  ).toHaveLength(0);
  expect(agent.runs).toHaveLength(0);
  await act(async () => hostState({ request, count: 2 }));
  await act(async () => button('Decline folder access').props.onClick());
  expect(agent.runs).toHaveLength(0);
  harness.api.mockImplementation(async (path, method) => {
    if (method === 'POST') return decision;
    return {
      request: {
        id: secondRequest.requestId,
        threadId: 'thread',
        dotId: 'dot',
        reason: 'Read another folder',
        folderHint: '',
        requestedAccess: 'read',
        status: 'pending',
        expiresAt: Date.now() + 60000,
      },
    };
  });
  await act(async () => hostState({ request: secondRequest, count: 1 }));
  await act(async () => button('Decline folder access').props.onClick());
  await waitForRuns(1);
  expect(
    agent.runs[0].messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId),
  ).toEqual(['folder-call', 'second-folder-call']);
});

const nextRequest = {
  ...request,
  toolCallId: 'next-folder-call',
  requestId: 'f6144c1f-04a0-47af-82bd-a22bd32824dc',
};
function nextSnapshot(): Message[] {
  return [
    ...pendingMessages,
    {
      id: 'external-decision',
      role: 'tool',
      toolCallId: request.toolCallId,
      content: JSON.stringify(decision),
    },
    {
      id: 'next-request',
      role: 'assistant',
      toolCalls: [
        {
          ...toolCall,
          id: nextRequest.toolCallId,
          function: {
            ...toolCall.function,
            arguments: JSON.stringify({ requestId: nextRequest.requestId }),
          },
        },
      ],
    },
  ];
}
function serveNextRequest() {
  harness.api.mockImplementation(async (_path, method) =>
    method === 'POST' && !_path.endsWith('/resolve')
      ? decision
      : {
          request: {
            id: nextRequest.requestId,
            threadId: 'thread',
            dotId: 'dot',
            reason: 'Read the next folder',
            folderHint: '',
            requestedAccess: 'read',
            status: 'pending',
            expiresAt: Date.now() + 60000,
          },
        },
  );
}
it('refreshes a retained conversation when chat has answered its old request and produced a new one', async () => {
  await mount();
  expect(agent.connections).toBe(1);
  await act(async () => hostState({ request: null, count: 0 }));
  agent.snapshot = nextSnapshot();
  serveNextRequest();
  await act(async () => hostState({ request: nextRequest, count: 1 }));
  expect(agent.connections).toBe(2);
  expect(root!.root.findByType(FolderAccessCard).props.args).toEqual({
    requestId: nextRequest.requestId,
  });
  expect(button('Decline folder access')).toBeDefined();
  expect(agent.runs).toHaveLength(0);
  await act(async () => button('Decline folder access').props.onClick());
  await waitForRuns(1);
  expect(
    agent.runs[0].messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId),
  ).toEqual([request.toolCallId, nextRequest.toolCallId]);
});
it('keeps its own active continuation when the host announces its next request before the stream catches up', async () => {
  agent.heldRun = new Subject<BaseEvent>();
  await mount();
  await act(async () => button('Decline folder access').props.onClick());
  await waitForRuns(1);
  const input = agent.runs[0];
  await act(async () => {
    agent.heldRun!.next({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    });
  });
  serveNextRequest();
  await act(async () => hostState({ request: nextRequest, count: 1 }));
  expect(agent.connections).toBe(1);
  await act(async () => {
    agent.heldRun!.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: nextSnapshot(),
    });
    agent.heldRun!.next({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    });
    agent.heldRun!.complete();
  });
  expect(agent.connections).toBe(1);
  expect(button('Decline folder access')).toBeDefined();
  expect(root!.root.findByType(FolderAccessCard).props.args).toEqual({
    requestId: nextRequest.requestId,
  });
});

it('refreshes external chat progress after answering only the first of two pending calls', async () => {
  agent.snapshot = nextSnapshot().filter((message) => message.role !== 'tool');
  await mount();
  await act(async () => button('Decline folder access').props.onClick());
  expect(agent.runs).toHaveLength(0);
  const third = {
    ...request,
    requestId: 'bbcb8c5e-b194-4237-938e-6087f80ac5c3',
    toolCallId: 'third-folder-call',
  };
  agent.snapshot = [
    ...nextSnapshot(),
    {
      id: 'second-external-decision',
      role: 'tool',
      toolCallId: nextRequest.toolCallId,
      content: JSON.stringify(decision),
    },
    {
      id: 'third-request',
      role: 'assistant',
      toolCalls: [
        {
          ...toolCall,
          id: third.toolCallId,
          function: {
            ...toolCall.function,
            arguments: JSON.stringify({ requestId: third.requestId }),
          },
        },
      ],
    },
  ];
  harness.api.mockImplementation(async (_path, method) =>
    method === 'POST' && !_path.endsWith('/resolve')
      ? decision
      : {
          request: {
            id: third.requestId,
            threadId: 'thread',
            dotId: 'dot',
            reason: 'Read the third folder',
            folderHint: '',
            requestedAccess: 'read',
            status: 'pending',
            expiresAt: Date.now() + 60000,
          },
        },
  );
  await act(async () => hostState({ request: third, count: 1 }));
  expect(agent.connections).toBe(2);
  expect(button('Decline folder access')).toBeDefined();
  expect(root!.root.findByType(FolderAccessCard).props.args).toEqual({
    requestId: third.requestId,
  });
  expect(agent.runs).toHaveLength(0);
});
