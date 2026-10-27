import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Conversation } from '../src/shared/types';

const harness = vi.hoisted(() => ({
  api: vi.fn(),
  talk: undefined as (() => void) | undefined,
  chat: undefined as (() => void) | undefined,
  stop: undefined as (() => void) | undefined,
}));
vi.mock('../src/client/api', () => ({
  api: harness.api,
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setToken() {},
}));
vi.mock('../src/client/setup-telemetry', () => ({ trackSetupStep() {} }));
vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../src/client/Chat', () => ({ Chat: () => null }));
vi.mock('../src/client/CallView', () => ({ CallView: () => null }));
vi.mock('../src/client/Mascot', () => ({ Mascot: () => null }));
vi.mock('../src/client/MemoryPanel', () => ({ MemoryPanel: () => null }));
vi.mock('../src/client/MemoryActivity', () => ({ MemoryActivity: () => null }));
vi.mock('../src/client/SpaceNav', () => ({ SpaceNav: () => null }));
vi.mock('../src/client/SpaceWorkspace', () => ({ SpaceWorkspace: () => null }));
vi.mock('../src/client/ThreadList', () => ({ ThreadList: () => null }));
vi.mock('../src/client/ResultPane', () => ({ ResultPane: () => null }));
vi.mock('../src/client/TaskPresentation', () => ({ TaskRow: () => null }));
vi.mock('../src/client/TaskActions', () => ({ TaskActions: () => null }));
vi.mock('../src/client/WorkspaceDialog', () => ({
  WorkspaceDialog: () => null,
}));

import { App } from '../src/client/App';
import { Chat } from '../src/client/Chat';
import { CallView } from '../src/client/CallView';
import { VoiceSettings } from '../src/client/local-voice/VoiceSettings';

const thread = (id: string): Conversation => ({
  id,
  dotId: 'dot',
  ownerId: 'owner',
  title: id,
  createdAt: 0,
});
let conversations: Conversation[];
let root: ReactTestRenderer;
let storage: Map<string, string>;
let bridge: {
  cancelTalk: ReturnType<typeof vi.fn>;
  setReady: ReturnType<typeof vi.fn>;
};
let documentTarget: EventTarget & { visibilityState: string };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  storage = new Map();
  conversations = [thread('first'), thread('selected')];
  harness.api.mockReset();
  harness.api.mockImplementation(async (path: string, method?: string) => {
    if (path === '/state')
      return {
        settings: { paused: false, name: 'Owner' },
        tasks: [],
        memories: [],
      };
    if (path === '/workspace')
      return {
        dots: [
          { id: 'dot', name: 'Dot', spaceId: 'space', spaceIds: ['space'] },
        ],
        spaces: [{ id: 'space', name: 'Space' }],
        conversations,
        calls: [],
        setup: {
          missing: [],
          voice: false,
          slack: 'disabled',
          conversationBackend: 'local',
          llmBackend: 'subscription',
        },
      };
    if (path.startsWith('/local-voice/status'))
      return { enabled: true, ready: true };
    if (path === '/conversations/daily' && method === 'POST') {
      const created = thread('created');
      conversations = [...conversations, created];
      return created;
    }
    return null;
  });
  bridge = { cancelTalk: vi.fn(), setReady: vi.fn() };
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      dotVoice: {
        ...bridge,
        onChat(callback: () => void) {
          harness.chat = callback;
          return () => {
            harness.chat = undefined;
          };
        },
        onTalk(callback: () => void) {
          harness.talk = callback;
          return () => {
            harness.talk = undefined;
          };
        },
        onStop(callback: () => void) {
          harness.stop = callback;
          return () => {
            harness.stop = undefined;
          };
        },
      },
    }),
  );
  documentTarget = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
  });
  vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('location', new URL('http://127.0.0.1:4310/?desktop=1'));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    root = create(createElement(App, { desktop: true }));
  });
}
const createdCalls = () =>
  harness.api.mock.calls.filter(
    ([path, method]) => path === '/conversations/daily' && method === 'POST',
  );

