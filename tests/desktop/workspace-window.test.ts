import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import {
  DEFAULT_ACCESSORIES,
  type Accessories,
} from '../../src/desktop/shared/accessories.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  BrowserWindow,
  dialog,
  type BrowserWindowConstructorOptions,
} from 'electron';
import type {
  WorkspaceBackend,
  WorkspaceBackendStatus,
} from '../../src/desktop/host/workspace-backend.js';
const host = vi.hoisted(() => ({
  windows: [] as WindowDouble[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipc: null as EventEmitter | null,
  external: vi.fn(),
  geometry: null as Promise<string> | null,
  load: null as Promise<void> | null,
}));
interface WindowDouble extends EventEmitter {
  options: BrowserWindowConstructorOptions;
  visible: boolean;
  webContents: EventEmitter & {
    mainFrame: { url: string };
    send: ReturnType<typeof vi.fn>;
    getURL(): string;
    executeJavaScript: ReturnType<typeof vi.fn>;
  };
  loadURL: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  show: ReturnType<typeof vi.fn>;
  destroy(): void;
}
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (file: string, encoding: 'utf8') =>
      host.geometry ?? actual.readFile(file, encoding),
  };
});
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  host.ipc = Object.assign(new EventEmitter(), {
    handle: (name: string, fn: (...args: unknown[]) => unknown) =>
      host.handlers.set(name, fn),
    removeHandler: (name: string) => host.handlers.delete(name),
  });
  return {
    ipcMain: host.ipc,
    safeStorage: { isEncryptionAvailable: () => false },
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(async () => ({ response: 1 })),
    },
    shell: { openExternal: host.external },
    screen: {
      getAllDisplays: () => [
        { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      ],
    },
    BrowserWindow: class extends EventEmitter {
      static fromWebContents(contents: unknown) {
        return host.windows.find((w) => w.webContents === contents);
      }
      visible = false;
      destroyed = false;
      webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: '' },
        send: vi.fn(),
        getURL: () => this.webContents.mainFrame.url,
        executeJavaScript: vi.fn(async (source: string) =>
          runInNewContext(source, {
            location: { href: this.webContents.mainFrame.url },
            URL,
            history: {
              state: { draft: 'keep' },
              replaceState: (_state: unknown, _title: string, url: string) => {
                this.webContents.mainFrame.url = url;
              },
            },
            window: {
              dispatchEvent: (event: Event) =>
                this.webContents.emit(event.type),
            },
            Event,
          }),
        ),
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
        if (host.load) await host.load;
        if (this.destroyed) throw new Error('Window destroyed during load');
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
      show = vi.fn(() => {
        if (this.destroyed) throw new Error('Showing destroyed window');
        this.visible = true;
      });
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
import { recoveryView } from '../../src/desktop/renderer/recovery-state.js';
import {
  destination,
  destinationFromUrl,
} from '../../src/desktop/host/workspace-navigation.js';
let data: string;
let appearanceColor: string;
let appearanceAccessories: Accessories;
let workspace: WorkspaceWindow;
let notify: (status: WorkspaceBackendStatus) => void;
let backend: {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  configure: ReturnType<typeof vi.fn>;
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
  host.geometry = null;
  host.load = null;
  vi.mocked(dialog.showMessageBox)
    .mockReset()
    .mockResolvedValue({ response: 1, checkboxChecked: false });
  host.external.mockClear();
  backend = {
    status: { phase: 'idle', message: 'Starting' },
    configure: vi.fn(async () => {}),
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
  appearanceColor = '#45a7ff';
  appearanceAccessories = { ...DEFAULT_ACCESSORIES };
  workspace = new WorkspaceWindow(
    '/bundle',
    data,
    backend as unknown as WorkspaceBackend,
    vi.fn(),
    undefined,
    () => appearanceColor,
    () => appearanceAccessories,
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
    'dots://workspace/?surface=workspace&dotColor=%2345a7ff',
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
it('binds storage IPC to the current trusted focused document', async () => {
  await workspace.open();
  const window = host.windows[0];
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  const choose = host.handlers.get('dot:storage:chooseBackupDirectory');
  expect(choose).toBeTypeOf('function');
  window.webContents.mainFrame.url = 'https://untrusted.invalid';
  await expect(Promise.resolve().then(() => choose!(event))).rejects.toThrow(
    /sender/i,
  );
  window.webContents.mainFrame.url = 'dots://workspace/?surface=workspace';
  vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
    canceled: true,
    filePaths: [],
  });
  expect(await choose!(event)).toBe(false);
  await workspace.destroy();
  expect(host.handlers.has('dot:storage:chooseBackupDirectory')).toBe(false);
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
    'dots://workspace/?surface=workspace&dotColor=%2345a7ff',
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
    'dots://workspace/?surface=workspace&dotColor=%2345a7ff',
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
  expect(host.windows[1].webContents.getURL()).toBe(
    'dots://app/recovery.html#setup',
  );
  await workspace.retry();
  expect(main.loadURL).toHaveBeenCalledTimes(count);
  expect(host.windows[1].webContents.getURL()).toBe(
    'dots://app/recovery.html#setup',
  );
  await workspace.openBackendSettings();
  expect(host.windows).toHaveLength(2);
});
it('keeps recovery actionable after a renderer crash with a healthy backend', async () => {
  await workspace.open();
  backend.status = { phase: 'ready', message: 'Workspace ready.' };
  const window = host.windows[0];
  window.webContents.emit('render-process-gone');
  expect(window.webContents.getURL()).toBe('dots://app/recovery.html');
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  const status = host.handlers.get('dot:workspace:status')!(
    event,
  ) as WorkspaceBackendStatus;
  expect(recoveryView(status).showActions).toBe(true);
  await host.handlers.get('dot:workspace:retry')!(event);
  expect(window.webContents.getURL()).toBe(
    'dots://workspace/?surface=workspace&dotColor=%2345a7ff',
  );
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it('makes teardown terminal while geometry is pending, including later activation and setup requests', async () => {
  const geometry = deferred<string>();
  host.geometry = geometry.promise;
  const pending = workspace.open({ dotId: 'dot-1' });
  await workspace.destroy();
  geometry.resolve('{}');
  await expect(pending).resolves.toBeUndefined();
  await workspace.open();
  await workspace.openBackendSettings();
  await workspace.retry();
  await workspace.ready();
  await workspace.command('new-chat');
  expect(host.windows).toHaveLength(0);
  expect(backend.start).not.toHaveBeenCalled();
  expect(workspace.activeConnection).toBeUndefined();
});
it.each(['workspace', 'setup'])(
  'cancels pending %s document loading without showing or starting after teardown',
  async (surface) => {
    const load = deferred<void>();
    host.load = load.promise;
    const pending =
      surface === 'workspace'
        ? workspace.open()
        : workspace.openBackendSettings();
    await vi.waitFor(() =>
      expect(host.windows[0]?.loadURL).toHaveBeenCalledOnce(),
    );
    const window = host.windows[0];
    await workspace.destroy();
    load.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.loadURL).toHaveBeenCalledOnce();
    expect(backend.start).not.toHaveBeenCalled();
  },
);
it.each(['resolve', 'reject'])(
  'does not resume startup after teardown when pending backend start later %ss',
  async (outcome) => {
    const started = deferred<{ url: string; owned: boolean }>();
    backend.start.mockReturnValueOnce(started.promise);
    const pending = workspace.open();
    await vi.waitFor(() => expect(backend.start).toHaveBeenCalledOnce());
    const window = host.windows[0];
    const loads = window.loadURL.mock.calls.length;
    await workspace.destroy();
    await backend.stop();
    window.show.mockClear();
    if (outcome === 'resolve')
      started.resolve({ url: 'http://127.0.0.1:5999', owned: true });
    else started.reject(new Error('Startup stopped'));
    await expect(pending).resolves.toBeUndefined();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.loadURL).toHaveBeenCalledTimes(loads);
    expect(backend.start).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(workspace.activeConnection).toBeUndefined();
  },
);
it('does not restart after a retry stop finishes during teardown', async () => {
  await workspace.open();
  const stop = deferred<void>();
  backend.stop.mockReturnValueOnce(stop.promise);
  workspace.transportFailed();
  const pending = workspace.retry();
  expect(backend.stop).toHaveBeenCalledOnce();
  await workspace.destroy();
  stop.resolve();
  await expect(pending).resolves.toBeUndefined();
  expect(backend.start).toHaveBeenCalledOnce();
  expect(workspace.activeConnection).toBeUndefined();
});
it('invalidates pending native configuration and rejects stale IPC after teardown', async () => {
  await workspace.open();
  await workspace.openBackendSettings();
  const setup = host.windows[1];
  const event = {
    sender: setup.webContents,
    senderFrame: setup.webContents.mainFrame,
  };
  const configure = host.handlers.get('dot:workspace:configure')!;
  const open = host.handlers.get('dot:workspace:open')!;
  const stop = deferred<void>();
  backend.stop.mockReturnValueOnce(stop.promise);
  const pending = configure(event, { PORT: '5999' });
  await vi.waitFor(() => expect(backend.stop).toHaveBeenCalledOnce());
  await workspace.destroy();
  stop.resolve();
  await expect(pending).resolves.toBeUndefined();
  expect(backend.configure).not.toHaveBeenCalled();
  expect(() => open(event, {})).toThrow('Invalid workspace sender');
});

function setupEvent() {
  const setup = host.windows.at(-1)!;
  return {
    sender: setup.webContents,
    senderFrame: setup.webContents.mainFrame,
  };
}
it('validates configuration before stopping or asking to discard loaded documents', async () => {
  await workspace.open();
  await workspace.openBackendSettings();
  await expect(
    host.handlers.get('dot:workspace:configure')!(setupEvent(), {
      NODE_OPTIONS: '--inspect',
    }),
  ).rejects.toThrow(/configuration/i);
  expect(dialog.showMessageBox).not.toHaveBeenCalled();
  expect(backend.stop).not.toHaveBeenCalled();
  expect(backend.configure).not.toHaveBeenCalled();
});
it('cancels configuration without changing the connection, documents or drafts', async () => {
  await workspace.open();
  await workspace.openBackendSettings();
  const main = host.windows[0];
  const count = main.loadURL.mock.calls.length;
  const connection = workspace.activeConnection;
  vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
    response: 0,
    checkboxChecked: false,
  });
  await expect(
    host.handlers.get('dot:workspace:configure')!(setupEvent(), {
      DATABASE_PATH: 'other.sqlite',
    }),
  ).rejects.toThrow(/cancelled/i);
  expect(backend.stop).not.toHaveBeenCalled();
  expect(backend.configure).not.toHaveBeenCalled();
  expect(workspace.activeConnection).toBe(connection);
  expect(main.loadURL).toHaveBeenCalledTimes(count);
});
it('resets main and compact documents on explicit configuration and refreshes transport before reload', async () => {
  await workspace.open();
  const compact = new BrowserWindow({});
  workspace.register(compact);
  await compact.loadURL('dots://workspace/?surface=companion');
  await workspace.openBackendSettings();
  const main = host.windows[0];
  const count = main.loadURL.mock.calls.length;
  await host.handlers.get('dot:workspace:configure')!(setupEvent(), {
    DATABASE_PATH: 'other.sqlite',
  });
  expect(dialog.showMessageBox).toHaveBeenCalledOnce();
  expect(backend.stop).toHaveBeenCalledOnce();
  expect(main.webContents.getURL()).toBe('dots://app/recovery.html');
  expect(compact.webContents.getURL()).toBe('dots://app/recovery.html');
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(null, {
      headers: {
        'content-security-policy': "connect-src 'self' wss://new.example",
      },
    }),
  );
  await workspace.retry();
  expect(main.loadURL).toHaveBeenCalledTimes(count + 2);
  expect(main.webContents.getURL()).toMatch(/resetNavigation=[\w-]+/);
  expect(compact.webContents.getURL()).toMatch(/resetNavigation=[\w-]+/);
  expect(workspace.activeConnection?.connectOrigin).toBe('wss://new.example');
});
it('replays commands issued during startup recovery only after the workspace loads', async () => {
  backend.start.mockRejectedValueOnce(new Error('failure'));
  await workspace.command('settings');
  const main = host.windows[0];
  expect(main.webContents.send).not.toHaveBeenCalledWith(
    'dot:workspace:command',
    'settings',
  );
  await workspace.retry();
  expect(main.webContents.send).toHaveBeenCalledWith(
    'dot:workspace:command',
    'settings',
  );
});
it('reports renderer load failure and can retry without restarting a healthy backend', async () => {
  backend.start.mockRejectedValueOnce(new Error('failure'));
  await workspace.open();
  const main = host.windows[0];
  main.loadURL.mockRejectedValueOnce(new Error('private URL details'));
  await workspace.retry();
  const status = host.handlers.get('dot:workspace:status')!(setupEvent());
  expect(status).toMatchObject({
    phase: 'error',
    message: expect.stringMatching(/interface.*Retry/i),
  });
  expect(JSON.stringify(status)).not.toContain('private URL');
  await workspace.retry();
  expect(main.webContents.getURL()).toContain('dots://workspace/');
  expect(backend.stop).not.toHaveBeenCalled();
});
it('retries owned degraded services without reloading a loaded draft', async () => {
  backend.start.mockResolvedValueOnce({
    url: 'http://127.0.0.1:5999',
    owned: true,
    warning: 'Open Docker and retry.',
  });
  await workspace.open();
  const main = host.windows[0];
  const count = main.loadURL.mock.calls.length;
  await workspace.retry();
  expect(backend.stop).toHaveBeenCalledOnce();
  expect(main.loadURL).toHaveBeenCalledTimes(count);
});

