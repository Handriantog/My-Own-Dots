import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopVoiceBridge } from '../../src/desktop/shared/voice-contract.js';

const host = vi.hoisted(() => ({
  trusted: true,
  foldersTrusted: true,
  exposed: new Map<string, unknown>(),
  ipc: null as EventEmitter | null,
  invoke: vi.fn(async () => {}),
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  host.ipc = Object.assign(new EventEmitter(), {
    sendSync: (channel: string) =>
      channel === 'dot:folders:context' ? host.foldersTrusted : host.trusted,
    invoke: host.invoke,
  });
  return {
    ipcRenderer: host.ipc,
    contextBridge: {
      exposeInMainWorld: (name: string, value: unknown) =>
        host.exposed.set(name, value),
    },
  };
});
beforeEach(() => {
  vi.resetModules();
  host.exposed.clear();
  host.invoke.mockClear();
  host.trusted = true;
  host.foldersTrusted = true;
  vi.stubGlobal('location', new URL('http://127.0.0.1:4310/?desktop=1'));
  vi.stubGlobal('process', { ...process, isMainFrame: true });
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
});
afterEach(() => {
  host.ipc?.removeAllListeners();
  vi.unstubAllGlobals();
});

it('does not expose a voice bridge to a denied workspace or subframe', async () => {
  host.trusted = false;
  host.foldersTrusted = false;
  await import('../../src/desktop/chat-preload.js');
  expect(host.exposed.size).toBe(0);
  vi.resetModules();
  host.trusted = true;
  vi.stubGlobal('process', { ...process, isMainFrame: false });
  await import('../../src/desktop/chat-preload.js');
  expect(host.exposed.size).toBe(0);
});

it('exposes only folder selection, with no caller arguments crossing IPC', async () => {
  await import('../../src/desktop/chat-preload.js');
  const bridge = host.exposed.get('dotFolders') as {
    choose(...args: unknown[]): Promise<unknown>;
  };
  expect(bridge).toBeDefined();
  expect(Object.keys(bridge)).toEqual(['choose']);
  await bridge.choose('/model/suggested/path', { defaultPath: '/private' });
  expect(host.invoke.mock.calls).toEqual([['dot:folders:choose']]);
});

it('requires an active user click before invoking the native folder chooser', async () => {
  await import('../../src/desktop/chat-preload.js');
  const bridge = host.exposed.get('dotFolders') as {
    choose(): Promise<unknown>;
  };
  expect(bridge).toBeDefined();
  vi.stubGlobal('navigator', { userActivation: { isActive: false } });
  await expect(bridge.choose()).rejects.toThrow('Choose a folder');
  expect(host.invoke).not.toHaveBeenCalled();
  vi.stubGlobal('navigator', {});
  await expect(bridge.choose()).rejects.toThrow('Choose a folder');
  expect(host.invoke).not.toHaveBeenCalled();
});

it('uses the separate folder context decision while preserving voice exposure', async () => {
  host.foldersTrusted = false;
  await import('../../src/desktop/chat-preload.js');
  expect(host.exposed.has('dotFolders')).toBe(false);
  expect(host.exposed.has('dotVoice')).toBe(true);
});

it.each(['dots://app/chat.html', 'file:///workspace/index.html'])(
  'does not expose folder selection to %s',
  async (url) => {
    vi.stubGlobal('location', new URL(url));
    await import('../../src/desktop/chat-preload.js');
    expect(host.exposed.has('dotFolders')).toBe(false);
  },
);

it('delivers Talk received before React subscribes once and unsubscribes controls', async () => {
  await import('../../src/desktop/chat-preload.js');
  const bridge = host.exposed.get('dotVoice') as DesktopVoiceBridge;
  expect(Object.keys(bridge).sort()).toEqual([
    'activate',
    'begin',
    'cancelStart',
    'cancelTalk',
    'end',
    'isWindowless',
    'onStop',
    'onTalk',
    'phase',
    'reportError',
    'setReady',
  ]);
  host.ipc!.emit('dot:voice:talk');
  const talk = vi.fn();
  const offTalk = bridge.onTalk(talk);
  expect(talk).toHaveBeenCalledOnce();
  host.ipc!.emit('dot:voice:talk');
  expect(talk).toHaveBeenCalledTimes(2);
  offTalk();
  const stop = vi.fn();
  const offStop = bridge.onStop(stop);
  host.ipc!.emit('dot:voice:stop', {}, 'hidden');
  expect(stop).toHaveBeenCalledWith('hidden');
  offStop();
  host.ipc!.emit('dot:voice:stop', {}, 'sleep');
  expect(stop).toHaveBeenCalledOnce();
  await bridge.begin('call-12345678');
  await bridge.end('call-12345678');
  expect(host.invoke.mock.calls).toEqual([
    ['dot:voice:begin', 'call-12345678'],
    ['dot:voice:end', 'call-12345678'],
  ]);
});

it('discards a queued Talk on stop before React subscribes', async () => {
  await import('../../src/desktop/chat-preload.js');
  const bridge = host.exposed.get('dotVoice') as DesktopVoiceBridge;
  host.ipc!.emit('dot:voice:talk');
  host.ipc!.emit('dot:voice:stop', {}, 'hidden');
  const talk = vi.fn();
  bridge.onTalk(talk);
  expect(talk).not.toHaveBeenCalled();
});

it('retains windowless intent before subscribing and clears it on end and native stop', async () => {
  await import('../../src/desktop/chat-preload.js');
  const bridge = host.exposed.get('dotVoice') as DesktopVoiceBridge;
  expect(bridge.isWindowless()).toBe(false);
  host.ipc!.emit('dot:voice:talk', {}, true);
  const received: boolean[] = [];
  bridge.onTalk(() => received.push(bridge.isWindowless()));
  expect(received).toEqual([true]);
  await bridge.phase('call-12345678', 'speaking');
  expect(host.invoke).toHaveBeenCalledWith('dot:voice:phase', {
    callId: 'call-12345678',
    phase: 'speaking',
  });
  await bridge.end('call-12345678');
  expect(bridge.isWindowless()).toBe(false);
  host.ipc!.emit('dot:voice:talk', {}, true);
  host.ipc!.emit('dot:voice:stop', {}, 'shortcut');
  expect(bridge.isWindowless()).toBe(false);
});