it('offers voice and personality settings before the first conversation', async () => {
  conversations = [];
  await mount();
  expect(root.root.findByType(VoiceSettings).props).toMatchObject({
    dotId: 'dot',
    callActive: false,
    previewReady: true,
  });
  expect(createdCalls()).toHaveLength(0);
});
it('offers quality settings while local speech is disabled and forwards the selected mode to chat', async () => {
  conversations = [];
  const normal = harness.api.getMockImplementation()!;
  harness.api.mockImplementation((path: string, method?: string) =>
    path.startsWith('/local-voice/status')
      ? Promise.resolve({
          enabled: false,
          ready: false,
          selectedQuality: 'basic',
          reason: 'Needs setup',
        })
      : normal(path, method),
  );
  await mount();
  expect(root.root.findByType(VoiceSettings).props.dotId).toBe('dot');
  expect(
    harness.api.mock.calls.some(
      ([path]) => path === '/local-voice/status?dotId=dot',
    ),
  ).toBe(true);
});

it.each(['basic', 'medium', 'high'] as const)(
  'only allows the legacy hosted voice transport for Medium when %s is selected',
  async (quality) => {
    storage.set('workspace-dot', 'dot');
    storage.set('workspace-thread', 'selected');
    const normal = harness.api.getMockImplementation()!;
    harness.api.mockImplementation(async (path: string, method?: string) => {
      if (path.startsWith('/local-voice/status'))
        return { enabled: false, ready: false, selectedQuality: quality };
      const result = await normal(path, method);
      if (path === '/workspace') result.setup.voice = true;
      return result;
    });
    await act(async () => {
      root = create(createElement(App));
    });
    const props = root.root.findByType(Chat).props;
    expect(props.localVoiceQuality).toBe(quality);
    expect(props.voiceReady).toBe(quality === 'medium');
  },
);

