import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
  rename,
  realpath,
  readFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
it('requires a secure remembered password and destination for automatic backups', async () => {
  const f = await fixture('basic_text');
  await expect(
    f.controller.invoke('setAutomatic', { enabled: true }, f.context),
  ).rejects.toThrow(/secure/i);
  const secure = await fixture();
  await expect(
    secure.controller.invoke('setAutomatic', { enabled: true }, secure.context),
  ).rejects.toThrow(/folder/i);
  vi.mocked(secure.context.chooseDirectory).mockResolvedValue(secure.root);
  await secure.controller.invoke(
    'chooseBackupDirectory',
    undefined,
    secure.context,
  );
  await expect(
    secure.controller.invoke('setAutomatic', { enabled: true }, secure.context),
  ).rejects.toThrow(/password/i);
  await secure.keys.remember('password');
  await secure.controller.invoke(
    'setAutomatic',
    { enabled: true },
    secure.context,
  );
  expect((await secure.controller.status()).automatic).toBe(true);
  await secure.controller.invoke(
    'setAutomatic',
    { enabled: false },
    secure.context,
  );
  expect((await secure.controller.status()).automatic).toBe(false);
});

it('runs changed daily backups only while idle and recovers after a missing destination', async () => {
  const f = await fixture();
  const destination = join(f.root, 'backups');
  await mkdir(destination);
  vi.mocked(f.context.chooseDirectory).mockResolvedValue(destination);
  await f.controller.invoke('chooseBackupDirectory', undefined, f.context);
  await f.keys.remember('password');
  await f.controller.invoke('setAutomatic', { enabled: true }, f.context);
  let revision = 'one',
    idle = false,
    archiveId = randomUUID();
  let archiveTime = Date.UTC(2026, 9, 20);
  const operation = randomUUID();
  const origins: string[] = [];
  f.request.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/storage/status'))
      return Response.json({ idle, revision });
    if (path.endsWith('/desktop/identity'))
      return Response.json({
        workspaceId: 'workspace',
        capabilities: ['workspace-snapshot-v1'],
      });
    if (path.endsWith('/storage/snapshots')) {
      origins.push(JSON.parse(init.body).origin);
      archiveId = randomUUID();
      return Response.json({ id: operation });
    }
    if (path.endsWith('/release')) return Response.json({ ok: true });
    return Response.json({
      phase: 'ready',
      directory: join(f.workspace, 'data/.storage-snapshots', operation),
      manifest: {
        version: 1,
        minimumReader: 1,
        kind: 'workspace-backup',
        archiveId,
        workspaceId: 'workspace',
        ownerId: 'owner',
        createdAt: new Date(archiveTime).toISOString(),
        entries: [],
        coverage: [],
      },
    });
  });
  f.worker.run.mockImplementation(async (command) => {
    await writeFile(command.destination, 'verified fixture archive');
    return {
      id: archiveId,
      createdAt: new Date(archiveTime).toISOString(),
      verified: true,
      coverage: [],
    };
  });
  const day = Date.UTC(2026, 9, 20);
  try {
    await f.controller.tick(day);
    expect(f.worker.run).not.toHaveBeenCalled();
    idle = true;
    await Promise.all([f.controller.tick(day), f.controller.tick(day)]);
    expect(origins).toEqual(['automatic']);
    const success = (await f.controller.status()).lastSuccess;
    await f.controller.tick(day + 86400000);
    expect(origins).toHaveLength(1);
    revision = 'two';
    archiveTime += 86400000;
    await rename(destination, destination + '-offline');
    await expect(f.controller.tick(day + 86400000)).rejects.toThrow();
    expect((await f.controller.status()).lastSuccess).toBe(success);
    expect((await f.controller.status()).error).toMatch(/failed/i);
    await rename(destination + '-offline', destination);
    await f.controller.tick(day + 86400000);
    expect(origins).toEqual(['automatic', 'automatic']);
    expect(
      (await readdir(destination)).filter((x) => x.endsWith('.dotbackup')),
    ).toHaveLength(2);
    const unmanaged = join(destination, 'user-managed.dotpack');
    await writeFile(unmanaged, 'never prune a user export');
    const changed = join(
      destination,
      (await readdir(destination)).find((name) => name.endsWith('.dotbackup'))!,
    );
    await writeFile(changed, 'user replaced this file with unrelated content');
    for (let offset = 2; offset < 35; offset++) {
      revision = `revision-${offset}`;
      archiveTime = day + offset * 86400000;
      await f.controller.tick(archiveTime);
    }
    const retained = (await readdir(destination)).filter((name) =>
      name.endsWith('.dotbackup'),
    );
    expect(retained.length).toBeGreaterThanOrEqual(7);
    expect(retained.length).toBeLessThanOrEqual(12);
    expect(await readFile(unmanaged, 'utf8')).toBe('never prune a user export');
    expect(await readFile(changed, 'utf8')).toBe(
      'user replaced this file with unrelated content',
    );
  } finally {
    await f.controller.close();
  }
});
it('changing backup folders clears managed ownership and requires opting in again', async () => {
  const f = await fixture();
  const a = join(f.root, 'a'),
    b = join(f.root, 'b');
  await mkdir(a);
  await mkdir(b);
  vi.mocked(f.context.chooseDirectory).mockResolvedValue(a);
  await f.controller.invoke('chooseBackupDirectory', undefined, f.context);
  await f.keys.remember('password');
  await f.controller.invoke('setAutomatic', { enabled: true }, f.context);
  vi.mocked(f.context.chooseDirectory).mockResolvedValue(b);
  await f.controller.invoke('chooseBackupDirectory', undefined, f.context);
  expect(await f.controller.status()).toMatchObject({
    automatic: false,
    destination: await realpath(b),
  });
});

