import type { EventEmitter } from 'node:events';
import type { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../../src/desktop/host/preferences.js';
import { snapshot } from './fixtures.js';
import type { PresentationFrame } from '../../src/desktop/shared/contracts.js';

const host = vi.hoisted(() => ({
  connection: undefined as { url: string; owned: boolean } | undefined,
  customize: undefined as ((id?: string) => Promise<void>) | undefined,
  select: undefined as ((id: string) => Promise<void>) | undefined,
  fetcher: undefined as typeof fetch | undefined,
  windows: [] as Array<{
    visible: boolean;
    webContents: EventEmitter & { id: number; mainFrame: { url: string } };
  }>,
  children: [] as EventEmitter[],
  ipc: null as EventEmitter | null,
  power: null as EventEmitter | null,
  cursor: { x: 1200, y: 100 },
  frame: null as PresentationFrame | null,
  accessibilityTrusted: false,
  menu: [] as Array<{ label?: string; click?: () => void }>,
  loads: 0,
  autoAck: true,
  lifecycle: [] as string[],
  shutdown: null as Promise<void> | null,
  diagnosticEvents: [] as Array<{
    event: string;
    details: Record<string, unknown>;
  }>,
}));
vi.mock('../../src/desktop/host/diagnostics.js', () => ({
  DesktopDiagnostics: class {
    captureException() {}
    async record(event: string, details: Record<string, unknown>) {
      host.diagnosticEvents.push({ event, details });
    }
  },
}));
vi.mock('../../src/desktop/host/workspace-backend.js', () => ({
  WorkspaceBackend: class {
    async stop() {
      host.lifecycle.push('backend-stop');
    }
  },
}));
vi.mock('../../src/desktop/host/workspace-window.js', () => ({
  WorkspaceWindow: class {
    constructor(
      _bundle: string,
      _data: string,
      _backend: unknown,
      customize: typeof host.customize,
      _review: unknown,
      _color: unknown,
      _accessories: unknown,
      select: typeof host.select,
    ) {
      host.customize = customize;
      host.select = select;
    }
    get activeConnection() {
      return host.connection;
    }
    customizationChanged() {}
    async open() {
      host.lifecycle.push('workspace-open');
    }
    async command() {}
    suspend() {}
    async destroy() {
      host.lifecycle.push('workspace-terminal');
      await host.shutdown;
    }
    async ready() {}
    async recover() {}
    register() {}
    updateAppearance() {}
  },
}));
const exceptionMonitors = new Set(
  process.listeners('uncaughtExceptionMonitor'),
);
const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
)!;
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const { display } = await import('./fixtures.js');
  const ipc = new EventEmitter();
  host.ipc = ipc;
  host.power = new EventEmitter();
  class Window extends EventEmitter {
    visible = false;
    destroyed = false;
    bounds = { x: 0, y: 0, width: 320, height: 320 };
    webContents = Object.assign(new EventEmitter(), {
      id: host.windows.length + 1,
      mainFrame: { url: 'dots://app/index.html' },
      setWindowOpenHandler: vi.fn(),
      send: (channel: string, frame: PresentationFrame) => {
        if (channel === 'dot:frame') {
          host.frame = frame;
          if (host.autoAck) ipc.emit('dot:ack', this.event(), frame.sequence);
        }
      },
    });
    constructor() {
      super();
      host.windows.push(this);
    }
    event() {
      return {
        sender: this.webContents,
        senderFrame: this.webContents.mainFrame,
      };
    }
    showInactive() {
      this.visible = true;
    }
    show() {
      this.visible = true;
    }
    focus() {}
    hide() {
      this.visible = false;
    }
    getBounds() {
      return this.bounds;
    }
    setPosition(x: number, y: number) {
      this.bounds = { ...this.bounds, x, y };
    }
    setBounds(bounds: typeof this.bounds) {
      this.bounds = bounds;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
    isVisible() {
      return this.visible;
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    async loadURL(url: string) {
      this.webContents.mainFrame.url = url;
      host.loads++;
    }
  }
  return {
    app: Object.assign(new EventEmitter(), {
      isPackaged: true,
      setName: vi.fn(),
      setPath: vi.fn(),
      getPath: () => '/unused',
      isHidden: () => false,
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      dock: { show: vi.fn(), hide: vi.fn() },
      quit: vi.fn(),
      exit: vi.fn(),
    }),
    BrowserWindow: Window,
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
    Notification: { isSupported: () => false },
    ipcMain: Object.assign(ipc, { handle: vi.fn(), removeHandler: vi.fn() }),
    Menu: {
      buildFromTemplate: (items: unknown) => items,
      setApplicationMenu: vi.fn(),
    },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    net: {},
    powerMonitor: host.power,
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    screen: Object.assign(new EventEmitter(), {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getCursorScreenPoint: () => host.cursor,
    }),
    shell: {},
    systemPreferences: {
      getAnimationSettings: () => ({ prefersReducedMotion: false }),
      isTrustedAccessibilityClient: () => host.accessibilityTrusted,
    },
    Tray: class {
      destroy() {}
      setToolTip() {}
      setContextMenu(items: Array<{ label?: string }>) {
        host.menu = items;
      }
    },
  };
});
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stdin: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      host.children.push(child);
      return child;
    },
  };
});
vi.mock('../../src/desktop/host/preferences.js', async (original) => ({
  ...(await original<typeof import('../../src/desktop/host/preferences.js')>()),
  PreferenceStore: class {
    async load() {
      return { ...DEFAULT_PREFERENCES };
    }
    async save() {}
  },
}));

