import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

const host = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipc: null as EventEmitter | null,
  showOpenDialog: vi.fn(),
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  host.ipc = Object.assign(new EventEmitter(), {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      host.handlers.set(name, callback),
    removeHandler: (name: string) => host.handlers.delete(name),
  });
  return { ipcMain: host.ipc, dialog: { showOpenDialog: host.showOpenDialog } };
});

import { CompanionFolderPicker } from '../../src/desktop/host/folder-picker.js';

const workspaceUrl = 'http://127.0.0.1:4310/?desktop=1';
function windowDouble() {
  const window = Object.assign(new EventEmitter(), {
    visible: true,
    focused: true,
    minimized: false,
    destroyed: false,
    webContents: Object.assign(new EventEmitter(), {
      mainFrame: { url: workspaceUrl },
    }),
    isVisible: () => window.visible,
    isFocused: () => window.focused,
    isMinimized: () => window.minimized,
    isDestroyed: () => window.destroyed,
  });
  return window;
}

let window: ReturnType<typeof windowDouble>;
let picker: CompanionFolderPicker;
let address: string;
function sender() {
  return {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  } as unknown as IpcMainInvokeEvent;
}
function choose(event = sender(), ...args: unknown[]) {
  const handler = host.handlers.get('dot:folders:choose');
  if (!handler) throw new Error('Missing folder chooser');
  return Promise.resolve(handler(event, ...args));
}
function context(event = sender()) {
  const request = { ...event, returnValue: undefined as unknown };
  host.ipc!.emit('dot:folders:context', request);
  return request.returnValue;
}
function pendingSelection() {
  let resolve!: (value: { canceled: boolean; filePaths: string[] }) => void;
  host.showOpenDialog.mockImplementationOnce(
    () => new Promise((done) => (resolve = done)),
  );
  const pending = choose();
  return {
    pending,
    finish: () => resolve({ canceled: false, filePaths: ['/chosen/project'] }),
  };
}
beforeEach(() => {
  window = windowDouble();
  address = 'http://127.0.0.1:4310/';
  host.showOpenDialog.mockReset();
  host.showOpenDialog.mockResolvedValue({
    canceled: false,
    filePaths: ['/chosen/project'],
  });
  picker = new CompanionFolderPicker(
    () => window as unknown as BrowserWindow,
    () => address,
  );
  picker.attach(window as unknown as BrowserWindow);
});
afterEach(() => {
  picker.destroy();
  host.ipc?.removeAllListeners();
  host.handlers.clear();
});

