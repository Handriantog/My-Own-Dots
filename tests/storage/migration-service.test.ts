import fs, {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { storageWorkspace } from '../fixtures/storage-workspace.js';
import {
  createWorkspaceManifest,
  readWorkspaceManifest,
} from '../../src/shared/workspace-manifest.js';
import { MigrationService } from '../../src/server/storage/migration-service.js';
import { RestoreService } from '../../src/server/storage/restore.js';
import {
  fileSeal,
  readSelection,
} from '../../src/server/storage/restore-journal.js';
import { claimWorkspaceDatabase } from '../../src/server/workspace-identity.js';
import { ArchiveWorkerClient } from '../../src/desktop/host/archive-worker-client.js';
import { pathToFileURL } from 'node:url';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await storageWorkspace();
  cleanup.push(f.dispose);
  await createWorkspaceManifest(f.root, {
    version: 1,
    id: f.workspaceId,
    ownerId: f.ownerId,
    storage: 'legacy-postgres',
    schema: 1,
  });
  await writeFile(
    f.configurationPath,
    `OWNER_ID=${f.ownerId}\nLOCAL_DATABASE_URL=${f.postgresUrl}\nLLM_PROVIDER=claude-code\nSUBSCRIPTION_MODEL=fixture-model\n`,
  );
  const profile = await mkdtemp(join(tmpdir(), 'dots-migration-service-'));
  cleanup.push(() => rm(profile, { recursive: true, force: true }));
  await writeFile(
    join(profile, 'workspace-location.json'),
    JSON.stringify({ directory: f.root }),
  );
  const stopWorkspace = vi.fn(f.disconnect);
  const service = new MigrationService({ profile, stopWorkspace });
  const source = {
    directory: f.root,
    sqlitePath: f.sqlitePath,
    configurationPath: f.configurationPath,
    postgresUrl: f.postgresUrl,
    ownerId: f.ownerId,
    workspaceId: f.workspaceId,
  };
  const input = {
    source,
    destination: join(profile, 'unified'),
    backupDestination: join(profile, 'before-migration.dotsbackup'),
    passphrase: 'fixture migration password',
    signal: new AbortController().signal,
  };
  return { ...f, profile, service, input, stopWorkspace };
}
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'migrates through the isolated packaged worker with native quiesce acknowledgments',
  async () => {
    const f = await fixture();
    const { buildStorageWorker } = await import(
      pathToFileURL(join(process.cwd(), 'scripts/desktop-runtime.mjs')).href
    );
    const entry = join(f.profile, 'runtime/archive-worker.cjs');
    await buildStorageWorker(process.cwd(), entry);
    const worker = new ArchiveWorkerClient({ entry });
    const options = { signal: f.input.signal, stopWorkspace: f.stopWorkspace };
    const preview = await worker.run(
      { kind: 'migration-preview', profile: f.profile, ...f.input },
      options,
    );
    expect(preview).toMatchObject({
      counts: { local_ai_threads: 1 },
      workspaceId: f.workspaceId,
    });
    expect(f.stopWorkspace).toHaveBeenCalledTimes(1);
    if (!('operationId' in preview))
      throw new Error('Missing migration preview');
    await worker.run(
      {
        kind: 'migration-activate',
        profile: f.profile,
        operationId: preview.operationId,
      },
      options,
    );
    expect(f.stopWorkspace).toHaveBeenCalledTimes(2);
    expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
      f.input.destination,
    );
    expect(await readWorkspaceManifest(f.input.destination)).toMatchObject({
      storage: 'sqlite',
    });
  },
  15000,
);
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'requires a verified backup and activates the complete staged SQLite workspace',
  async () => {
    const f = await fixture();
    const preview = await f.service.prepare(f.input);
    const sourceSeal = await fileSeal(f.sqlitePath, f.input.signal);
    expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
      f.root,
    );
    expect(preview.counts).toMatchObject({
      local_ai_threads: 1,
      local_ai_runs: 1,
    });
    expect(preview.workspaceId).toBe(f.workspaceId);
    await expect(
      new RestoreService({
        profile: f.profile,
        stopWorkspace: f.stopWorkspace,
      }).activateRestore(preview.operationId, 'new', f.input.signal),
    ).rejects.toThrow(/migration/i);
    await f.service.activate(preview.operationId, f.input.signal);
    expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
      f.input.destination,
    );
    expect(await readWorkspaceManifest(f.input.destination)).toMatchObject({
      id: f.workspaceId,
      storage: 'sqlite',
      ownerId: f.ownerId,
    });
    expect(await readFile(join(f.input.destination, '.env'), 'utf8')).toContain(
      "LLM_PROVIDER='claude-code'",
    );
    expect(await fileSeal(f.sqlitePath, f.input.signal)).toBe(sourceSeal);
    expect(await readWorkspaceManifest(f.root)).toMatchObject({
      storage: 'legacy-postgres',
    });
  },
  15000,
);
it
  .skipIf(!process.env.LOCAL_TEST_DATABASE_URL)
  .each(['sqlite', 'postgres'] as const)(
  'refuses activation if the %s source changes after preview',
  async (change) => {
    const f = await fixture();
    const preview = await f.service.prepare(f.input);
    if (change === 'sqlite') {
      const db = new DatabaseSync(f.sqlitePath);
      try {
        db.prepare('UPDATE memories SET text=?').run(
          'New memory since preview',
        );
      } finally {
        db.close();
      }
    } else {
      const pg = new Pool({ connectionString: f.postgresUrl });
      try {
        await pg.query(
          'UPDATE local_ai_threads SET name=$1 WHERE owner_id=$2 AND id=$3',
          ['New name since preview', f.ownerId, f.thread],
        );
      } finally {
        await pg.end();
      }
    }
    await expect(
      f.service.activate(preview.operationId, f.input.signal),
    ).rejects.toThrow(/source changed/);
    expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
      f.root,
    );
  },
  15000,
);
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'preserves the source and selection when conversion runs out of disk space',
  async () => {
    const f = await fixture();
    const copy = fs.copyFile;
    const failure = vi
      .spyOn(fs, 'copyFile')
      .mockImplementation(async (...args) => {
        if (String(args[1]).endsWith('data/opendots.sqlite'))
          throw Object.assign(new Error('Simulated full disk'), {
            code: 'ENOSPC',
          });
        return copy(...args);
      });
    syncBuiltinESMExports();
    try {
      await expect(f.service.prepare(f.input)).rejects.toThrow(
        'Simulated full disk',
      );
      expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
        f.root,
      );
      expect((await stat(f.input.backupDestination)).size).toBeGreaterThan(0);
      await expect(stat(f.input.destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readWorkspaceManifest(f.root)).toMatchObject({
        storage: 'legacy-postgres',
      });
    } finally {
      failure.mockRestore();
      syncBuiltinESMExports();
    }
  },
  15000,
);
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'does not replace an occupied destination or initialize a missing source',
  async () => {
    const f = await fixture();
    await mkdir(f.input.destination);
    await writeFile(join(f.input.destination, 'sentinel'), 'keep');
    await expect(f.service.prepare(f.input)).rejects.toThrow();
    expect(await readFile(join(f.input.destination, 'sentinel'), 'utf8')).toBe(
      'keep',
    );
    await expect(
      f.service.prepare({
        ...f.input,
        source: {
          ...f.input.source,
          sqlitePath: join(f.root, 'missing.sqlite'),
        },
      }),
    ).rejects.toThrow();
    await expect(stat(join(f.root, 'missing.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
      f.root,
    );
  },
  15000,
);
it
  .skipIf(!process.env.LOCAL_TEST_DATABASE_URL)
  .each(['staging', 'verified', 'switching', 'active'])(
  'recovers safely after SIGKILL during migration at %s',
  async (crashAt) => {
    const f = await fixture();
    await f.disconnect();
    const seal = await fileSeal(f.sqlitePath, f.input.signal);
    const child = fork(
      new URL('../fixtures/migration-process.ts', import.meta.url),
      [],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    let diagnostics = '';
    child.stderr?.on('data', (value) => {
      diagnostics += value;
    });
    const exit = once(child, 'exit');
    try {
      const message = new Promise<{ operationId: string; error?: string }>(
        (resolve, reject) => {
          child.once('message', (value) =>
            resolve(value as { operationId: string }),
          );
          child.once('exit', () =>
            reject(
              new Error(
                diagnostics || 'Migration child exited before boundary',
              ),
            ),
          );
          child.once('error', reject);
        },
      );
      child.send({
        ...f.input,
        signal: undefined,
        profile: f.profile,
        crashAt,
      });
      const result = await message;
      expect(result.error).toBeUndefined();
      child.kill('SIGKILL');
      await exit;
      await new RestoreService({
        profile: f.profile,
        stopWorkspace: async () => {},
      }).recover();
      expect(
        (await readdir(f.profile)).filter((name) =>
          name.startsWith('.migration-'),
        ),
      ).toEqual([]);
      expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
        crashAt === 'active' ? f.input.destination : f.root,
      );
      if (crashAt === 'switching') {
        await f.service.activate(result.operationId, f.input.signal);
        expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
          f.input.destination,
        );
      }
      if (crashAt === 'staging' || crashAt === 'verified')
        await expect(stat(f.input.destination)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      expect(await fileSeal(f.sqlitePath, f.input.signal)).toBe(seal);
      expect((await stat(f.input.backupDestination)).size).toBeGreaterThan(0);
      const release = claimWorkspaceDatabase(f.sqlitePath);
      release();
    } finally {
      child.kill('SIGKILL');
      await exit;
    }
  },
  20000,
);
it
  .skipIf(!process.env.LOCAL_TEST_DATABASE_URL)
  .each(['backup', 'configuration'] as const)(
  'refuses activation after the %s changes',
  async (change) => {
    const f = await fixture();
    const preview = await f.service.prepare(f.input);
    await writeFile(
      change === 'backup' ? f.input.backupDestination : f.configurationPath,
      'changed',
    );
    await expect(
      f.service.activate(preview.operationId, f.input.signal),
    ).rejects.toThrow(/changed|backup|configuration/i);
    expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
      f.root,
    );
  },
  15000,
);