beforeEach(async () => {
  // This suite models a macOS Electron host, including on Linux CI runners.
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  vi.resetModules();
  host.connection = undefined;
  host.fetcher = undefined;
  vi.stubGlobal('fetch', (...args: Parameters<typeof fetch>) => {
    if (!host.fetcher) throw new Error('Unexpected fetch');
    return host.fetcher(...args);
  });
  host.windows = [];
  host.lifecycle = [];
  host.shutdown = null;
  host.children = [];
  host.cursor = { x: 1200, y: 100 };
  host.frame = null;
  host.accessibilityTrusted = false;
  host.menu = [];
  host.diagnosticEvents = [];
  host.loads = 0;
  host.autoAck = true;
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'performance',
    ],
  });
  vi.stubGlobal('__dirname', '/test/desktop');
  await import('../../src/desktop/main.js');
  await vi.advanceTimersByTimeAsync(0);
  const window = host.windows[0];
  expect(window).toBeDefined();
  host.ipc!.emit('dot:ready', {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  });
  expect(window.visible).toBe(true);
  await vi.advanceTimersByTimeAsync(450);
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  for (const listener of process.listeners('uncaughtExceptionMonitor'))
    if (!exceptionMonitors.has(listener))
      process.removeListener('uncaughtExceptionMonitor', listener);
  const { app, ipcMain, powerMonitor, screen } = await import('electron');
  for (const emitter of [app, ipcMain, powerMonitor, screen])
    emitter.removeAllListeners();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function invalidScene() {
  const child = host.children.at(-1) as EventEmitter & { stdout: PassThrough };
  child.stdout.emit(
    'data',
    Buffer.from(
      JSON.stringify(
        snapshot([], { sceneValid: false, observedAtMs: performance.now() }),
      ) + '\n',
    ),
  );
  expect(host.windows[0].visible).toBe(false);
}
describe('companion click menu', () => {
  it('hides chat on lock even if a geometry transition already hid the overlay', async () => {
    const { CompanionChatWindow } =
      await import('../../src/desktop/host/chat-window.js');
    const hide = vi.spyOn(CompanionChatWindow.prototype, 'hide');
    try {
      invalidScene();
      expect(hide).not.toHaveBeenCalled();
      host.power!.emit('lock-screen');
      expect(hide).toHaveBeenCalledOnce();
    } finally {
      hide.mockRestore();
    }
  });
  function pointer(kind: 'down' | 'move' | 'up') {
    const window = host.windows[0];
    host.ipc!.emit(
      'dot:pointer',
      {
        sender: window.webContents,
        senderFrame: window.webContents.mainFrame,
      },
      { kind, point: host.cursor, atMs: performance.now() },
    );
  }
  it('opens the cloud menu on a body click and can restore the hidden Dot', async () => {
    await vi.advanceTimersByTimeAsync(350);
    host.cursor = {
      x: host.frame!.simulation.root.x,
      y: host.frame!.simulation.root.y - 55,
    };
    pointer('down');
    expect(host.windows).toHaveLength(1);
    pointer('up');
    await vi.advanceTimersByTimeAsync(0);
    const menu = host.windows[1];
    expect(menu.webContents.mainFrame.url).toContain('dots://app/menu.html?');
    expect(menu.visible).toBe(true);
    host.ipc!.emit(
      'dot:menu:action',
      { sender: menu.webContents, senderFrame: menu.webContents.mainFrame },
      'hide',
    );
    expect(host.windows[0].visible).toBe(true);
    await vi.advanceTimersByTimeAsync(440);
    expect(host.windows[0].visible).toBe(false);
    host.menu.find((item) => item.label === 'Show Dot')!.click!();
    expect(host.windows[0].visible).toBe(true);
  });
  it('keeps the root in place through hide/show and cancels a pending hide on a quick toggle', async () => {
    await vi.advanceTimersByTimeAsync(400);
    const position = host.frame!.simulation.root;
    host.menu.find((item) => item.label === 'Hide Dot')!.click!();
    expect(host.windows[0].visible).toBe(true);
    expect(host.frame!.visible).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.frame!.simulation.root).toEqual(position);
    const fading = host.frame!.appearance!.scaleX;
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(1);
    host.menu.find((item) => item.label === 'Show Dot')!.click!();
    await vi.advanceTimersByTimeAsync(180);
    expect(host.windows[0].visible).toBe(true);
    expect(host.frame!.simulation.root).toEqual(position);
    expect(host.frame!.appearance!.scaleX).toBeGreaterThan(fading);
    await vi.advanceTimersByTimeAsync(150);
    expect(host.windows[0].visible).toBe(true);
    expect(host.frame!.appearance!.alpha).toBe(1);
  });
  it('hides immediately on lock even during a user-requested fade', async () => {
    await vi.advanceTimersByTimeAsync(400);
    host.menu.find((item) => item.label === 'Hide Dot')!.click!();
    expect(host.windows[0].visible).toBe(true);
    host.power!.emit('lock-screen');
    expect(host.windows[0].visible).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(host.windows[0].visible).toBe(false);
  });
  it('ignores a drag during arrival while the sprite is smaller than its normal hit region', async () => {
    host.menu.find((item) => item.label === 'Hide Dot')!.click!();
    await vi.advanceTimersByTimeAsync(250);
    const position = host.frame!.simulation.root;
    host.menu.find((item) => item.label === 'Show Dot')!.click!();
    host.cursor = { x: position.x, y: position.y - 55 };
    pointer('down');
    host.cursor.x += 50;
    pointer('move');
    await vi.advanceTimersByTimeAsync(100);
    expect(host.frame!.simulation.grip).toBeNull();
    expect(host.frame!.simulation.root).toEqual(position);
  });
  it('resumes falling without catching up hidden animation time after a reduced-motion fade', async () => {
    host.cursor = {
      x: host.frame!.simulation.root.x,
      y: host.frame!.simulation.root.y - 55,
    };
    pointer('down');
    host.cursor.y -= 200;
    pointer('move');
    host.menu.find((item) => item.label === 'Reduce motion')!.click!();
    host.menu.find((item) => item.label === 'Hide Dot')!.click!();
    await vi.advanceTimersByTimeAsync(200);
    const root = host.frame!.simulation.root;
    host.menu.find((item) => item.label === 'Show Dot')!.click!();
    await vi.advanceTimersByTimeAsync(160);
    expect(host.frame!.simulation.root.y - root.y).toBeLessThan(1);
  });
  it('waits for the transparent frame to be drawn before hiding the native window', async () => {
    await vi.advanceTimersByTimeAsync(400);
    host.autoAck = false;
    host.menu.find((item) => item.label === 'Hide Dot')!.click!();
    const first = host.frame!.sequence;
    await vi.advanceTimersByTimeAsync(440);
    expect(host.windows[0].visible).toBe(true);
    const window = host.windows[0];
    const event = {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    };
    host.ipc!.emit('dot:ack', event, first);
    expect(host.frame!.appearance!.alpha).toBe(0);
    expect(window.visible).toBe(true);
    host.ipc!.emit('dot:ack', event, host.frame!.sequence);
    expect(window.visible).toBe(false);
  });
  it('preserves pickup without opening a menu on release', () => {
    host.cursor = {
      x: host.frame!.simulation.root.x,
      y: host.frame!.simulation.root.y - 55,
    };
    pointer('down');
    host.cursor.x += 20;
    pointer('move');
    pointer('up');
    expect(host.windows).toHaveLength(1);
  });
  it('dismisses on another body press and does not reopen on release', async () => {
    host.cursor = {
      x: host.frame!.simulation.root.x,
      y: host.frame!.simulation.root.y - 55,
    };
    pointer('down');
    pointer('up');
    await vi.advanceTimersByTimeAsync(0);
    const menu = host.windows[1];
    expect(menu.visible).toBe(true);
    pointer('down');
    expect(menu.visible).toBe(false);
    pointer('up');
    await vi.advanceTimersByTimeAsync(0);
    expect(menu.visible).toBe(false);
    pointer('down');
    pointer('up');
    await vi.advanceTimersByTimeAsync(0);
    expect(menu.visible).toBe(true);
    pointer('down');
    host.cursor.x += 20;
    pointer('move');
    pointer('up');
    await vi.advanceTimersByTimeAsync(0);
    expect(menu.visible).toBe(false);
  });
});
describe('host scene recovery', () => {
  function ready() {
    const window = host.windows[0];
    host.ipc!.emit('dot:ready', {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    });
  }
  it('recovers separate renderer failures after sustained acknowledged frames', async () => {
    for (let i = 0; i < 4; i++) {
      host.windows[0].webContents.emit('unresponsive');
      await vi.advanceTimersByTimeAsync(350);
      expect(host.loads).toBe(i + 2);
      ready();
      await vi.advanceTimersByTimeAsync(5500);
      expect(host.windows[0].visible).toBe(true);
    }
  });
  it('bounds consecutive failures and allows an explicit new recovery attempt', async () => {
    for (let i = 0; i < 3; i++) {
      host.windows[0].webContents.emit('unresponsive');
      await vi.advanceTimersByTimeAsync(350);
      if (i < 2) ready();
    }
    expect(host.loads).toBe(3);
    expect(host.windows[0].visible).toBe(false);
    expect(
      host.menu.some((item) => item.label?.includes('Renderer unavailable')),
    ).toBe(true);
    host.menu.find((item) => item.label === 'Recover companion')!.click!();
    await vi.advanceTimersByTimeAsync(350);
    expect(host.loads).toBe(4);
    ready();
    expect(host.windows[0].visible).toBe(true);
  });
  it('counts duplicate failure notifications during a pending reload only once', async () => {
    const contents = host.windows[0].webContents;
    contents.emit('unresponsive');
    contents.emit('render-process-gone', {}, { reason: 'crashed' });
    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(350);
    expect(host.loads).toBe(2);
    ready();
    expect(host.windows[0].visible).toBe(true);
    expect(
      host.menu.some((item) => item.label?.includes('Renderer unavailable')),
    ).toBe(false);
    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(350);
    expect(host.loads).toBe(3);
  });
  it('records renderer failure and the resulting hidden state for diagnosis', () => {
    const window = host.windows[0];
    host.ipc!.emit(
      'dot:error',
      {
        sender: window.webContents,
        senderFrame: window.webContents.mainFrame,
      },
      'Unable to load character',
    );
    expect(window.visible).toBe(false);
    expect(host.diagnosticEvents).toContainEqual({
      event: 'renderer-error',
      details: { message: 'Unable to load character' },
    });
    expect(
      host.diagnosticEvents.findLast((entry) => entry.event === 'visibility')
        ?.details,
    ).toMatchObject({
      visible: false,
      rendererReady: false,
      assetError: 'Unable to load character',
    });
  });
  it('explains how to renew an updated app grant while Accessibility is denied', () => {
    expect(
      host.menu.some((item) => item.label?.includes('remove and re-add')),
    ).toBe(true);
  });
  it('omits stale-grant guidance after the host is trusted', () => {
    host.accessibilityTrusted = true;
    const child = host.children[0] as EventEmitter & { stdout: PassThrough };
    child.stdout.emit('data', Buffer.from(JSON.stringify(snapshot()) + '\n'));
    expect(
      host.menu.some((item) => item.label?.includes('remove and re-add')),
    ).toBe(false);
  });

  it('keeps the compact overlay inside its monitor at the left and bottom edges', async () => {
    await vi.advanceTimersByTimeAsync(34);
    const origin = host.frame!.origin;
    expect(host.frame!.simulation.root.y).toBe(900);
    expect(host.frame!.simulation.support?.id).toBe('floor:1');
    expect(origin.x).toBeGreaterThanOrEqual(0);
    expect(origin.y).toBeGreaterThanOrEqual(0);
    expect(origin.x + 320).toBeLessThanOrEqual(1440);
    expect(origin.y + 320).toBeLessThanOrEqual(900);
  });
  it('releases a held Dot when helper geometry expires during capture', async () => {
    const child = host.children[0] as EventEmitter & { stdout: PassThrough };
    child.stdout.emit('data', Buffer.from(JSON.stringify(snapshot()) + '\n'));
    const window = host.windows[0];
    const event = {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    };
    host.cursor = {
      x: host.frame!.simulation.root.x,
      y: host.frame!.simulation.root.y - 70,
    };
    host.ipc!.emit('dot:pointer', event, {
      kind: 'down',
      point: host.cursor,
      atMs: 0,
    });
    host.cursor = { ...host.cursor, y: host.cursor.y - 100 };
    await vi.advanceTimersByTimeAsync(34);
    expect(host.frame!.simulation.grip).not.toBeNull();
    await vi.advanceTimersByTimeAsync(520);
    expect(host.frame!.simulation.grip).toBeNull();
    expect(window.visible).toBe(true);
  });
  it('returns to visible floor mode after invalidation then helper failure, including exhausted retries', async () => {
    invalidScene();
    host.children[0].emit('exit', 1);
    expect(host.windows[0].visible).toBe(true);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10000);
      host.children.at(-1)!.emit('exit', 1);
    }
    await vi.advanceTimersByTimeAsync(10000);
    expect(host.children).toHaveLength(6);
    expect(host.windows[0].visible).toBe(true);
  });
  it('returns to floor mode when an invalid scene expires without a helper exit', async () => {
    invalidScene();
    await vi.advanceTimersByTimeAsync(520);
    expect(host.windows[0].visible).toBe(true);
  });
  it('keeps lock-screen hiding independent from native tracking recovery', async () => {
    invalidScene();
    host.power!.emit('lock-screen');
    host.children[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(520);
    expect(host.windows[0].visible).toBe(false);
    host.power!.emit('unlock-screen');
    expect(host.windows[0].visible).toBe(true);
  });
});