describe('native folder selection boundary', () => {
  it('allows the approval surface only for its separately scoped picker', async () => {
    address = 'dots://workspace/';
    window.webContents.mainFrame.url = 'dots://workspace/?surface=approval';
    expect(context()).toBe(false);
    await expect(choose()).rejects.toThrow();
    picker.destroy();
    picker = new CompanionFolderPicker(
      () => window as unknown as BrowserWindow,
      () => address,
      'dot:folders',
      (url) => url === 'dots://workspace/?surface=approval',
    );
    picker.attach(window as unknown as BrowserWindow);
    expect(context()).toBe(true);
    await expect(choose()).resolves.toEqual({ path: '/chosen/project' });
    window.webContents.mainFrame.url = 'dots://workspace/?surface=workspace';
    expect(context()).toBe(false);
    await expect(choose()).rejects.toThrow();
  });
  it('returns only the selected path from a fixed parented directory dialog', async () => {
    await expect(choose()).resolves.toEqual({ path: '/chosen/project' });
    expect(host.showOpenDialog).toHaveBeenCalledExactlyOnceWith(window, {
      properties: ['openDirectory'],
      title: 'Choose a folder for your Dot',
      buttonLabel: 'Choose folder',
    });
    expect([...host.handlers.keys()]).toEqual(['dot:folders:choose']);
  });

  it('never accepts a caller path or dialog options', async () => {
    for (const input of [undefined, '/model/path', { defaultPath: '/private' }])
      await expect(choose(sender(), input)).rejects.toThrow();
    expect(host.showOpenDialog).not.toHaveBeenCalled();
  });

  it.each([
    'http://localhost:4310/?desktop=1',
    'http://127.0.0.1:9999/?desktop=1',
    'http://127.0.0.1:4310/other?desktop=1',
    'http://127.0.0.1:4310/',
    'http://127.0.0.1:4310/?desktop=0',
    'http://user@127.0.0.1:4310/?desktop=1',
    'dots://app/chat.html',
    'not a URL',
  ])('rejects the untrusted page %s', async (url) => {
    window.webContents.mainFrame.url = url;
    expect(context()).toBe(false);
    await expect(choose()).rejects.toThrow();
    expect(host.showOpenDialog).not.toHaveBeenCalled();
  });

  it.each(['https://workspace.example/', 'http://192.168.1.20:4310/'])(
    'rejects a configured non-loopback workspace %s',
    async (url) => {
      address = url;
      window.webContents.mainFrame.url = `${url}?desktop=1`;
      expect(context()).toBe(false);
      await expect(choose()).rejects.toThrow();
      expect(host.showOpenDialog).not.toHaveBeenCalled();
    },
  );

  it.each(['http://localhost:4310/', 'http://[::1]:4310/'])(
    'allows the configured loopback workspace %s',
    async (url) => {
      address = url;
      window.webContents.mainFrame.url = `${url}?desktop=1`;
      expect(context()).toBe(true);
      await expect(choose()).resolves.toEqual({ path: '/chosen/project' });
    },
  );

  it('rejects foreign web contents and matching-URL subframes', async () => {
    for (const event of [
      { ...sender(), sender: {} },
      { ...sender(), senderFrame: { url: workspaceUrl } },
      { ...sender(), senderFrame: null },
    ]) {
      expect(context(event as IpcMainInvokeEvent)).toBe(false);
      await expect(choose(event as IpcMainInvokeEvent)).rejects.toThrow();
    }
    expect(host.showOpenDialog).not.toHaveBeenCalled();
  });

  it.each(['visible', 'focused', 'minimized', 'destroyed'] as const)(
    'rejects an unavailable window (%s)',
    async (state) => {
      window[state] = state === 'minimized' || state === 'destroyed';
      await expect(choose()).rejects.toThrow();
      expect(host.showOpenDialog).not.toHaveBeenCalled();
    },
  );

  it('exposes trusted context before focus, but still requires focus to choose', async () => {
    window.focused = false;
    expect(context()).toBe(true);
    await expect(choose()).rejects.toThrow();
  });

  it.each([
    { canceled: true, filePaths: ['/discarded'] },
    { canceled: false, filePaths: [] },
  ])('returns null for cancellation or no selection', async (result) => {
    host.showOpenDialog.mockResolvedValueOnce(result);
    await expect(choose()).resolves.toBeNull();
  });

  it('rejects reentry until the native dialog has settled', async () => {
    const pending = pendingSelection();
    await expect(choose()).rejects.toThrow('already open');
    expect(host.showOpenDialog).toHaveBeenCalledOnce();
    pending.finish();
    await expect(pending.pending).resolves.toEqual({ path: '/chosen/project' });
    await expect(choose()).resolves.toEqual({ path: '/chosen/project' });
  });

  it('releases pending state after a native dialog failure', async () => {
    host.showOpenDialog.mockRejectedValueOnce(new Error('native failure'));
    await expect(choose()).rejects.toThrow('Could not open the folder chooser');
    await expect(choose()).resolves.toEqual({ path: '/chosen/project' });
  });

  it('retains the owner selection when the native sheet has not restored parent focus yet', async () => {
    const pending = pendingSelection();
    window.focused = false;
    pending.finish();
    await expect(pending.pending).resolves.toEqual({ path: '/chosen/project' });
  });

  it.each(['hide', 'minimize', 'close', 'closed'])(
    'discards selection when %s occurs while native dialog is pending',
    async (event) => {
      const pending = pendingSelection();
      window.emit(event);
      pending.finish();
      await expect(pending.pending).rejects.toThrow('Choose the folder again');
    },
  );

  it.each([
    'did-navigate',
    'did-navigate-in-page',
    'render-process-gone',
    'destroyed',
  ])('discards selection when the renderer emits %s', async (event) => {
    const pending = pendingSelection();
    window.webContents.emit(event);
    pending.finish();
    await expect(pending.pending).rejects.toThrow('Choose the folder again');
  });

  it('invalidates even a main-frame navigation that has not yet committed', async () => {
    const pending = pendingSelection();
    window.webContents.emit(
      'did-start-navigation',
      {},
      workspaceUrl,
      false,
      true,
    );
    pending.finish();
    await expect(pending.pending).rejects.toThrow('Choose the folder again');
  });

  it('does not discard selection for an unrelated subframe navigation', async () => {
    const pending = pendingSelection();
    window.webContents.emit(
      'did-start-navigation',
      {},
      'https://example.com/',
      false,
      false,
    );
    pending.finish();
    await expect(pending.pending).resolves.toEqual({ path: '/chosen/project' });
  });

  it.each([
    'url',
    'frame',
    'address',
    'window',
    'visible',
    'minimized',
    'destroyed',
  ])('revalidates %s after the native dialog returns', async (changed) => {
    const pending = pendingSelection();
    if (changed === 'url') window.webContents.mainFrame.url += '&changed=1';
    if (changed === 'frame')
      window.webContents.mainFrame = { url: workspaceUrl };
    if (changed === 'address') address = 'http://localhost:4310/';
    if (changed === 'window') window = windowDouble();
    if (changed === 'visible') window.visible = false;
    if (changed === 'minimized') window.minimized = true;
    if (changed === 'destroyed') window.destroyed = true;
    pending.finish();
    await expect(pending.pending).rejects.toThrow('Choose the folder again');
  });

  it('removes IPC and event listeners and drops any pending result on destroy', async () => {
    const pending = pendingSelection();
    picker.destroy();
    expect(host.handlers.size).toBe(0);
    expect(host.ipc!.listenerCount('dot:folders:context')).toBe(0);
    expect(window.eventNames()).toEqual([]);
    expect(window.webContents.eventNames()).toEqual([]);
    pending.finish();
    await expect(pending.pending).rejects.toThrow('Choose the folder again');
  });

  it.each(['destroy', 'replace'] as const)(
    'cleans up a closed window when the picker is asked to %s',
    (action) => {
      const closedWindow = window;
      const contents = window.webContents;
      closedWindow.destroyed = true;
      contents.emit('destroyed');
      closedWindow.emit('closed');
      // Electron's BrowserWindow accessor throws once its native window is gone.
      Object.defineProperty(closedWindow, 'webContents', {
        get() {
          throw new TypeError('Object has been destroyed');
        },
      });
      expect(() => {
        if (action === 'replace') {
          window = windowDouble();
          picker.attach(window as unknown as BrowserWindow);
        } else picker.destroy();
      }).not.toThrow();
      expect(closedWindow.eventNames()).toEqual([]);
      expect(contents.eventNames()).toEqual([]);
      picker.destroy();
      expect(host.handlers.size).toBe(0);
      expect(host.ipc!.listenerCount('dot:folders:context')).toBe(0);
    },
  );
});