it('leaves externally managed services attached and untouched on an ordinary retry', async () => {
  backend.start.mockResolvedValue({
    url: 'http://127.0.0.1:5999',
    owned: false,
  });
  await workspace.open();
  const main = host.windows[0];
  const count = main.loadURL.mock.calls.length;
  await workspace.retry();
  expect(backend.stop).not.toHaveBeenCalled();
  expect(main.loadURL).toHaveBeenCalledTimes(count);
  expect(workspace.activeConnection?.owned).toBe(false);
});

it('honors the confirmed discard when the old editor prevents unload, only for the explicit transition', async () => {
  await workspace.open();
  await workspace.openBackendSettings();
  const main = host.windows[0];
  const normalLoad = main.loadURL.getMockImplementation() as (
    url: string,
  ) => Promise<void>;
  const unload = { preventDefault: vi.fn() };
  main.webContents.emit('will-prevent-unload', unload);
  expect(unload.preventDefault).not.toHaveBeenCalled();
  main.loadURL.mockImplementationOnce(async (url: string) => {
    main.webContents.emit('will-prevent-unload', unload);
    if (!unload.preventDefault.mock.calls.length)
      throw new Error('Dirty page blocked unloading');
    await normalLoad(url);
  });
  await expect(
    host.handlers.get('dot:workspace:configure')!(setupEvent(), {
      DATABASE_PATH: 'other.sqlite',
    }),
  ).resolves.toBeUndefined();
  expect(unload.preventDefault).toHaveBeenCalledOnce();
  unload.preventDefault.mockClear();
  main.webContents.emit('will-prevent-unload', unload);
  expect(unload.preventDefault).not.toHaveBeenCalled();
});

