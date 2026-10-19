import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import {
  StorageController,
  type StorageInvocation,
} from '../../src/desktop/host/storage-controller.js';
import { BackupKeys } from '../../src/desktop/host/backup-keys.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(backend = 'gnome_libsecret') {
  const root = await mkdtemp(join(tmpdir(), 'dot-storage-ui-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const encryptString = vi.fn(() => Buffer.from('protected'));
  const keys = new BackupKeys({
    file: join(root, 'protected-key'),
    platform: 'linux',
    storage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => backend,
      encryptString,
      decryptString: () => 'password',
    },
  });
  const worker = { run: vi.fn() };
  const request = vi.fn();
  const controller = new StorageController({
    profile: root,
    keys,
    worker,
    configuration: () => ({
      workspace,
      database: join(workspace, 'data/opendots.sqlite'),
      envFile: join(workspace, '.env'),
    }),
    connection: () => ({
      url: 'http://127.0.0.1:4310',
      ownerToken: 'owner-token',
      owned: true,
    }),
    request,
    stopWorkspace: vi.fn(),
    afterRestore: vi.fn(),
  });
  const context: StorageInvocation = {
    trusted: () => true,
    focused: () => true,
    chooseDirectory: vi.fn(),
    chooseArchive: vi.fn(),
    confirmRestore: vi.fn(async () => true),
  };
  return {
    root,
    workspace,
    keys,
    worker,
    request,
    encryptString,
    controller,
    context,
  };
}
it('rejects untrusted or navigated IPC sender', async () => {
  const f = await fixture();
  f.context.trusted = () => false;
  await expect(
    f.controller.invoke('chooseBackupDirectory', undefined, f.context),
  ).rejects.toThrow(/sender/i);
  expect(f.context.chooseDirectory).not.toHaveBeenCalled();
  let trusted = true;
  f.context.trusted = () => trusted;
  vi.mocked(f.context.chooseDirectory).mockImplementationOnce(async () => {
    trusted = false;
    return f.root;
  });
  await expect(
    f.controller.invoke('chooseBackupDirectory', undefined, f.context),
  ).rejects.toThrow(/sender/i);
  expect(f.request).not.toHaveBeenCalled();
  expect(f.worker.run).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual(['workspace']);
});
it('cancelled chooser creates nothing', async () => {
  const f = await fixture();
  vi.mocked(f.context.chooseDirectory).mockResolvedValueOnce(undefined);
  expect(
    await f.controller.invoke('chooseBackupDirectory', undefined, f.context),
  ).toBe(false);
  expect(await readdir(f.root)).toEqual(['workspace']);
  expect(f.request).not.toHaveBeenCalled();
});
it('Linux basic_text never remembers password', async () => {
  const f = await fixture('basic_text');
  await expect(
    f.controller.invoke(
      'backupNow',
      { passphrase: 'private recovery password', remember: true },
      f.context,
    ),
  ).rejects.toThrow(/secure/i);
  expect(f.encryptString).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  expect(f.worker.run).not.toHaveBeenCalled();
});
it('rejects renderer paths and a backup destination inside the workspace', async () => {
  const f = await fixture();
  await expect(
    f.controller.invoke(
      'backupNow',
      { passphrase: 'password', remember: false, destination: f.root },
      f.context,
    ),
  ).rejects.toThrow();
  vi.mocked(f.context.chooseDirectory).mockResolvedValueOnce(f.workspace);
  await expect(
    f.controller.invoke('chooseBackupDirectory', undefined, f.context),
  ).rejects.toThrow(/outside/i);
  expect(f.worker.run).not.toHaveBeenCalled();
  const hidden = join(f.workspace, '..backups');
  await mkdir(hidden);
  vi.mocked(f.context.chooseDirectory).mockResolvedValueOnce(hidden);
  await expect(
    f.controller.invoke('chooseBackupDirectory', undefined, f.context),
  ).rejects.toThrow(/outside/i);
});
it('admits only one native chooser at a time', async () => {
  const f = await fixture();
  let finish!: (value: undefined) => void;
  vi.mocked(f.context.chooseDirectory).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.controller.invoke(
    'chooseBackupDirectory',
    undefined,
    f.context,
  );
  try {
    await expect(
      f.controller.invoke('chooseBackupDirectory', undefined, f.context),
    ).rejects.toThrow(/active|busy/i);
  } finally {
    finish(undefined);
    await pending;
  }
});
