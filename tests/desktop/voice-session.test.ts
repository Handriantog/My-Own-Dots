import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

const host = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipc: null as EventEmitter | null,
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  host.ipc = Object.assign(new EventEmitter(), {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      host.handlers.set(name, callback),
    removeHandler: (name: string) => host.handlers.delete(name),
  });
  return { ipcMain: host.ipc };
});

import { CompanionVoiceSession } from '../../src/desktop/host/voice-session.js';

const url = 'http://127.0.0.1:4310/?desktop=1';
function windowDouble() {
  type Check = (...args: unknown[]) => boolean;
  type Request = (...args: unknown[]) => void;
  const session = {
    check: (..._args: unknown[]) => false,
    request: (..._args: unknown[]) => {},
    setPermissionCheckHandler(callback: Check) {
      this.check = callback;
    },
    setPermissionRequestHandler(callback: Request) {
      this.request = callback;
    },
  };
  const window = {
    visible: true,
    focused: true,
    destroyed: false,
    webContents: {
      mainFrame: { url },
      session,
      send: vi.fn(),
      reload: vi.fn(),
      executeJavaScript: vi.fn(async () => true),
    },
    isVisible: () => window.visible,
    isFocused: () => window.focused,
    isDestroyed: () => window.destroyed,
  };
  return window;
}
let window: ReturnType<typeof windowDouble>;
let voice: CompanionVoiceSession;
let active: boolean[];
function sender() {
  return {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  } as unknown as IpcMainInvokeEvent;
}
function invoke(name: string, payload?: unknown, event = sender()) {
  const handler = host.handlers.get(`dot:voice:${name}`);
  if (!handler) throw new Error(`Missing voice handler: ${name}`);
  return handler(event, payload);
}
function ready() {
  invoke('ready', true);
}
function permission(type = 'audio', extras: Record<string, unknown> = {}) {
  let allowed = false;
  window.webContents.session.request(
    window.webContents,
    'media',
    (value: boolean) => {
      allowed = value;
    },
    { isMainFrame: true, requestingUrl: url, mediaTypes: [type], ...extras },
  );
  return allowed;
}
beforeEach(() => {
  vi.useFakeTimers();
  window = windowDouble();
  active = [];
  voice = new CompanionVoiceSession(
    () => window as unknown as BrowserWindow,
    () => 'http://127.0.0.1:4310/',
    { active: (value) => active.push(value), ready() {} },
  );
  voice.attach(window as unknown as BrowserWindow);
});
afterEach(() => {
  voice.destroy();
  host.ipc?.removeAllListeners();
  host.handlers.clear();
  vi.useRealTimers();
});

