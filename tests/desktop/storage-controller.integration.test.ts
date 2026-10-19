import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import {
  StorageController,
  type StorageInvocation,
} from '../../src/desktop/host/storage-controller.js';
import { ArchiveWorkerClient } from '../../src/desktop/host/archive-worker-client.js';
import { BackupKeys } from '../../src/desktop/host/backup-keys.js';
import { LegacySnapshotSource } from '../../src/server/storage/legacy-snapshot.js';
import {
  SnapshotOperations,
  snapshotRoutes,
} from '../../src/server/storage/snapshot-routes.js';
import { storageWorkspace } from '../fixtures/storage-workspace.js';

it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'backs up and previews/restores through the native controller and real archive worker',
  async () => {
    const f = await storageWorkspace();
    const destination = await mkdtemp(join(tmpdir(), 'dot-native-backups-'));
    const profile = join(f.root, 'profile');
    await mkdir(profile);
    await writeFile(
      join(profile, 'workspace-location.json'),
      JSON.stringify({ directory: f.root }),
    );
    await writeFile(
      f.configurationPath,
      `LOCAL_DATABASE_URL=${f.postgresUrl}\n`,
    );
    const snapshots = new SnapshotOperations(
      new LegacySnapshotSource({
        ...f,
        owned: true,
        conversationBackend: 'local',
      }),
      join(f.root, '.storage-snapshots'),
    );
    const api = new Hono();
    api.use('*', async (c, next) => {
      if (c.req.header('authorization') !== 'Bearer fixture-owner-token')
        return c.json({}, 401);
      await next();
    });
    api.get('/api/desktop/identity', (c) =>
      c.json({
        workspaceId: f.workspaceId,
        capabilities: ['workspace-snapshot-v1'],
      }),
    );
    api.route('/api', snapshotRoutes(snapshots));
    const stopWorkspace = vi.fn(async () => {});
    const controller = new StorageController({
      profile,
      keys: new BackupKeys({
        file: join(profile, 'key'),
        platform: 'linux',
        storage: {
          isEncryptionAvailable: () => false,
          encryptString: () => {
            throw new Error('Must not be called');
          },
          decryptString: () => {
            throw new Error('Must not be called');
          },
        },
      }),
      worker: new ArchiveWorkerClient({
        entry: fileURLToPath(
          new URL('../../src/desktop/host/archive-worker.ts', import.meta.url),
        ),
        execArgv: ['--import', 'tsx'],
      }),
      configuration: () => ({
        workspace: f.root,
        database: f.sqlitePath,
        envFile: f.configurationPath,
      }),
      connection: () => ({
        url: 'http://127.0.0.1:4310',
        ownerToken: 'fixture-owner-token',
        owned: true,
      }),
      request: async (url, init) => api.request(String(url), init),
      stopWorkspace,
      afterRestore: async () => {},
    });
    let archive: string | undefined;
    const context: StorageInvocation = {
      trusted: () => true,
      focused: () => true,
      chooseDirectory: async () => destination,
      chooseArchive: async () => archive,
      confirmRestore: async () => true,
    };
    const phases: string[] = [];
    controller.subscribe((status) => {
      if (status.operation) phases.push(status.operation.phase);
    });
    try {
      await controller.invoke('chooseBackupDirectory', undefined, context);
      await controller.invoke(
        'backupNow',
        { passphrase: 'private fixture password', remember: false },
        context,
      );
      const status = await controller.status();
      expect(status.lastSuccess).toBeDefined();
      expect(status.operation?.phase).toBe('ready');
      expect(phases).toEqual(
        expect.arrayContaining(['snapshot', 'archive', 'verify', 'ready']),
      );
      const files = await readdir(destination);
      expect(files).toHaveLength(1);
      archive = join(destination, files[0]);
      expect(await readdir(join(f.root, '.storage-snapshots'))).toEqual([]);
      const release = await f.gate.enterWrite(new AbortController().signal);
      try {
        await expect(
          controller.invoke(
            'backupNow',
            { passphrase: 'private fixture password', remember: false },
            context,
          ),
        ).rejects.toThrow(/active|busy|turn|voice/i);
      } finally {
        release();
      }
      expect((await controller.status()).lastSuccess).toBe(status.lastSuccess);
      expect(await readdir(destination)).toEqual(files);
      await controller.invoke(
        'previewRestore',
        { passphrase: 'private fixture password' },
        context,
      );
      const preview = (await controller.status()).preview!;
      expect(preview.counts.local_ai_threads).toBe(1);
      expect(preview.counts.memory_items).toBe(2);
      expect(stopWorkspace).not.toHaveBeenCalled();
      await controller.invoke(
        'restore',
        { operationId: preview.operationId, mode: 'new' },
        context,
      );
      expect(stopWorkspace).toHaveBeenCalledOnce();
      const selection = JSON.parse(
        await readFile(join(profile, 'workspace-location.json'), 'utf8'),
      );
      expect(selection.directory).not.toBe(f.root);
      expect(
        (await f.conversations.getSnapshot(f.thread)).messages,
      ).toHaveLength(2);
    } finally {
      await controller.close();
      await snapshots.close();
      for (const folder of await readdir(destination)) {
        if (!folder.startsWith('Dots-restored-')) continue;
        const env = parseEnv(
          await readFile(join(destination, folder, '.env'), 'utf8'),
        );
        const name = new URL(env.LOCAL_DATABASE_URL!).pathname.slice(1);
        if (/^dots_restore_[a-f0-9]{32}$/.test(name))
          await f.pg.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
      await f.dispose();
      await rm(destination, { recursive: true, force: true });
    }
  },
  20000,
);