it('shares live appearance with open workspace surfaces without reloading drafts', async () => {
  appearanceColor = '#f5a0be';
  await workspace.open();
  const main = host.windows[0];
  expect(new URL(main.webContents.getURL()).searchParams.get('dotColor')).toBe(
    '#f5a0be',
  );
  main.webContents.mainFrame.url += '#/spaces/personal/pages/draft';
  const compact = new BrowserWindow({}) as unknown as WindowDouble;
  workspace.register(compact as unknown as BrowserWindow);
  await compact.loadURL(
    'dots://workspace/?surface=companion&dotColor=%23f5a0be',
  );
  const changed = vi.fn();
  main.webContents.on('dot:appearance', changed);
  const loads = main.loadURL.mock.calls.length;
  appearanceColor = '#55aa88';
  workspace.updateAppearance();
  await Promise.resolve();
  for (const window of [main, compact])
    expect(
      new URL(window.webContents.getURL()).searchParams.get('dotColor'),
    ).toBe('#55aa88');
  expect(new URL(main.webContents.getURL()).hash).toBe(
    '#/spaces/personal/pages/draft',
  );
  expect(main.loadURL).toHaveBeenCalledTimes(loads);
  expect(changed).toHaveBeenCalledOnce();
});

it('restores outfits on open and updates accessories without changing the selected page', async () => {
  appearanceAccessories = {
    headwear: 'crown',
    eyewear: 'none',
    neckwear: 'medal',
  };
  await workspace.open();
  const main = host.windows[0];
  expect(
    new URL(main.webContents.getURL()).searchParams.get('dotAccessories'),
  ).toBe('crown.none.medal');
  main.webContents.mainFrame.url += '#/pages/draft';
  const loads = main.loadURL.mock.calls.length;
  appearanceAccessories = {
    headwear: 'beanie',
    eyewear: 'round-glasses',
    neckwear: 'scarf',
  };
  workspace.updateAppearance();
  await Promise.resolve();
  expect(
    new URL(main.webContents.getURL()).searchParams.get('dotAccessories'),
  ).toBe('beanie.round-glasses.scarf');
  expect(new URL(main.webContents.getURL()).hash).toBe('#/pages/draft');
  expect(main.loadURL).toHaveBeenCalledTimes(loads);
  appearanceAccessories = { ...DEFAULT_ACCESSORIES };
  workspace.updateAppearance();
  await Promise.resolve();
  expect(
    new URL(main.webContents.getURL()).searchParams.has('dotAccessories'),
  ).toBe(false);
});

