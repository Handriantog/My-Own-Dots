import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopStorageBridge } from '../../src/desktop/shared/storage-contract.js';
import type { DesktopAbilities } from '../../src/shared/abilities/desktop.js';
const host = vi.hoisted(() => ({
  trusted: true,
  exposed: new Map<string, unknown>(),
  invoke: vi.fn(async () => {}),
  ipc: null as EventEmitter | null,
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
  host.trusted = true;
  host.exposed.clear();
  host.invoke.mockClear();
  vi.stubGlobal('location', new URL('dots://workspace/'));
  vi.stubGlobal('process', { ...process, isMainFrame: true });
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
});
afterEach(() => {
  host.ipc?.removeAllListeners();
  vi.unstubAllGlobals();
});
it('exposes no storage bridge to subframes or denied documents', async () => {
  host.trusted = false;
  await import('../../src/desktop/workspace-preload.js');
  expect(host.exposed.size).toBe(0);
  vi.resetModules();
  host.trusted = true;
  vi.stubGlobal('process', { ...process, isMainFrame: false });
  await import('../../src/desktop/workspace-preload.js');
  expect(host.exposed.size).toBe(0);
});
it('requires a user gesture for storage actions and sends no chooser paths', async () => {
  await import('../../src/desktop/workspace-preload.js');
  const bridge = host.exposed.get('dotStorage') as DesktopStorageBridge;
  expect(bridge).toBeDefined();
  vi.stubGlobal('navigator', { userActivation: { isActive: false } });
  await expect(
    bridge.backupNow({ passphrase: 'fixture secret', remember: false }),
  ).rejects.toThrow(/controls/i);
  expect(host.invoke).not.toHaveBeenCalled();
  vi.stubGlobal('navigator', { userActivation: { isActive: true } });
  await (
    bridge.chooseBackupDirectory as (...args: unknown[]) => Promise<boolean>
  )('/untrusted/path');
  expect(host.invoke).toHaveBeenCalledWith(
    'dot:storage:chooseBackupDirectory',
    undefined,
  );
});
it('exposes Abilities only to a trusted bundled frame and requires a gesture for consent', async () => {
  await import('../../src/desktop/workspace-preload.js');
  const bridge = host.exposed.get('dotAbilities') as DesktopAbilities;
  expect(bridge).toBeDefined();
  vi.stubGlobal('navigator', { userActivation: { isActive: false } });
  expect(await bridge.teach({ dotId: 'dot', reviewId: 'fixture' })).toEqual({
    ok: false,
    code: 'permission_denied',
  });
  expect(host.invoke).not.toHaveBeenCalled();
  vi.resetModules();
  host.exposed.clear();
  vi.stubGlobal('location', new URL('https://example.com/'));
  await import('../../src/desktop/workspace-preload.js');
  expect(host.exposed.has('dotAbilities')).toBe(false);
});
it('refreshes the Ability catalog without activation while installation and assignment require a gesture', async () => {
  await import('../../src/desktop/workspace-preload.js');
  const bridge = host.exposed.get('dotAbilities') as DesktopAbilities;
  vi.stubGlobal('navigator', { userActivation: { isActive: false } });
  await bridge.catalog({});
  expect(host.invoke).toHaveBeenCalledExactlyOnceWith(
    'dot:abilities:catalog',
    {},
  );
  host.invoke.mockClear();
  const denied = { ok: false, code: 'permission_denied' };
  expect(await bridge.install({ reviewId: 'fixture' })).toEqual(denied);
  expect(await bridge.master({ digest: 'fixture', enabled: true })).toEqual(
    denied,
  );
  expect(await bridge.applyAll({ digest: 'fixture' })).toEqual(denied);
  expect(
    await bridge.assign({ dotId: 'dot', digest: 'fixture', enabled: true }),
  ).toEqual(denied);
  expect(host.invoke).not.toHaveBeenCalled();
});

it('allows public discovery and fixed documentation reads without granting install or removal activation', async () => {
  await import('../../src/desktop/workspace-preload.js');
  const bridge = host.exposed.get('dotAbilities') as DesktopAbilities;
  vi.stubGlobal('navigator', { userActivation: { isActive: false } });
  await bridge.browse({});
  expect(host.invoke).toHaveBeenCalledWith('dot:abilities:browse', {});
  await bridge.documentation({ source: 'installed', digest: 'a'.repeat(64) });
  expect(host.invoke).toHaveBeenCalledWith('dot:abilities:documentation', {
    source: 'installed',
    digest: 'a'.repeat(64),
  });
  host.invoke.mockClear();
  expect(
    await bridge.uninstall({ digest: 'a'.repeat(64), removeFromDots: true }),
  ).toEqual({ ok: false, code: 'permission_denied' });
  expect(host.invoke).not.toHaveBeenCalled();
});
