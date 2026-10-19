import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Conversation } from '../src/shared/types';

const harness = vi.hoisted(() => ({
  api: vi.fn(),
  talk: undefined as (() => void) | undefined,
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
import { SpaceWorkspace } from '../src/client/SpaceWorkspace';
import { WorkspaceRail } from '../src/client/WorkspaceShell';
import type {
  WorkspaceDestination,
  WorkspaceCommand,
  WorkspaceStatus,
} from '../src/desktop/shared/workspace-contract';
let navigate: (destination: WorkspaceDestination) => void;
let command: (command: WorkspaceCommand) => void;
let statusChanged: (status: WorkspaceStatus) => void;

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
    if (path === '/local-voice/status') return { enabled: true, ready: true };
    if (path === '/conversations' && method === 'POST') {
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
  Object.assign(window, {
    confirm: vi.fn(() => false),
    dotWorkspace: {
      onNavigate: (fn: typeof navigate) => {
        navigate = fn;
        return () => {};
      },
      onCommand: (fn: typeof command) => {
        command = fn;
        return () => {};
      },
      onStatus: (fn: typeof statusChanged) => {
        statusChanged = fn;
        return () => {};
      },
      status: async () => ({ phase: 'ready', message: 'Ready' }),
    },
  });
  vi.stubGlobal('history', { replaceState: vi.fn() });
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
    root = create(createElement(App, { surface: 'workspace' }));
  });
}
const createdCalls = () =>
  harness.api.mock.calls.filter(
    ([path, method]) => path === '/conversations' && method === 'POST',
  );

it('renders explicit workspace navigation and preserves a dirty page on native handoff and new chat', async () => {
  await mount();
  expect(root.root.findAllByType(WorkspaceRail)).toHaveLength(1);
  await act(async () => navigate({ spaceId: 'space' }));
  await act(async () =>
    root.root.findByType(SpaceWorkspace).props.onDirty(true),
  );
  await act(async () => navigate({ dotId: 'dot', threadId: 'selected' }));
  expect(root.root.findAllByType(SpaceWorkspace)).toHaveLength(1);
  expect(storage.get('workspace-thread')).toBe('');
  await act(async () => command('new-chat'));
  expect(createdCalls()).toHaveLength(0);
  expect(root.root.findAllByType(SpaceWorkspace)).toHaveLength(1);
  Object.assign(window, { confirm: () => true });
  await act(async () => navigate({ dotId: 'dot', threadId: 'selected' }));
  expect(root.root.findByType(Chat).props.thread.id).toBe('selected');
  expect(storage.get('workspace-thread')).toBe('selected');
});
it('queues native navigation while initial workspace data is loading', async () => {
  let release!: (value: unknown) => void;
  const normal = harness.api.getMockImplementation()!;
  harness.api.mockImplementation((path: string, method?: string) =>
    path === '/workspace'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : normal(path, method),
  );
  await mount();
  await act(async () => navigate({ dotId: 'dot', threadId: 'selected' }));
  await act(async () => release(await normal('/workspace')));
  expect(root.root.findByType(Chat).props.thread.id).toBe('selected');
});

it('restores the last workspace section and Space independently of companion selection', async () => {
  await mount();
  await act(async () => navigate({ spaceId: 'space', pageId: 'page' }));
  await act(async () => root.unmount());
  await mount();
  expect(root.root.findByType(SpaceWorkspace).props.pageId).toBe('page');
  expect(root.root.findByType(WorkspaceRail).props.view).toBe('space');
});

it('preserves the composer draft through a backend failure', async () => {
  await mount();
  const composer = root.root.findByProps({
    'aria-label': 'Start a conversation',
  });
  await act(async () =>
    composer.props.onChange({ target: { value: 'An unsent draft' } }),
  );
  await act(async () =>
    statusChanged({ phase: 'error', message: 'Backend stopped' }),
  );
  expect(
    root.root.findByProps({ 'aria-label': 'Start a conversation' }).props.value,
  ).toBe('An unsent draft');
  expect(
    root.root.findByProps({ className: 'backend-notice' }).props.role,
  ).toBe('status');
});
it('lets the native menu own shortcuts without duplicate renderer actions', async () => {
  await mount();
  await act(async () => command('new-chat'));
  const event = Object.assign(new Event('keydown'), {
    key: 'n',
    metaKey: true,
    ctrlKey: false,
  });
  await act(async () => {
    window.dispatchEvent(event);
  });
  expect(createdCalls()).toHaveLength(1);
});