describe('desktop microphone scope', () => {
  it('activates one fresh native Talk intent without granting microphone permission', async () => {
    ready();
    expect(() => invoke('activate')).toThrow();
    voice.talk();
    expect(window.webContents.send).toHaveBeenCalledWith('dot:voice:talk');
    await invoke('activate');
    expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(
      "window.dispatchEvent(new Event('dot-voice-start'))",
      true,
    );
    expect(permission()).toBe(false);
    expect(() => invoke('activate')).toThrow();
  });
  it('does not replay Talk after hide, navigation, expiry, or from an untrusted frame', async () => {
    ready();
    voice.talk();
    expect(() =>
      invoke('activate', undefined, {
        ...sender(),
        senderFrame: { url },
      } as IpcMainInvokeEvent),
    ).toThrow();
    window.focused = false;
    expect(() => invoke('activate')).toThrow();
    window.focused = true;
    voice.stop('hidden');
    expect(window.webContents.send).toHaveBeenCalledWith(
      'dot:voice:stop',
      'hidden',
    );
    expect(() => invoke('activate')).toThrow();
    voice.talk();
    invoke('cancel-talk');
    expect(() => invoke('activate')).toThrow();
    voice.talk();
    voice.reset();
    ready();
    expect(() => invoke('activate')).toThrow();
    voice.talk();
    await vi.advanceTimersByTimeAsync(30001);
    expect(() => invoke('activate')).toThrow();
    expect(window.webContents.executeJavaScript).not.toHaveBeenCalled();
  });
  it('exposes context only to the configured workspace main frame', () => {
    const context = (event: ReturnType<typeof sender>) => {
      const request = { ...event, returnValue: undefined as unknown };
      host.ipc!.emit('dot:voice:context', request);
      return request.returnValue;
    };
    expect(context(sender())).toBe(true);
    expect(
      context({ ...sender(), senderFrame: { url } } as IpcMainInvokeEvent),
    ).toBe(false);
    window.webContents.mainFrame.url = 'http://localhost:4310/?desktop=1';
    expect(context(sender())).toBe(false);
  });
  it('allows only audio after a ready, deliberate, focused begin', () => {
    expect(permission()).toBe(false);
    expect(() => invoke('begin', 'call-12345678')).toThrow();
    ready();
    window.focused = false;
    expect(() => invoke('begin', 'call-12345678')).toThrow();
    window.focused = true;
    invoke('begin', 'call-12345678');
    expect(permission()).toBe(true);
    expect(permission('video')).toBe(false);
    expect(permission('audio', { mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(permission('audio', { mediaTypes: [] })).toBe(false);
    expect(active).toEqual([true]);
    invoke('end', 'call-12345678');
    expect(permission()).toBe(false);
    expect(active).toEqual([true, false]);
  });
  it('rejects subframes, foreign senders, other local ports, and non-workspace paths', () => {
    ready();
    const original = sender();
    for (const event of [
      { ...original, sender: {} },
      { ...original, senderFrame: { url } },
    ])
      expect(() =>
        invoke('begin', 'call-12345678', event as IpcMainInvokeEvent),
      ).toThrow();
    invoke('begin', 'call-12345678');
    expect(permission('audio', { isMainFrame: false })).toBe(false);
    for (const requestingUrl of [
      'http://127.0.0.1:9999/?desktop=1',
      'http://127.0.0.1:4310/other?desktop=1',
      'http://127.0.0.1:4310/',
    ]) {
      expect(permission('audio', { requestingUrl })).toBe(false);
    }
    const check = window.webContents.session.check;
    expect(
      check(window.webContents, 'media', 'http://127.0.0.1:4310', {
        isMainFrame: true,
        requestingUrl: url,
        mediaType: 'audio',
      }),
    ).toBe(true);
    expect(
      check(window.webContents, 'media', 'http://evil.test', {
        isMainFrame: true,
        requestingUrl: url,
        mediaType: 'audio',
      }),
    ).toBe(false);
    expect(
      check(window.webContents, 'media', 'http://127.0.0.1:4310', {
        isMainFrame: false,
        requestingUrl: url,
        mediaType: 'audio',
      }),
    ).toBe(false);
  });
  it('rejects malformed, overlapping, and stale call commands', () => {
    ready();
    for (const value of [null, '', 'a', 'x'.repeat(129), '../call-1234'])
      expect(() => invoke('begin', value)).toThrow();
    invoke('begin', 'call-12345678');
    invoke('begin', 'call-12345678');
    expect(() => invoke('begin', 'call-87654321')).toThrow();
    expect(() => invoke('end', 'call-87654321')).toThrow();
    invoke('end', 'call-12345678');
    invoke('end', 'call-12345678');
    expect(() => invoke('begin', 'call-12345678')).toThrow();
    expect(active).toEqual([true, false]);
  });
  it('revokes immediately on stop and reloads only an unacknowledged renderer', async () => {
    ready();
    invoke('begin', 'call-12345678');
    voice.stop('hidden');
    expect(permission()).toBe(false);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'dot:voice:stop',
      'hidden',
    );
    window.visible = false;
    invoke('end', 'call-12345678');
    await vi.advanceTimersByTimeAsync(1100);
    expect(window.webContents.reload).not.toHaveBeenCalled();
    window.visible = true;
    invoke('begin', 'call-87654321');
    voice.stop('sleep');
    await vi.advanceTimersByTimeAsync(1100);
    expect(window.webContents.reload).toHaveBeenCalledOnce();
    expect(voice.ready).toBe(false);
  });
  it('stops when readiness is withdrawn and never resumes automatically', () => {
    ready();
    invoke('begin', 'call-12345678');
    invoke('ready', false);
    expect(permission()).toBe(false);
    expect(window.webContents.send).toHaveBeenCalledWith(
      'dot:voice:stop',
      'unavailable',
    );
    invoke('end', 'call-12345678');
    ready();
    expect(permission()).toBe(false);
  });
});
