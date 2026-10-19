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
import { WorkspaceDialog } from '../src/client/WorkspaceDialog';
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

it('normalizes a restored deleted Space before rendering page navigation or Dot creation', async () => {
  storage.set(
    'workspace-navigation',
    JSON.stringify({ view: 'space', spaceId: 'deleted', pageId: 'wrong-page' }),
  );
  await mount();
  const space = root.root.findByType(SpaceWorkspace);
  expect(space.props.space.id).toBe('space');
  expect(space.props.pageId).toBeUndefined();
  await act(async () => space.props.onPage('new-page'));
  expect(JSON.parse(storage.get('workspace-navigation')!).spaceId).toBe(
    'space',
  );
  await act(async () =>
    root.root.findByType(SpaceWorkspace).props.onCreateDot(),
  );
  expect(root.root.findByType(WorkspaceDialog).props.dialog.spaceId).toBe(
    'space',
  );
});
it('clears a page selection when the selected Space disappears during refresh', async () => {
  await mount();
  await act(async () => navigate({ spaceId: 'space', pageId: 'old-page' }));
  const normal = harness.api.getMockImplementation()!;
  harness.api.mockImplementation(async (path: string, method?: string) => {
    const result = await normal(path, method);
    return path === '/workspace'
      ? { ...result, spaces: [{ id: 'replacement', name: 'Replacement' }] }
      : result;
  });
  await act(async () => root.root.findByType(SpaceWorkspace).props.onRefresh());
  expect(root.root.findByType(SpaceWorkspace).props).toMatchObject({
    space: { id: 'replacement' },
    pageId: undefined,
  });
  await act(async () =>
    root.root.findByType(SpaceWorkspace).props.onPage('replacement-page'),
  );
  expect(JSON.parse(storage.get('workspace-navigation')!).spaceId).toBe(
    'replacement',
  );
});
it('resets persisted identities on an explicit configuration reload even when IDs exist in both databases', async () => {
  storage.set('workspace-dot', 'dot');
  storage.set('workspace-thread', 'selected');
  storage.set(
    'workspace-navigation',
    JSON.stringify({ view: 'space', spaceId: 'space', pageId: 'old-page' }),
  );
  vi.stubGlobal(
    'location',
    new URL('dots://workspace/?surface=workspace&resetNavigation=1'),
  );
  await mount();
  expect(root.root.findByType(WorkspaceRail).props.view).toBe('chat');
  expect(root.root.findAllByType(Chat)).toHaveLength(0);
  expect(storage.get('workspace-thread')).toBe('');
});
it('shows a degraded warning with retry while keeping the composer, then clears it after recovery', async () => {
  await mount();
  const composer = root.root.findByProps({
    'aria-label': 'Start a conversation',
  });
  await act(async () =>
    composer.props.onChange({ target: { value: 'Retained draft' } }),
  );
  await act(async () =>
    statusChanged({
      phase: 'ready',
      message: 'Open Docker and retry.',
      warning: 'Open Docker and retry.',
    }),
  );
  expect(
    root.root.findByProps({ className: 'backend-notice' }).findByType('span')
      .children,
  ).toEqual(['Open Docker and retry.']);
  const footer = root.root.findByProps({ className: 'workspace-status' });
  expect(footer.findByType('strong').children).toEqual([
    'Workspace needs attention',
  ]);
  expect(footer.findByProps({ className: 'online-dot off' })).toBeDefined();
  await act(async () => statusChanged({ phase: 'ready', message: 'Ready' }));
  expect(
    root.root.findAllByProps({ className: 'backend-notice' }),
  ).toHaveLength(0);
  expect(composer.props.value).toBe('Retained draft');
});
it.each([
  ['error', 'Workspace disconnected'],
  ['stopped', 'Workspace stopped'],
  ['starting', 'Workspace connecting'],
])('shows an accurate footer during %s', async (phase, label) => {
  await mount();
  await act(async () =>
    statusChanged({ phase: phase as WorkspaceStatus['phase'], message: label }),
  );
  const footer = root.root.findByProps({ className: 'workspace-status' });
  expect(footer.findByType('strong').children).toEqual([label]);
  expect(footer.findByProps({ className: 'online-dot off' })).toBeDefined();
});

it('clears dormant compact navigation during an explicit workspace configuration change', async () => {
  storage.set('companion-dot', 'old-dot');
  storage.set('companion-thread', 'old-thread');
  storage.set(
    'companion-navigation',
    JSON.stringify({ view: 'space', spaceId: 'old-space' }),
  );
  storage.set('desktop-thread', 'legacy-thread');
  vi.stubGlobal(
    'location',
    new URL(
      'dots://workspace/?surface=workspace&resetNavigation=configuration-2',
    ),
  );
  await mount();
  expect(storage.get('companion-dot')).toBe('');
  expect(storage.get('companion-thread')).toBe('');
  expect(storage.get('companion-navigation')).toBe('');
  expect(storage.get('desktop-thread')).toBe('');
});

it('retains a recovered New Chat command until workspace data is available', async () => {
  let release!: (value: unknown) => void;
  const normal = harness.api.getMockImplementation()!;
  let waiting = true;
  harness.api.mockImplementation((path: string, method?: string) =>
    path === '/workspace' && waiting
      ? new Promise((resolve) => {
          release = resolve;
        })
      : normal(path, method),
  );
  await mount();
  await act(async () => command('new-chat'));
  expect(createdCalls()).toHaveLength(0);
  waiting = false;
  await act(async () => release(await normal('/workspace')));
  expect(createdCalls()).toHaveLength(1);
});