it('close prevents a delayed idle check from starting an automatic backup', async () => {
  const f = await fixture();
  vi.mocked(f.context.chooseDirectory).mockResolvedValue(f.root);
  await f.controller.invoke('chooseBackupDirectory', undefined, f.context);
  await f.keys.remember('password');
  await f.controller.invoke('setAutomatic', { enabled: true }, f.context);
  let finish!: (value: Response) => void;
  f.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const tick = f.controller.tick();
  await vi.waitFor(() => expect(finish).toBeDefined());
  const closing = f.controller.close();
  finish(Response.json({ idle: true, revision: 'changed' }));
  await Promise.all([tick, closing]);
  expect(f.worker.run).not.toHaveBeenCalled();
  expect((await f.controller.status()).lastSuccess).toBeUndefined();
});
it('discards superseded, cancelled and closed restore previews through the worker', async () => {
  const f = await fixture();
  await writeFile(
    join(f.workspace, '.env'),
    'LOCAL_DATABASE_URL=postgres://fixture',
  );
  vi.mocked(f.context.chooseArchive).mockResolvedValue(join(f.root, 'archive'));
  vi.mocked(f.context.chooseDirectory).mockResolvedValue(f.root);
  const discarded: string[] = [];
  f.worker.run.mockImplementation(async (command) => {
    if (command.kind === 'discard') {
      discarded.push(command.operationId);
      return { discarded: true };
    }
    return {
      operationId: randomUUID(),
      workspaceId: 'fixture',
      counts: {},
      coverage: [],
      warnings: [],
    };
  });
  await f.controller.invoke(
    'previewRestore',
    { passphrase: 'password' },
    f.context,
  );
  const first = (await f.controller.status()).preview!.operationId;
  await f.controller.invoke(
    'previewRestore',
    { passphrase: 'password' },
    f.context,
  );
  const second = (await f.controller.status()).preview!.operationId;
  expect(discarded).toEqual([first]);
  await f.controller.invoke('cancel', second, f.context);
  expect(discarded).toEqual([first, second]);
  expect((await f.controller.status()).preview).toBeUndefined();
  await f.controller.invoke(
    'previewRestore',
    { passphrase: 'password' },
    f.context,
  );
  const third = (await f.controller.status()).preview!.operationId;
  await f.controller.close();
  expect(discarded).toEqual([first, second, third]);
});
it('retains an unremovable preview with a notice without blocking a new recovery', async () => {
  const f = await fixture();
  await writeFile(
    join(f.workspace, '.env'),
    'LOCAL_DATABASE_URL=postgres://fixture',
  );
  vi.mocked(f.context.chooseArchive).mockResolvedValue(join(f.root, 'archive'));
  vi.mocked(f.context.chooseDirectory).mockResolvedValue(f.root);
  f.worker.run.mockImplementation(async (command) => {
    if (command.kind === 'discard') throw new Error('Changed target retained');
    return {
      operationId: randomUUID(),
      workspaceId: 'fixture',
      counts: {},
      coverage: [],
      warnings: [],
    };
  });
  await f.controller.invoke(
    'previewRestore',
    { passphrase: 'password' },
    f.context,
  );
  const first = (await f.controller.status()).preview!.operationId;
  await expect(
    f.controller.invoke(
      'previewRestore',
      { passphrase: 'password' },
      f.context,
    ),
  ).resolves.toBeUndefined();
  expect((await f.controller.status()).preview!.operationId).not.toBe(first);
  expect((await f.controller.status()).recoveryWarnings?.join(' ')).toMatch(
    /retained|cleanup/,
  );
  await expect(f.controller.close()).resolves.toBeUndefined();
});
