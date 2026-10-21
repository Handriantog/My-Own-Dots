import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FolderApprovalApp } from '../src/client/FolderApprovalApp';
import { FolderAccessCard } from '../src/client/FolderAccessCard';
import type { FolderApprovalPending } from '../src/shared/folder-access';

const harness = vi.hoisted(() => ({
  register: vi.fn(),
  connect: vi.fn(async () => ({})),
  subscribe: vi.fn(),
  useAgent: vi.fn(),
  respond: vi.fn(async () => {}),
  authHeaders: vi.fn(() => ({ Authorization: 'Bearer owner' })),
  rendered: [] as Array<{ toolCalls: Array<{ id: string }> }>,
}));
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: harness.authHeaders,
}));
vi.mock('../src/client/FolderAccessCard', () => ({
  FolderAccessCard: (props: { toolCallId: string }) => (
    <div data-card={props.toolCallId} />
  ),
}));
vi.mock('@copilotkit/react-core/v2', () => {
  const copilotkit = {
    connectAgent: harness.connect,
    subscribe: harness.subscribe,
  };
  return {
    CopilotKitProvider: ({ children }: { children: ReactNode }) => children,
    CopilotChatConfigurationProvider: ({ children }: { children: ReactNode }) =>
      children,
    useHumanInTheLoop: harness.register,
    useAgent: harness.useAgent,
    useCopilotKit: () => ({ copilotkit }),
    CopilotChatToolCallsView: ({
      message,
    }: {
      message: {
        toolCalls: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
      };
    }) => {
      harness.rendered.push(message);
      return message.toolCalls.map((call) => {
        const tool = harness.register.mock.calls.findLast(
          ([tool]) => tool.name === call.function.name,
        )?.[0];
        return (
          <div key={call.id}>
            {tool.render({
              args: JSON.parse(call.function.arguments),
              status: 'executing',
              toolCallId: call.id,
              respond: harness.respond,
            })}
          </div>
        );
      });
    },
  };
});
const request: FolderApprovalPending = {
  requestId: 'd213a4fb-4476-4af8-90d1-c48b2a6c5100',
  threadId: 'thread',
  dotId: 'dot',
  dotName: 'Scout',
  toolCallId: 'folder-call',
};
const another = {
  ...request,
  threadId: 'another-thread',
  toolCallId: 'another-call',
};
const call = (id: string, name = 'review_local_folder_access') => ({
  id,
  type: 'function' as const,
  function: {
    name,
    arguments: JSON.stringify({ requestId: request.requestId }),
  },
});
const agent = {
  agentId: 'chat-thread',
  threadId: 'thread',
  isRunning: false,
  messages: [
    {
      id: 'message',
      role: 'assistant' as const,
      content: 'private conversation',
      toolCalls: [
        call('other-call', 'request_page_review'),
        call('folder-call'),
      ],
    },
  ],
  subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
};
let root: ReactTestRenderer | undefined;
let state = { request: request as FolderApprovalPending | null, count: 2 };
let listener: (value: typeof state) => void;
let bridge: {
  state: ReturnType<typeof vi.fn>;
  onState: ReturnType<typeof vi.fn>;
  dismiss: ReturnType<typeof vi.fn>;
  next: ReturnType<typeof vi.fn>;
};
let subscribers: Array<Record<string, (payload: unknown) => unknown>>;
const text = () => JSON.stringify(root!.toJSON());
const button = (label: string) =>
  root!.root.findByProps({ 'aria-label': label });
