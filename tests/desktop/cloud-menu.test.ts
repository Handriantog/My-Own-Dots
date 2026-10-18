import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { companionMenuLayout } from '../../src/desktop/host/interaction.js';

const host = vi.hoisted(() => ({
  windows: [] as Array<{
    visible: boolean;
    ignored: boolean;
    webContents: EventEmitter & { mainFrame: { url: string } };
    emit: (name: string) => boolean;
  }>,
  ipc: null as EventEmitter | null,
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  host.ipc = new EventEmitter();
  return {
    ipcMain: host.ipc,
    BrowserWindow: class extends EventEmitter {
      visible = false;
      ignored = false;
      webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: '' },
        setWindowOpenHandler() {},
      });
      constructor() {
        super();
        host.windows.push(this);
      }
      async loadURL(url: string) {
        this.webContents.mainFrame.url = url;
      }
      setBounds() {}
      setIgnoreMouseEvents(value: boolean) {
        this.ignored = value;
      }
      setAlwaysOnTop() {}
      setVisibleOnAllWorkspaces() {}
      show() {
        this.visible = true;
      }
      focus() {}
      hide() {
        this.visible = false;
      }
      isDestroyed() {
        return false;
      }
      destroy() {
        this.emit('closed');
      }
    },
  };
});

beforeEach(() => {
  host.windows = [];
  host.ipc?.removeAllListeners();
});

const layout = companionMenuLayout(
  { x: 500, y: 500 },
  { x: 0, y: 0, width: 1000, height: 800 },
);
const sender = (window: (typeof host.windows)[number]) => ({
  sender: window.webContents,
  senderFrame: window.webContents.mainFrame,
});

it('shows a reusable cloud menu and dismisses it when focus moves away', async () => {
  const { CompanionCloudMenu } =
    await import('../../src/desktop/host/cloud-menu.js');
  const states: boolean[] = [];
  const menu = new CompanionCloudMenu('/bundle', {
    change: (open) => states.push(open),
    action() {},
  });
  await menu.open(layout, false);
  expect(host.windows[0].visible).toBe(true);
  host.windows[0].emit('blur');
  expect(host.windows[0].visible).toBe(false);
  expect(states).toEqual([true, false]);
  await menu.open(layout, true);
  expect(host.windows).toHaveLength(1);
  expect(host.windows[0].webContents.mainFrame.url).toContain('still=1');
  menu.destroy();
});

it('accepts Chat and Hide only from the menu main frame, and dismisses before acting', async () => {
  const { CompanionCloudMenu } =
    await import('../../src/desktop/host/cloud-menu.js');
  const actions: string[] = [];
  const menu = new CompanionCloudMenu('/bundle', {
    change() {},
    action: (action) => {
      expect(host.windows[0].visible).toBe(false);
      actions.push(action);
    },
  });
  await menu.open(layout, false);
  const window = host.windows[0];
  host.ipc!.emit(
    'dot:menu:action',
    {
      ...sender(window),
      senderFrame: { url: window.webContents.mainFrame.url },
    },
    'chat',
  );
  expect(actions).toEqual([]);
  host.ipc!.emit('dot:menu:action', sender(window), 'chat');
  expect(actions).toEqual(['chat']);
  host.ipc!.emit('dot:menu:action', sender(window), 'hide');
  expect(actions).toEqual(['chat']);
  await menu.open(layout, false);
  host.ipc!.emit('dot:menu:action', sender(window), 'hide');
  expect(actions).toEqual(['chat', 'hide']);
  menu.destroy();
});

it('does not reappear when dismissed while its page is loading', async () => {
  const { CompanionCloudMenu } =
    await import('../../src/desktop/host/cloud-menu.js');
  const menu = new CompanionCloudMenu('/bundle', { change() {}, action() {} });
  const pending = menu.open(layout, false);
  menu.close();
  await pending;
  expect(host.windows[0].visible).toBe(false);
  menu.destroy();
});

it('dispatches native Talk before the workspace has been opened to check readiness', async () => {
  const { CompanionCloudMenu } =
    await import('../../src/desktop/host/cloud-menu.js');
  const actions: string[] = [];
  const menu = new CompanionCloudMenu('/bundle', {
    change() {},
    action: (action) => actions.push(action),
  });
  await menu.open(layout, false, true);
  const window = host.windows[0];
  expect(window.webContents.mainFrame.url).toContain('voice=1');
  host.ipc!.emit('dot:menu:action', sender(window), 'talk');
  expect(actions).toEqual(['talk']);
  await menu.open(layout, false, false);
  host.ipc!.emit('dot:menu:action', sender(window), 'talk');
  expect(actions).toEqual(['talk', 'talk']);
  expect(window.visible).toBe(false);
  menu.destroy();
});

it('passes pointer input through the center and accepts it on each cloud', async () => {
  const { CompanionCloudMenu } =
    await import('../../src/desktop/host/cloud-menu.js');
  const menu = new CompanionCloudMenu('/bundle', { change() {}, action() {} });
  await menu.open(layout, false);
  menu.pointer({ x: layout.root.x, y: layout.root.y - 55 });
  expect(host.windows[0].ignored).toBe(true);
  for (const rect of Object.values(layout.items)) {
    menu.pointer({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    expect(host.windows[0].ignored).toBe(false);
    menu.pointer({ x: 0, y: 0 });
    expect(host.windows[0].ignored).toBe(true);
  }
  menu.destroy();
});
