import type { EventEmitter } from 'node:events';
import type { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../../src/desktop/host/preferences.js';
import { snapshot } from './fixtures.js';
import type { PresentationFrame } from '../../src/desktop/shared/contracts.js';

const host = vi.hoisted(() => ({
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
    bounds = { x: 0, y: 0, width: 320, height: 320 };
    webContents = Object.assign(new EventEmitter(), {
      id: 1,
      mainFrame: { url: 'dots://app/index.html' },
      setWindowOpenHandler: vi.fn(),
      send: (channel: string, frame: PresentationFrame) => {
        if (channel === 'dot:frame') {
          host.frame = frame;
          ipc.emit('dot:ack', this.event(), frame.sequence);
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
    hide() {
      this.visible = false;
    }
    getBounds() {
      return this.bounds;
    }
    setPosition(x: number, y: number) {
      this.bounds = { ...this.bounds, x, y };
    }
    isDestroyed() {
      return false;
    }
    isVisible() {
      return this.visible;
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    async loadURL() {
      host.loads++;
    }
  }
  return {
    app: Object.assign(new EventEmitter(), {
      setName: vi.fn(),
      setPath: vi.fn(),
      getPath: () => '/unused',
      isHidden: () => false,
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      dock: { hide: vi.fn() },
      quit: vi.fn(),
    }),
    BrowserWindow: Window,
    ipcMain: Object.assign(ipc, { handle: vi.fn() }),
    Menu: { buildFromTemplate: (items: unknown) => items },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    net: {},
    powerMonitor: host.power,
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    screen: Object.assign(new EventEmitter(), {
      getAllDisplays: () => [display],
      getCursorScreenPoint: () => host.cursor,
    }),
    shell: {},
    systemPreferences: {
      getAnimationSettings: () => ({ prefersReducedMotion: false }),
      isTrustedAccessibilityClient: () => host.accessibilityTrusted,
    },
    Tray: class {
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
  host.windows = [];
  host.children = [];
  host.cursor = { x: 1200, y: 100 };
  host.frame = null;
  host.accessibilityTrusted = false;
  host.menu = [];
  host.diagnosticEvents = [];
  host.loads = 0;
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
