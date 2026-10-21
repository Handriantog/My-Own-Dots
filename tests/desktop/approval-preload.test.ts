import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopApprovalBridge } from '../../src/desktop/shared/approval-contract.js';
import type { DesktopFolderBridge } from '../../src/desktop/shared/folder-contract.js';

const host = vi.hoisted(() => ({
  trusted: true,
  exposed: new Map<string, unknown>(),
  ipc: null as EventEmitter | null,
  invoke: vi.fn(async () => {}),
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  host.ipc = Object.assign(new EventEmitter(), {
    sendSync: () => host.trusted,
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
  vi.stubGlobal('location', new URL('dots://workspace/?surface=approval'));
  vi.stubGlobal('process', { ...process, isMainFrame: true });
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
});
afterEach(() => {
  host.ipc?.removeAllListeners();
  vi.unstubAllGlobals();
});

it('exposes presentation and gesture-gated selection without storage, voice or generic IPC', async () => {
  await import('../../src/desktop/approval-preload.js');
  expect([...host.exposed.keys()].sort()).toEqual([
    'dotApproval',
    'dotFolders',
  ]);
  const bridge = host.exposed.get('dotApproval') as DesktopApprovalBridge;
  expect(Object.keys(bridge).sort()).toEqual([
    'dismiss',
    'next',
    'onState',
    'state',
  ]);
  const folder = host.exposed.get('dotFolders') as DesktopFolderBridge;
  vi.stubGlobal('navigator', { userActivation: { isActive: false } });
  await expect(folder.choose()).rejects.toThrow('folder button');
  expect(host.invoke).not.toHaveBeenCalled();
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
  await folder.choose();
  expect(host.invoke.mock.calls).toEqual([['dot:approval-folders:choose']]);
  const callback = vi.fn();
  const remove = bridge.onState(callback);
  const state = { request: null, count: 0 };
  host.ipc!.emit('dot:approval:changed', {}, state);
  expect(callback).toHaveBeenCalledExactlyOnceWith(state);
  remove();
  host.ipc!.emit('dot:approval:changed', {}, state);
  expect(callback).toHaveBeenCalledTimes(1);
});

it.each([
  'dots://workspace/?surface=companion',
  'dots://workspace/?surface=approval&extra=1',
  'https://example.com/',
  'dots://app/chat.html',
])('exposes no capability on %s', async (url) => {
  vi.stubGlobal('location', new URL(url));
  await import('../../src/desktop/approval-preload.js');
  expect(host.exposed.size).toBe(0);
});

it('exposes nothing to a denied host or subframe', async () => {
  host.trusted = false;
  await import('../../src/desktop/approval-preload.js');
  expect(host.exposed.size).toBe(0);
  vi.resetModules();
  host.trusted = true;
  vi.stubGlobal('process', { ...process, isMainFrame: false });
  await import('../../src/desktop/approval-preload.js');
  expect(host.exposed.size).toBe(0);
});
