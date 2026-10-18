import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Chat } from '../src/client/Chat';
const harness = vi.hoisted(() => ({
  register: vi.fn(),
  agent: {
    messages: [
      {
        id: 'request-message',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'folder-call',
            type: 'function',
            function: {
              name: 'review_local_folder_access',
              arguments: '{"requestId":"d213a4fb-4476-4af8-90d1-c48b2a6c5100"}',
            },
          },
        ],
      },
    ],
  },
}));
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
vi.mock('@copilotkit/react-core/v2', () => ({
  useHumanInTheLoop: harness.register,
  useRenderTool: vi.fn(),
  useAgent: () => ({ agent: harness.agent, isReady: true }),
  useCopilotKit: () => ({ copilotkit: {} }),
  CopilotChatToolCallsView: ({
    message,
  }: {
    message: { toolCalls: Array<{ id: string }> };
  }) => <div>{message.toolCalls.map((call) => call.id).join(',')}</div>,
}));
vi.mock('../src/client/Mascot', () => ({ Mascot: () => null }));
vi.mock('../src/client/useVoice', () => ({
  useVoice: () => ({ status: 'idle' }),
}));
vi.mock('../src/client/local-voice/useLocalVoice', () => ({
  useLocalVoice: () => ({ status: 'idle' }),
}));
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
  onConsumed() {},
  voiceReady: false,
  calls: [],
  paused: false,
  onSaved() {},
  onSchedule() {},
};
beforeEach(() => {
  harness.register.mockClear();
});
afterEach(() => vi.unstubAllGlobals());
it.each([true, false])(
  'advertises the review tool only with the native picker, while retaining historical cards: desktop=$0',
  (desktop) => {
    vi.stubGlobal('window', desktop ? { dotFolders: { choose: vi.fn() } } : {});
    const html = renderToStaticMarkup(<Chat {...props} />);
    const registration = harness.register.mock.calls.find(
      ([tool]) => tool.name === 'review_local_folder_access',
    )?.[0];
    expect(registration).toMatchObject({ available: desktop });
    expect(html).toContain('folder-call');
    expect(html).toContain('Folder access');
  },
);