const emit = (key: string, payload: unknown) => {
  for (const subscriber of [...subscribers]) subscriber[key]?.(payload);
};
async function mount() {
  await act(async () => {
    root = create(createElement(FolderApprovalApp));
  });
}
function active(toolCallId = 'folder-call') {
  emit('onToolExecutionStart', {
    agentId: 'chat-thread',
    toolCallId,
    toolName: 'review_local_folder_access',
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state = { request, count: 2 };
  subscribers = [];
  harness.register.mockClear();
  harness.rendered = [];
  harness.respond.mockReset().mockResolvedValue(undefined);
  harness.connect.mockReset().mockImplementation(async () => {
    active();
    return {};
  });
  harness.subscribe.mockImplementation((subscriber) => {
    subscribers.push(subscriber);
    return {
      unsubscribe: () => {
        subscribers = subscribers.filter((item) => item !== subscriber);
      },
    };
  });
  harness.useAgent.mockReset().mockReturnValue({ agent, isReady: true });
  bridge = {
    state: vi.fn(async () => state),
    onState: vi.fn((callback) => {
      listener = callback;
      return vi.fn();
    }),
    dismiss: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
  };
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      dotApproval: bridge,
      dotFolders: { choose: vi.fn() },
    }),
  );
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});
it('connects the selected durable thread and renders only its folder call with matching capabilities', async () => {
  await mount();
  expect(harness.useAgent).toHaveBeenCalledWith({
    agentId: 'chat-thread',
    runtimeAgentId: 'dot',
    threadId: 'thread',
  });
  expect(harness.connect).toHaveBeenCalledExactlyOnceWith({ agent });
  expect(text()).toContain('Scout');
  expect(
    root!.root
      .findAllByType('span')
      .some((node) => node.children.join('') === '2 requests'),
  ).toBe(true);
  expect(text()).not.toContain('private conversation');
  expect(harness.rendered.at(-1)?.toolCalls.map((tool) => tool.id)).toEqual([
    'folder-call',
  ]);
  const registrations = harness.register.mock.calls.map(([tool]) => tool);
  expect(registrations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'review_local_folder_access',
        available: true,
      }),
      expect.objectContaining({ name: 'review_space_page' }),
      expect.objectContaining({ name: 'request_connection_action' }),
    ]),
  );
  expect(root!.root.findByType(FolderAccessCard).props.respond).toBeTypeOf(
    'function',
  );
  expect(root!.root.findByType(FolderAccessCard).props.compact).toBe(true);
  expect(harness.respond).not.toHaveBeenCalled();
});
it('close and Next only invoke the narrow host controls', async () => {
  await mount();
  expect(root!.root.findAllByProps({ 'aria-label': 'Later' })).toHaveLength(0);
  await act(async () => button('Next request').props.onClick());
  await act(async () => button('Close folder approval').props.onClick());
  expect(bridge.dismiss).toHaveBeenCalledOnce();
  expect(bridge.next).toHaveBeenCalledOnce();
  expect(harness.respond).not.toHaveBeenCalled();
});
it('keeps an earlier state fetch from replacing a newer host selection', async () => {
  let resolve!: (value: typeof state) => void;
  bridge.state.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await mount();
  await act(async () => listener({ request: another, count: 1 }));
  await act(async () => resolve({ request, count: 2 }));
  expect(harness.useAgent.mock.calls.at(-1)?.[0].threadId).toBe(
    'another-thread',
  );
  expect(
    root!.root.findAllByProps({ 'aria-label': 'Next request' }),
  ).toHaveLength(0);
});
it('does not enable a selected call while a different HITL resolver is active', async () => {
  harness.connect.mockImplementationOnce(async () => {
    active('earlier-call');
    return {};
  });
  await mount();
  expect(root!.root.findByType(FolderAccessCard).props.respond).toBeUndefined();
  expect(text()).toContain('earlier request');
  await act(async () => active());
  expect(root!.root.findByType(FolderAccessCard).props.respond).toBeTypeOf(
    'function',
  );
});
it('rejects stale response callbacks after the selected request changes', async () => {
  await mount();
  const respond = root!.root.findByType(FolderAccessCard).props.respond;
  await act(async () => listener({ request: another, count: 1 }));
  await expect(respond({ approved: false })).rejects.toThrow(
    'no longer selected',
  );
  expect(harness.respond).not.toHaveBeenCalled();
});
it('keeps the runtime registered when the host removes a completed request', async () => {
  await mount();
  await act(async () => listener({ request: null, count: 0 }));
  expect(text()).toContain('No folder requests');
  expect(harness.useAgent.mock.calls.at(-1)?.[0].threadId).toBe('thread');
  expect(root!.root.findAllByType(FolderAccessCard)).toHaveLength(0);
});
it('offers a retry after host loading fails', async () => {
  bridge.state.mockRejectedValueOnce(new Error('Desktop unavailable'));
  await mount();
  expect(text()).toContain('Desktop unavailable');
  await act(async () => button('Retry folder approvals').props.onClick());
  expect(text()).toContain('Scout');
});
it('reconnects a failed automatic continuation so the saved decision remains resumable', async () => {
  await mount();
  await act(async () =>
    root!.root.findByType(FolderAccessCard).props.respond({ approved: false }),
  );
  await act(async () =>
    emit('onError', {
      error: new Error('Resume disconnected'),
      code: 'agent_run_failed',
      context: { agentId: 'chat-thread', threadId: 'thread' },
    }),
  );
  expect(harness.connect).toHaveBeenCalledTimes(2);
  expect(text()).toContain('Resume disconnected');
  expect(root!.root.findByType(FolderAccessCard).props.respond).toBeTypeOf(
    'function',
  );
});
