import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions } from 'electron';
import type {
  WorkspaceBackend,
  WorkspaceBackendStatus,
} from '../../src/desktop/host/workspace-backend.js';
const host = vi.hoisted(() => ({
  windows: [] as WindowDouble[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipc: null as EventEmitter | null,
  external: vi.fn(),
}));
interface WindowDouble extends EventEmitter {
  options: BrowserWindowConstructorOptions;
  visible: boolean;
  webContents: EventEmitter & {
    mainFrame: { url: string };
    send: ReturnType<typeof vi.fn>;
    getURL(): string;
  };
  loadURL: ReturnType<typeof vi.fn>;
  destroy(): void;
}
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  host.ipc = Object.assign(new EventEmitter(), {
    handle: (name: string, fn: (...args: unknown[]) => unknown) =>
      host.handlers.set(name, fn),
    removeHandler: (name: string) => host.handlers.delete(name),
  });
  return {
    ipcMain: host.ipc,
    dialog: { showOpenDialog: vi.fn() },
    shell: { openExternal: host.external },
    screen: {
      getAllDisplays: () => [
        { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      ],
    },
    BrowserWindow: class extends EventEmitter {
      visible = false;
      destroyed = false;
      webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: '' },
        send: vi.fn(),
        getURL: () => this.webContents.mainFrame.url,
        session: {
          setPermissionCheckHandler() {},
          setPermissionRequestHandler() {},
        },
        setWindowOpenHandler: vi.fn(),
        reload: vi.fn(),
      });
      constructor(readonly options: BrowserWindowConstructorOptions) {
        super();
        host.windows.push(this);
      }
      loadURL = vi.fn(async (url: string) => {
        this.webContents.mainFrame.url = url;
        this.webContents.emit('did-finish-load');
      });
      isDestroyed() {
        return this.destroyed;
      }
      isVisible() {
        return this.visible;
      }
      isFocused() {
        return this.visible;
      }
      isMinimized() {
        return false;
      }
      restore() {}
      focus() {}
      show() {
        this.visible = true;
      }
      hide() {
        this.visible = false;
        this.emit('hide');
      }
      getNormalBounds() {
        return { x: 0, y: 0, width: 1280, height: 840 };
      }
      destroy() {
        this.destroyed = true;
        this.emit('closed');
      }
    },
  };
});
import { WorkspaceWindow } from '../../src/desktop/host/workspace-window.js';
import {
  destination,
  destinationFromUrl,
} from '../../src/desktop/host/workspace-navigation.js';
let data: string;
let workspace: WorkspaceWindow;
let notify: (status: WorkspaceBackendStatus) => void;
let backend: {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  status: WorkspaceBackendStatus;
  subscribe: (fn: typeof notify) => () => void;
};
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null)),
  );
  data = await mkdtemp(path.join(os.tmpdir(), 'dots-window-'));
  host.windows = [];
  host.external.mockClear();
  backend = {
    status: { phase: 'idle', message: 'Starting' },
    stop: vi.fn(async () => notify({ phase: 'stopped', message: 'Stopped' })),
    start: vi.fn(async () => ({
      url: 'http://127.0.0.1:5999',
      owned: true,
      ownerToken: 'private',
    })),
    subscribe: (fn) => {
      notify = fn;
      return () => {};
    },
  };
  workspace = new WorkspaceWindow(
    '/bundle',
    data,
    backend as unknown as WorkspaceBackend,
    vi.fn(),
  );
});
afterEach(async () => {
  await workspace.destroy();
  vi.unstubAllGlobals();
  host.handlers.clear();
  host.ipc?.removeAllListeners();
  await rm(data, { recursive: true, force: true });
});
it('opens a bundled isolated main window and reuses it for dirty-page-safe handoff', async () => {
  await workspace.open();
  const window = host.windows[0];
  expect(window.options.webPreferences).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  });
  expect(window.options.titleBarStyle).toBe('hiddenInset');
  const count = window.loadURL.mock.calls.length;
  await workspace.open({ dotId: 'dot-1', threadId: 'thread-1' });
  expect(host.windows).toHaveLength(1);
  expect(window.loadURL).toHaveBeenCalledWith(
    'dots://workspace/?surface=workspace',
  );
  expect(window.loadURL).toHaveBeenCalledTimes(count);
  expect(window.webContents.send).toHaveBeenCalledWith(
    'dot:workspace:navigate',
    { dotId: 'dot-1', threadId: 'thread-1' },
  );
  const preventDefault = vi.fn();
  window.emit('close', { preventDefault });
  expect(preventDefault).toHaveBeenCalled();
  expect(window.visible).toBe(false);
  await workspace.open();
  expect(window.visible).toBe(true);
});
it('preserves loaded drafts after backend failure and retry', async () => {
  await workspace.open();
  const window = host.windows[0];
  const count = window.loadURL.mock.calls.length;
  notify({ phase: 'error', message: 'Service stopped. Retry.' });
  expect(workspace.activeConnection).toBeUndefined();
  expect(window.webContents.send).toHaveBeenCalledWith('dot:workspace:status', {
    phase: 'error',
    message: 'Service stopped. Retry.',
  });
  await workspace.retry();
  expect(window.loadURL).toHaveBeenCalledTimes(count);
});
it('uses recovery for initial startup failure then loads the bundled renderer on retry', async () => {
  backend.start.mockRejectedValueOnce(new Error('failure'));
  await workspace.open();
  expect(host.windows[0].webContents.getURL()).toBe('dots://app/recovery.html');
  await workspace.retry();
  expect(host.windows[0].webContents.getURL()).toBe(
    'dots://workspace/?surface=workspace',
  );
});
it('keeps native command navigation local and refuses foreign frames', async () => {
  await workspace.command('settings');
  const window = host.windows[0];
  expect(window.webContents.send).toHaveBeenCalledWith(
    'dot:workspace:command',
    'settings',
  );
  const status = host.handlers.get('dot:workspace:status')!;
  expect(() =>
    status({ sender: {}, senderFrame: window.webContents.mainFrame }),
  ).toThrow('Invalid workspace sender');
  expect(
    status({
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    }),
  ).toEqual(backend.status);
  await expect(
    host.handlers.get('dot:workspace:configure')!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      { PORT: '5998' },
    ),
  ).rejects.toThrow('recovery');
});
it.each([
  { dotId: '../secret' },
  { threadId: 'orphan' },
  { pageId: 'orphan' },
  { dotId: 'dot', spaceId: 'space' },
  { url: 'https://evil' },
])('rejects malformed destination %j', (value) =>
  expect(() => destination(value)).toThrow(),
);
it('blocks external navigations and opens only explicit HTTP links in the browser', async () => {
  await workspace.open();
  const window = host.windows[0];
  const preventDefault = vi.fn();
  window.webContents.emit(
    'will-navigate',
    { preventDefault },
    'https://example.com',
  );
  expect(preventDefault).toHaveBeenCalled();
  expect(host.external).toHaveBeenCalledWith('https://example.com');
  host.external.mockClear();
  window.webContents.emit('will-navigate', { preventDefault }, 'dots://evil/');
  expect(host.external).not.toHaveBeenCalled();
});
it('waits for cold startup before sending an internal handoff', async () => {
  let release!: () => void;
  backend.start.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ url: 'http://127.0.0.1:5999', owned: true });
      }),
  );
  const opening = workspace.open();
  await vi.waitFor(() => expect(release).toBeDefined());
  const handoff = workspace.open({ spaceId: 'space-1', pageId: 'page-1' });
  await Promise.resolve();
  expect(host.windows[0].webContents.send).not.toHaveBeenCalledWith(
    'dot:workspace:navigate',
    expect.anything(),
  );
  release();
  await opening;
  await handoff;
  expect(host.windows[0].webContents.getURL()).toBe(
    'dots://workspace/?surface=workspace',
  );
  expect(host.windows[0].webContents.send).toHaveBeenCalledWith(
    'dot:workspace:navigate',
    { spaceId: 'space-1', pageId: 'page-1' },
  );
});
it('opens separate backend setup while retaining the loaded workspace', async () => {
  await workspace.open();
  const main = host.windows[0];
  const count = main.loadURL.mock.calls.length;
  await workspace.openBackendSettings();
  expect(host.windows).toHaveLength(2);
  expect(host.windows[1].webContents.getURL()).toBe('dots://app/recovery.html');
  await workspace.retry();
  expect(main.loadURL).toHaveBeenCalledTimes(count);
  expect(host.windows[1].webContents.getURL()).toBe('dots://app/recovery.html');
  await workspace.openBackendSettings();
  expect(host.windows).toHaveLength(2);
});
it('accepts omitted optional IDs and maps internal page/thread links without admitting foreign schemes', () => {
  expect(destination({ dotId: 'dot-1', threadId: undefined })).toEqual({
    dotId: 'dot-1',
  });
  expect(destinationFromUrl('dots://workspace/#/chat/dot-1/thread-1')).toEqual({
    dotId: 'dot-1',
    threadId: 'thread-1',
  });
  expect(
    destinationFromUrl(
      'dots://workspace/?surface=companion#/spaces/space-1/pages/page-1',
    ),
  ).toEqual({ spaceId: 'space-1', pageId: 'page-1' });
  expect(
    destinationFromUrl('https://example.com/#/chat/dot-1'),
  ).toBeUndefined();
  expect(destinationFromUrl('dots://evil/#/chat/dot-1')).toBeUndefined();
});
it('reports transport failure and retries the backend without reloading loaded drafts', async () => {
  await workspace.open();
  const main = host.windows[0];
  const count = main.loadURL.mock.calls.length;
  workspace.transportFailed();
  expect(main.webContents.send).toHaveBeenCalledWith(
    'dot:workspace:status',
    expect.objectContaining({ phase: 'error' }),
  );
  await workspace.retry();
  expect(backend.stop).toHaveBeenCalledOnce();
  expect(backend.start).toHaveBeenCalledTimes(2);
  expect(main.loadURL).toHaveBeenCalledTimes(count);
});
