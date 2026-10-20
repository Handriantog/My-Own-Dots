import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { WorkspaceBackend } from '../../src/desktop/host/workspace-backend.js';
import {
  StorageController,
  type StorageInvocation,
} from '../../src/desktop/host/storage-controller.js';
import { ArchiveWorkerClient } from '../../src/desktop/host/archive-worker-client.js';
import { BackupKeys } from '../../src/desktop/host/backup-keys.js';
import { readArchive } from '../../src/server/storage/archive.js';

it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'backs up a legacy workspace with no configured token through the owned backend and archive worker',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dots-owned-backup-'));
    const ownerId = randomUUID();
    const workspace = join(root, 'workspace');
    const destination = join(root, 'backups');
    const profile = join(root, 'profile');
    const bundle = join(root, 'runtime');
    const backend = new WorkspaceBackend({
      bundle,
      data: profile,
      sourceRoot: workspace,
      environment: { DO_NOT_TRACK: '1' },
      startupTimeoutMs: 15000,
    });
    let controller: StorageController | undefined;
    try {
      const compiler = await import(
        pathToFileURL(resolve('scripts/desktop-runtime.mjs')).href
      );
      await compiler.compileDesktopRuntime(process.cwd(), bundle);
      await symlink(
        resolve('node_modules'),
        join(bundle, 'node_modules'),
        'junction',
      );
      await mkdir(workspace);
      await mkdir(destination);
      const server = createServer();
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const port = (server.address() as { port: number }).port;
      await new Promise<void>((done) => server.close(() => done()));
      const configuration = [
        `PORT=${port}`,
        `OWNER_ID=${ownerId}`,
        'CONVERSATION_BACKEND=local',
        'LLM_BACKEND=subscription',
        'LLM_PROVIDER=codex',
        `LOCAL_DATABASE_URL=${process.env.LOCAL_TEST_DATABASE_URL}`,
        '',
      ].join('\n');
      await writeFile(join(workspace, '.env'), configuration);
      const connection = await backend.start();
      const headers = {
        authorization: `Bearer ${connection.ownerToken}`,
        'content-type': 'application/json',
      };
      const identity = await fetch(`${connection.url}/api/desktop/identity`, {
        headers,
      }).then((response) => response.json());
      expect(identity.capabilities).toContain('workspace-snapshot-v1');
      expect(
        (await fetch(`${connection.url}/api/storage/activity`)).status,
      ).toBe(401);
      const memory = await fetch(`${connection.url}/api/memories`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'Retain this legacy workspace memory' }),
      });
      expect(memory.ok).toBe(true);
      controller = new StorageController({
        profile,
        configuration: () => backend.configuration,
        connection: () => connection,
        keys: new BackupKeys({
          file: join(profile, 'key'),
          platform: 'linux',
          storage: {
            isEncryptionAvailable: () => false,
            encryptString: () => {
              throw new Error('Password storage not requested');
            },
            decryptString: () => {
              throw new Error('Password storage not requested');
            },
          },
        }),
        worker: new ArchiveWorkerClient({
          entry: resolve('src/desktop/host/archive-worker.ts'),
          execArgv: ['--import', 'tsx'],
        }),
        stopWorkspace: () => backend.stop(),
        afterRestore: async () => {},
      });
      const context: StorageInvocation = {
        trusted: () => true,
        focused: () => true,
        chooseDirectory: async () => destination,
        chooseBackupFile: async () => undefined,
        chooseArchive: async () => undefined,
        confirmRestore: async () => true,
        confirmMigration: async () => true,
        confirmMove: async () => true,
        openDirectory: async () => {},
      };
      await controller.invoke('chooseBackupDirectory', undefined, context);
      await controller.invoke(
        'backupNow',
        {
          passphrase: 'disposable backup test password',
          remember: false,
        },
        context,
      );
      expect((await controller.status()).lastSuccess).toBeDefined();
      const archives = (await readdir(destination)).filter((name) =>
        name.endsWith('.dotbackup'),
      );
      expect(archives).toHaveLength(1);
      const stagingDirectory = join(root, 'extracted');
      await readArchive({
        source: join(destination, archives[0]),
        stagingDirectory,
        passphrase: 'disposable backup test password',
        signal: new AbortController().signal,
      });
      const restored = new DatabaseSync(
        join(stagingDirectory, 'core/workspace.sqlite'),
        { readOnly: true },
      );
      try {
        expect(
          restored
            .prepare(
              "SELECT json_extract(value, '$.text') AS text FROM memory_items",
            )
            .all(),
        ).toEqual([
          expect.objectContaining({
            text: 'Retain this legacy workspace memory',
          }),
        ]);
      } finally {
        restored.close();
      }
      expect(await readFile(join(workspace, '.env'), 'utf8')).toBe(
        configuration,
      );
    } finally {
      await controller?.close();
      await backend.stop();
      const pool = new Pool({
        connectionString: process.env.LOCAL_TEST_DATABASE_URL,
      });
      try {
        for (const table of [
          'memory_jobs',
          'local_ai_runs',
          'local_ai_threads',
        ])
          await pool.query(`DELETE FROM ${table} WHERE owner_id=$1`, [ownerId]);
      } finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  30000,
);
