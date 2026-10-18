import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  windows: [] as WindowDouble[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipc: null as EventEmitter | null,
  showOpenDialog: vi.fn(),
}));
interface WindowDouble extends EventEmitter {
  visible: boolean;
  webContents: EventEmitter & {
    mainFrame: { url: string };
    send: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
  };
}
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  host.ipc = Object.assign(new EventEmitter(), {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      host.handlers.set(name, callback),
    removeHandler: (name: string) => host.handlers.delete(name),
  });
  return {
    ipcMain: host.ipc,
    dialog: { showOpenDialog: host.showOpenDialog },
    shell: { openExternal: vi.fn() },
    BrowserWindow: class extends EventEmitter {
      visible = true;
      destroyed = false;
      webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: '' },
        session: {
          setPermissionCheckHandler() {},
          setPermissionRequestHandler() {},
        },
        send: vi.fn(),
        reload: vi.fn(),
        getURL: () => this.webContents.mainFrame.url,
        setWindowOpenHandler() {},
      });
      constructor() {
        super();
        host.windows.push(this);
      }
      async loadURL(url: string) {
        this.webContents.emit('did-start-navigation', {}, url, false, true);
        this.webContents.mainFrame.url = url;
        this.webContents.emit('did-navigate');
      }
      isDestroyed() {
        return this.destroyed;
      }
      isVisible() {
        return this.visible;
      }
      isFocused() {
        return true;
      }
      isMinimized() {
        return false;
      }
      setBounds() {}
      setAlwaysOnTop() {}
      setVisibleOnAllWorkspaces() {}
      show() {
        this.visible = true;
      }
      focus() {}
      hide() {
        this.visible = false;
        this.emit('hide');
      }
      destroy() {
        this.destroyed = true;
      }
    },
  };
});
import { CompanionChatWindow } from '../../src/desktop/host/chat-window.js';

let chat: CompanionChatWindow;
const bounds = { x: 0, y: 0, width: 440, height: 620 };
function invoke(name: string, payload: unknown) {
  const window = host.windows[0];
  return host.handlers.get(`dot:voice:${name}`)!(
    {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    },
    payload,
  );
}
beforeEach(async () => {
  vi.useFakeTimers();
  host.windows = [];
  host.showOpenDialog.mockReset();
  vi.stubGlobal('fetch', async (url: URL | string) => ({
    ok: true,
    headers: new Headers({
      'content-type': String(url).endsWith('api/workspace')
        ? 'application/json'
        : 'text/html',
    }),
    text: async () => '<div id="root"></div>',
  }));
  chat = new CompanionChatWindow('/bundle', '/unused');
  await chat.open(bounds);
  invoke('ready', true);
});
afterEach(() => {
  chat.destroy();
  host.handlers.clear();
  host.ipc?.removeAllListeners();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['hide', 'minimize', 'close', 'unresponsive'])(
  'ends voice on %s while retaining the conversation window',
  async (event) => {
    invoke('begin', 'call-12345678');
    const window = host.windows[0];
    if (event === 'hide') chat.hide();
    else if (event === 'unresponsive') window.webContents.emit(event);
    else window.emit(event, { preventDefault() {} });
    expect(window.webContents.send).toHaveBeenCalledWith(
      'dot:voice:stop',
      expect.any(String),
    );
    invoke('end', 'call-12345678');
    await vi.advanceTimersByTimeAsync(1100);
    expect(window.webContents.reload).not.toHaveBeenCalled();
    await chat.open(bounds);
    expect(host.windows).toHaveLength(1);
  },
);

it('revokes on navigation, resets readiness after commit, and avoids reloading the destination', async () => {
  invoke('begin', 'call-12345678');
  const window = host.windows[0];
  window.webContents.emit(
    'did-start-navigation',
    {},
    'dots://app/chat.html',
    false,
    true,
  );
  expect(window.webContents.send).toHaveBeenCalledWith(
    'dot:voice:stop',
    'navigation',
  );
  window.webContents.mainFrame.url = 'dots://app/chat.html';
  window.webContents.emit('did-navigate');
  expect(chat.voiceReady).toBe(false);
  await vi.advanceTimersByTimeAsync(1100);
  expect(window.webContents.reload).not.toHaveBeenCalled();
});

it('opens Talk without granting microphone access or reloading the selected conversation', async () => {
  const window = host.windows[0];
  await chat.talk(bounds);
  expect(window.webContents.send).toHaveBeenCalledWith('dot:voice:talk');
  expect(window.webContents.reload).not.toHaveBeenCalled();
  expect(host.windows).toHaveLength(1);
  invoke('ready', false);
  window.webContents.send.mockClear();
  await chat.talk(bounds);
  expect(window.webContents.send).toHaveBeenCalledWith('dot:voice:talk');
});

it('attaches folder selection to chat lifecycle and removes its IPC on destroy', async () => {
  let resolve!: (value: { canceled: boolean; filePaths: string[] }) => void;
  host.showOpenDialog.mockImplementationOnce(
    () => new Promise((done) => (resolve = done)),
  );
  const window = host.windows[0];
  const choose = host.handlers.get('dot:folders:choose');
  expect(choose).toBeDefined();
  const pending = choose!({
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  });
  expect(host.showOpenDialog).toHaveBeenCalledOnce();
  chat.hide();
  await chat.open(bounds);
  resolve({ canceled: false, filePaths: ['/chosen/folder'] });
  await expect(pending).resolves.toBeNull();
  chat.destroy();
  expect(host.handlers.has('dot:folders:choose')).toBe(false);
  expect(host.ipc!.listenerCount('dot:folders:context')).toBe(0);
});