it('makes the workspace terminal before stopping the backend and ignores activation during delayed quit', async () => {
  const { app } = await import('electron');
  let finish!: () => void;
  host.shutdown = new Promise<void>((resolve) => {
    finish = resolve;
  });
  host.lifecycle = [];
  const preventDefault = vi.fn();
  app.emit('before-quit', { preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(host.lifecycle).toEqual(['workspace-terminal', 'backend-stop']);
  app.emit('activate');
  app.emit('second-instance');
  const windows = host.windows.length;
  for (const label of ['Chat with Dot', 'Talk with Dot', 'Customize Dot'])
    host.menu.find((item) => item.label === label)?.click?.();
  expect(host.windows).toHaveLength(windows);
  expect(host.lifecycle).toEqual(['workspace-terminal', 'backend-stop']);
  expect(app.exit).not.toHaveBeenCalled();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it('scopes settings windows and tray customization to one desktop Dot', async () => {
  const { WorkspaceStore } = await import('../../src/server/workspace.js');
  const { Hono } = await import('hono');
  const { ipcMain } = await import('electron');
  const ws = new WorkspaceStore(':memory:', 'owner');
  const a = ws.dots()[0];
  const b = ws.createDot(a.spaceId, 'Scout', 'Research carefully', true, true);
  const app = new Hono();
  app.get('/api/desktop-dot', (c) => c.json(ws.desktopDot()));
  app.post('/api/desktop-dot/initialize', async (c) =>
    c.json(ws.initializeDotCustomization(await c.req.json())),
  );
  let finishSelection!: () => void;
  const selectionGate = new Promise<void>((resolve) => {
    finishSelection = resolve;
  });
  app.put('/api/desktop-dot', async (c) => {
    await selectionGate;
    return c.json(ws.selectDesktopDot((await c.req.json()).dotId));
  });
  app.patch('/api/dots/:id/customization', async (c) =>
    c.json(ws.setDotCustomization(c.req.param('id'), await c.req.json())),
  );
  host.connection = { url: 'http://localhost:4310', owned: false };
  host.fetcher = ((url: URL, options: RequestInit) =>
    app.request(url.href, options)) as typeof fetch;
  const handler = (name: string) =>
    vi
      .mocked(ipcMain.handle)
      .mock.calls.findLast(([channel]) => channel === name)![1];
  const event = () => {
    const window = host.windows.at(-1)!;
    return {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    } as Electron.IpcMainInvokeEvent;
  };
  try {
    await host.customize!(b.id);
    const oldEvent = event();
    expect(await handler('dot:preferences:read')(oldEvent)).toMatchObject({
      dotId: b.id,
      dotName: 'Scout',
    });
    await handler('dot:preferences:update')(oldEvent, {
      color: '#aa33ff',
      muted: true,
      paused: true,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(host.frame?.preferences).toMatchObject({
      color: '#45a7ff',
      muted: false,
      paused: false,
    });
    await host.customize!();
    expect(await handler('dot:preferences:read')(event())).toMatchObject({
      dotId: a.id,
    });
    await expect(
      handler('dot:preferences:update')(oldEvent, { color: '#ffffff' }),
    ).rejects.toThrow('Invalid settings sender');
    const selecting = host.select!(b.id);
    await vi.advanceTimersByTimeAsync(0);
    const count = host.windows.length;
    host.menu.find((item) => item.label === 'Talk with Dot')!.click!();
    host.menu.find((item) => item.label === 'Talk without a window')!.click!();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.windows).toHaveLength(count);
    await expect(host.select!(a.id)).rejects.toThrow(/already switching/);
    finishSelection();
    await selecting;
    await vi.advanceTimersByTimeAsync(50);
    expect(ws.desktopDot().dotId).toBe(b.id);
    expect(host.frame?.preferences).toMatchObject({
      color: '#aa33ff',
      muted: true,
      paused: true,
    });
    await host.customize!();
    expect(await handler('dot:preferences:read')(event())).toMatchObject({
      dotId: b.id,
    });
    expect(
      host.windows.filter(
        (window) =>
          window.webContents.mainFrame.url === 'dots://app/index.html',
      ),
    ).toHaveLength(1);
  } finally {
    host.connection = undefined;
    ws.close();
  }
});