it('keeps native readiness through a transient status failure but revokes on confirmed unavailable', async () => {
  await mount();
  expect(bridge.setReady).toHaveBeenLastCalledWith(true);
  bridge.setReady.mockClear();
  const normal = harness.api.getMockImplementation()!;
  harness.api.mockImplementation((path: string, method?: string) =>
    path.startsWith('/local-voice/status')
      ? Promise.reject(new Error('Temporary connection failure'))
      : normal(path, method),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(bridge.setReady).not.toHaveBeenCalled();
  harness.api.mockImplementation((path: string, method?: string) =>
    path.startsWith('/local-voice/status')
      ? Promise.resolve({
          enabled: true,
          ready: false,
          reason: 'Worker unavailable',
        })
      : normal(path, method),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(bridge.setReady).toHaveBeenLastCalledWith(false);
});

it('resolves today before delivering native Talk instead of using the restored selection', async () => {
  storage.set('desktop-dot', 'dot');
  storage.set('desktop-thread', 'selected');
  await mount();
  expect(root.root.findByType(Chat).props.voiceIntent).toBe(0);
  await act(async () => harness.talk!());
  const props = root.root.findByType(Chat).props;
  expect(props.thread.id).toBe('created');
  expect(props.voiceIntent).toBe(1);
  expect(createdCalls()).toHaveLength(1);
  await act(async () => props.onVoiceConsumed());
  expect(root.root.findByType(Chat).props.voiceIntent).toBe(0);
  expect(bridge.cancelTalk).toHaveBeenCalled();
});

it('resolves the daily thread on first Talk and never restores its call intent on reload', async () => {
  await mount();
  await act(async () => harness.talk!());
  expect(root.root.findByType(Chat).props.thread.id).toBe('created');
  expect(createdCalls()).toHaveLength(1);
  await act(async () => root.unmount());
  await mount();
  expect(root.root.findByType(Chat).props.thread.id).toBe('created');
  expect(root.root.findByType(Chat).props.voiceIntent).toBe(0);
});

it('creates at most one conversation while first Talk waits and cancels a hidden intent', async () => {
  conversations = [];
  let release!: (value: Conversation) => void;
  const normal = harness.api.getMockImplementation()!;
  harness.api.mockImplementation((path: string, method?: string) =>
    path === '/conversations/daily' && method === 'POST'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : normal(path, method),
  );
  await mount();
  await act(async () => harness.talk!());
  expect(root.root.findByType(CallView).props.voice.status).toBe('connecting');
  expect(createdCalls()).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(createdCalls()).toHaveLength(1);
  await act(async () => {
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
  });
  conversations = [thread('created')];
  await act(async () => release(conversations[0]));
  expect(root.root.findAllByType(Chat)).toHaveLength(0);
  expect(bridge.cancelTalk).toHaveBeenCalled();
});

it('does not start in an old or worker thread while daily resolution is pending', async () => {
  storage.set('desktop-thread', 'selected');
  const normal = harness.api.getMockImplementation()!;
  let release!: (value: Conversation) => void;
  harness.api.mockImplementation((path: string, method?: string) =>
    path === '/conversations/daily'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : normal(path, method),
  );
  await mount();
  await act(async () => harness.talk!());
  expect(root.root.findByType(Chat).props.thread.id).toBe('selected');
  expect(root.root.findByType(Chat).props.voiceIntent).toBe(0);
  await act(async () => release(thread('today')));
  expect(root.root.findByType(Chat).props.thread.id).toBe('today');
  expect(root.root.findByType(Chat).props.voiceIntent).toBe(1);
});

it('Chat resolves today again on each native entry without requesting a call', async () => {
  storage.set('desktop-thread', 'selected');
  await mount();
  await act(async () => harness.chat!());
  expect(root.root.findByType(Chat).props.thread.id).toBe('created');
  expect(root.root.findByType(Chat).props.voiceIntent).toBe(0);
  const normal = harness.api.getMockImplementation()!;
  harness.api.mockImplementation((path: string, method?: string) =>
    path === '/conversations/daily'
      ? Promise.resolve(thread('tomorrow'))
      : normal(path, method),
  );
  await act(async () => harness.chat!());
  expect(root.root.findByType(Chat).props.thread.id).toBe('tomorrow');
});

it('keeps an active call in its original thread when Chat is reopened after midnight', async () => {
  storage.set('desktop-thread', 'selected');
  await mount();
  await act(async () =>
    root.root.findByType(Chat).props.onVoiceActive('dot', true),
  );
  await act(async () => harness.chat!());
  expect(root.root.findByType(Chat).props.thread.id).toBe('selected');
  expect(createdCalls()).toHaveLength(0);
});

it('does not let an older Chat resolution replace the next Talk destination', async () => {
  storage.set('desktop-thread', 'selected');
  const normal = harness.api.getMockImplementation()!;
  let release!: (value: Conversation) => void;
  let calls = 0;
  harness.api.mockImplementation((path: string, method?: string) =>
    path === '/conversations/daily'
      ? ++calls === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(thread('today'))
      : normal(path, method),
  );
  await mount();
  await act(async () => harness.chat!());
  await act(async () => harness.talk!());
  expect(root.root.findByType(Chat).props.thread.id).toBe('today');
  await act(async () => release(thread('yesterday')));
  expect(root.root.findByType(Chat).props.thread.id).toBe('today');
  expect(root.root.findByType(Chat).props.voiceIntent).toBe(1);
});

it('preserves a windowless Talk intent when hidden and cancels it on a native stop', async () => {
  Object.assign(window.dotVoice!, { isWindowless: () => true });
  await mount();
  await act(async () => harness.talk!());
  await act(async () => {
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
  });
  expect(root.root.findByType(Chat).props.voiceIntent).toBe(1);
  await act(async () => harness.stop!());
  expect(root.root.findByType(Chat).props.voiceIntent).toBe(0);
});

it('reports unavailable voice setup to the desktop before consuming a hidden Talk', async () => {
  const reportError = vi.fn();
  Object.assign(window.dotVoice!, { isWindowless: () => true, reportError });
  const normal = harness.api.getMockImplementation()!;
  harness.api.mockImplementation((path: string, method?: string) =>
    path.startsWith('/local-voice/status')
      ? Promise.resolve({
          enabled: false,
          ready: false,
          reason: 'Speech models need setup.',
        })
      : normal(path, method),
  );
  await mount();
  await act(async () => harness.talk!());
  expect(reportError).toHaveBeenCalledWith('Speech models need setup.');
  expect(reportError.mock.invocationCallOrder[0]).toBeLessThan(
    bridge.cancelTalk.mock.invocationCallOrder.at(-1)!,
  );
});

it('does not echo native stop as cancellation of a newer talk request', async () => {
  await mount();
  await act(async () => harness.talk!());
  bridge.cancelTalk.mockClear();
  await act(async () => {
    harness.stop!();
    harness.talk!();
  });
  expect(bridge.cancelTalk).not.toHaveBeenCalled();
  expect(root.root.findByType(Chat).props.voiceIntent).toBe(2);
});
