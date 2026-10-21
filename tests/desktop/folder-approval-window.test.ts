import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FolderApprovalPending } from '../../src/shared/folder-access.js';
import type { WorkspaceBackendConnection } from '../../src/desktop/host/workspace-backend.js';

const host = vi.hoisted(() => ({
  windows: [] as WindowDouble[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipc: null as EventEmitter | null,
}));
class WindowDouble extends EventEmitter {
  visible = false;
  focused = false;
  destroyed = false;
  bounds: unknown;
  options: unknown;
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: '' },
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
  });
  constructor(options: unknown) {
    super();
    this.options = options;
    host.windows.push(this);
  }
  async loadURL(url: string) {
    this.webContents.mainFrame.url = url;
  }
  isVisible() {
    return this.visible;
  }
  isFocused() {
    return this.focused;
  }
  isMinimized() {
    return false;
  }
  isDestroyed() {
    return this.destroyed;
  }
  setBounds(bounds: unknown) {
    this.bounds = bounds;
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  showInactive() {
    this.visible = true;
  }
  show() {
    this.visible = true;
  }
  focus() {
    this.focused = true;
  }
  hide() {
    this.visible = false;
    this.emit('hide');
  }
  destroy() {
    this.destroyed = true;
    this.visible = false;
    this.emit('closed');
  }
}
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  host.ipc = Object.assign(new EventEmitter(), {
    handle: (name: string, fn: (...args: unknown[]) => unknown) =>
      host.handlers.set(name, fn),
    removeHandler: (name: string) => host.handlers.delete(name),
  });
  return {
    BrowserWindow: WindowDouble,
    ipcMain: host.ipc,
    dialog: { showOpenDialog: vi.fn() },
  };
});

const a: FolderApprovalPending = {
  requestId: 'a',
  toolCallId: 'ta',
  threadId: 'thread-a',
  dotId: 'dot-a',
  dotName: 'Scout',
};
const b: FolderApprovalPending = { ...a, requestId: 'b', toolCallId: 'tb' };
let connection: WorkspaceBackendConnection | undefined;
let requests: FolderApprovalPending[];
let panel: import('../../src/desktop/host/folder-approval-window.js').FolderApprovalWindow;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const bounds = { x: 50, y: 100, width: 420, height: 510 };
function sender(window = host.windows.at(-1)!) {
  return {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
}
function invoke(action: string, event = sender(), ...args: unknown[]) {
  return host.handlers.get(`dot:approval:${action}`)!(event, ...args);
}
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
beforeEach(async () => {
  host.windows = [];
  host.handlers.clear();
  connection = {
    url: 'http://127.0.0.1:4310/',
    ownerToken: 'test-owner',
    owned: true,
  };
  requests = [a];
  fetcher = vi.fn<typeof fetch>(async () => Response.json(requests));
  const { FolderApprovalWindow } =
    await import('../../src/desktop/host/folder-approval-window.js');
  panel = new FolderApprovalWindow(
    '/bundle',
    () => connection,
    () => bounds,
    () => {},
    fetcher,
  );
  panel.sync(true);
  await panel.refresh();
  await flush();
});
afterEach(() => {
  panel?.destroy();
  host.ipc?.removeAllListeners();
});

it('opens beside Dot without stealing focus and keeps credentials in main', () => {
  const window = host.windows[0];
  expect(window?.visible).toBe(true);
  expect(window.focused).toBe(false);
  expect(window.bounds).toEqual(bounds);
  expect(invoke('state')).toEqual({ request: a, count: 1 });
  expect(fetcher).toHaveBeenCalledWith(
    new URL('http://127.0.0.1:4310/api/folder-approvals'),
    expect.objectContaining({
      headers: { authorization: 'Bearer test-owner' },
      redirect: 'error',
    }),
  );
  expect(JSON.stringify(invoke('state'))).not.toContain('test-owner');
});

it('Later keeps the request pending without reopening it on every poll; Review reopens it', async () => {
  host.windows[0].focused = true;
  invoke('dismiss');
  expect(panel.isOpen).toBe(false);
  expect(panel.count).toBe(1);
  await panel.refresh();
  expect(panel.isOpen).toBe(false);
  host.windows[0].focused = false;
  panel.review(false);
  await flush();
  expect(panel.isOpen).toBe(true);
  expect(host.windows[0].focused).toBe(false);
  host.windows[0].focused = true;
  invoke('dismiss');
  panel.review();
  await flush();
  expect(panel.isOpen).toBe(true);
  expect(
    fetcher.mock.calls.every(
      ([, options]) => !options?.method || options.method === 'GET',
    ),
  ).toBe(true);
});

it('advances to other requests and drops decisions resolved from chat', async () => {
  requests = [a, b];
  await panel.refresh();
  host.windows[0].focused = true;
  invoke('next');
  expect(invoke('state')).toEqual({ request: b, count: 2 });
  requests = [a];
  await panel.refresh();
  expect(invoke('state')).toEqual({ request: a, count: 1 });
  requests = [];
  await panel.refresh();
  expect(panel.isOpen).toBe(false);
});

it('hides on suspension and prevents a poll from resurfacing the panel until Dot returns', async () => {
  panel.sync(false);
  await panel.refresh();
  expect(panel.isOpen).toBe(false);
  panel.sync(true);
  await flush();
  expect(panel.isOpen).toBe(true);
});

it('rejects foreign frames, pages, unavailable controls and caller arguments', () => {
  const window = host.windows[0];
  expect(() => invoke('dismiss')).toThrow();
  window.focused = true;
  expect(() =>
    invoke('state', {
      ...sender(),
      senderFrame: { url: window.webContents.mainFrame.url },
    }),
  ).toThrow();
  expect(() => invoke('dismiss', sender(), { requestId: 'other' })).toThrow();
  window.webContents.mainFrame.url = 'dots://workspace/?surface=companion';
  expect(() => invoke('state')).toThrow();
});

it('invalidates old windows and in-flight responses on workspace changes', async () => {
  let resolve!: (value: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = panel.refresh();
  const previous = host.windows[0];
  connection = undefined;
  panel.sync(true);
  expect(previous.destroyed).toBe(true);
  resolve(Response.json([b]));
  await pending;
  expect(panel.count).toBe(0);
  expect(panel.isOpen).toBe(false);
});

it('closes stale controls while offline and resumes after a healthy poll', async () => {
  fetcher.mockRejectedValueOnce(new Error('offline'));
  await panel.refresh();
  expect(panel.isOpen).toBe(false);
  await panel.refresh();
  await flush();
  expect(panel.isOpen).toBe(true);
});

it('does not send owner credentials to non-loopback or ambiguous addresses', async () => {
  for (const url of [
    'https://example.com/',
    'http://127.0.0.1:4310/proxy',
    'http://user@localhost:4310/',
  ]) {
    connection = { url, ownerToken: 'private', owned: false };
    panel.sync(true);
    fetcher.mockClear();
    await panel.refresh();
    expect(fetcher).not.toHaveBeenCalled();
    expect(panel.isOpen).toBe(false);
  }
});