it('preserves new navigation and the latest color when appearance scripts are queued', async () => {
  await workspace.open();
  const main = host.windows[0];
  const execute =
    main.webContents.executeJavaScript.getMockImplementation() as (
      source: string,
    ) => Promise<void>;
  const pending: string[] = [];
  main.webContents.executeJavaScript.mockImplementation(
    async (source: string) => {
      pending.push(source);
    },
  );
  appearanceColor = '#f5a0be';
  workspace.updateAppearance();
  appearanceColor = '#45a7ff';
  workspace.updateAppearance();
  main.webContents.mainFrame.url += '#/threads/new-selection';
  await execute(pending.shift()!);
  expect(new URL(main.webContents.getURL()).searchParams.get('dotColor')).toBe(
    '#f5a0be',
  );
  for (const source of pending) await execute(source);
  const url = new URL(main.webContents.getURL());
  expect(url.hash).toBe('#/threads/new-selection');
  expect(url.searchParams.get('dotColor')).toBe('#45a7ff');
});

it('does not change a recovery page if navigation wins a queued appearance update', async () => {
  await workspace.open();
  const main = host.windows[0];
  const execute =
    main.webContents.executeJavaScript.getMockImplementation() as (
      source: string,
    ) => Promise<void>;
  let pending = '';
  main.webContents.executeJavaScript.mockImplementation(
    async (source: string) => {
      pending = source;
    },
  );
  appearanceColor = '#f5a0be';
  workspace.updateAppearance();
  main.webContents.mainFrame.url = 'dots://app/recovery.html';
  await execute(pending);
  expect(main.webContents.getURL()).toBe('dots://app/recovery.html');
});
