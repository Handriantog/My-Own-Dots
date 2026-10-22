import { randomUUID } from 'node:crypto';
import fs, {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { parseEnv } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createWorkspaceManifest,
  readWorkspaceManifest,
} from '../../src/shared/workspace-manifest.js';
import { StorageClient } from '../../src/server/storage/storage-client.js';
import { WorkspaceMoveService } from '../../src/server/storage/workspace-move.js';
import { RestoreService } from '../../src/server/storage/restore.js';
import {
  fileSeal,
  readSelection,
} from '../../src/server/storage/restore-journal.js';
import { ArchiveWorkerClient } from '../../src/desktop/host/archive-worker-client.js';
import { WorkspaceBackend } from '../../src/desktop/host/workspace-backend.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dots-move-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'source'),
    profile = join(root, 'profile');
  await mkdir(join(directory, 'files'), { recursive: true });
  await mkdir(profile);
  const ownerId = randomUUID(),
    id = randomUUID(),
    sqlitePath = join(directory, 'workspace.sqlite');
  await createWorkspaceManifest(directory, {
    version: 1,
    id,
    ownerId,
    storage: 'sqlite',
    schema: 4,
  });
  await writeFile(
    join(directory, '.env'),
    'DATABASE_PATH=workspace.sqlite\nLLM_PROVIDER=claude-code\n',
  );
  await writeFile(join(directory, 'files', 'Notes 日.txt'), 'Managed artifact');
  const storage = await StorageClient.open({ database: sqlitePath, ownerId });
  cleanup.push(() => storage.close());
  const dot = (await storage.repositories.workspace.dots())[0];
  await storage.repositories.workspace.computers.patch(dot.id, {
    enabled: true,
    files: true,
  });
  await storage.repositories.workspace.memory.create({
    scope: { kind: 'owner' },
    title: 'Keep',
    text: 'Persistent memory',
  });
  await writeFile(
    join(profile, 'workspace-location.json'),
    JSON.stringify({ directory }),
  );
  const service = new WorkspaceMoveService({
    profile,
    stopWorkspace: () => storage.close(),
  });
  const input = {
    source: { directory, sqlitePath },
    destination: join(root, 'moved'),
    signal: new AbortController().signal,
  };
  return {
    root,
    directory,
    profile,
    ownerId,
    id,
    dot,
    sqlitePath,
    storage,
    service,
    input,
  };
}
it('verifies and selects a separate workspace while preserving identity, artifacts and the original', async () => {
  const f = await fixture();
  const preview = await f.service.prepare(f.input);
  const original = await fileSeal(f.sqlitePath, f.input.signal);
  expect(preview).toMatchObject({
    workspaceId: f.id,
    counts: { memory_items: 1 },
  });
  expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
    f.directory,
  );
  await expect(
    new RestoreService({
      profile: f.profile,
      stopWorkspace: async () => {},
    }).activateRestore(preview.operationId, 'new', f.input.signal),
  ).rejects.toThrow(/move/i);
  await f.service.activate(preview.operationId, f.input.signal);
  expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
    f.input.destination,
  );
  expect(await readWorkspaceManifest(f.input.destination)).toMatchObject({
    id: f.id,
    storage: 'sqlite',
  });
  expect(
    await readFile(join(f.input.destination, 'files/Notes 日.txt'), 'utf8'),
  ).toBe('Managed artifact');
  expect(
    parseEnv(await readFile(join(f.input.destination, '.env'), 'utf8'))
      .LLM_PROVIDER,
  ).toBe('claude-code');
  expect(await fileSeal(f.sqlitePath, f.input.signal)).toBe(original);
  const moved = await StorageClient.open({
    database: join(f.input.destination, 'data/opendots.sqlite'),
    ownerId: f.ownerId,
  });
  cleanup.push(() => moved.close());
  expect(
    (await moved.repositories.workspace.memory.listOwner()).items,
  ).toHaveLength(1);
  expect(
    await moved.repositories.workspace.computers.permissions(f.dot.id),
  ).toMatchObject({ enabled: false });
});
it('rejects new source files after preview and retains the prior selection', async () => {
  const f = await fixture();
  const preview = await f.service.prepare(f.input);
  await writeFile(join(f.directory, 'files/new.txt'), 'New data');
  await expect(
    f.service.activate(preview.operationId, f.input.signal),
  ).rejects.toThrow(/source changed/);
  expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
    f.directory,
  );
});
it('does not attach the moved selection to a running retained original', async () => {
  const f = await fixture();
  let expectedToken = 'original-owner-token';
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        service: 'my-own-dots',
        protocol: 1,
        workspaceId: f.id,
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const port = (server.address() as { port: number }).port;
  const sourceConfiguration =
    `PORT=${port}\nDATABASE_PATH=workspace.sqlite\n` +
    `export OWNER_TOKEN = '${expectedToken}'\n` +
    'LLM_PROVIDER=claude-code\nOPENAI_API_KEY="fixture # key with spaces"\n';
  await writeFile(join(f.directory, '.env'), sourceConfiguration);
  const preview = await f.service.prepare(f.input);
  await f.service.activate(preview.operationId, f.input.signal);
  const backend = new WorkspaceBackend({
    bundle: join(f.root, 'unused-bundle'),
    data: f.profile,
    environment: {},
  });
  cleanup.push(() => backend.stop());
  await expect(backend.start()).rejects.toThrow(/port is occupied/i);
  expect(backend.configuration?.workspace).toBe(f.input.destination);
  expect(await readFile(join(f.directory, '.env'), 'utf8')).toBe(
    sourceConfiguration,
  );
  const moved = parseEnv(
    await readFile(join(f.input.destination, '.env'), 'utf8'),
  );
  expect(moved.OWNER_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  expect(moved.OWNER_TOKEN).not.toBe(expectedToken);
  expect(moved.OPENAI_API_KEY).toBe('fixture # key with spaces');
  expect(moved.LLM_PROVIDER).toBe('claude-code');
  expect(moved.DATABASE_PATH).toBe('data/opendots.sqlite');
  // An authenticated instance of the selected copy can still be attached.
  expectedToken = moved.OWNER_TOKEN!;
  await expect(backend.start()).resolves.toMatchObject({ owned: false });
});
it('retains portable content but revokes machine access when its host binding changes', async () => {
  const f = await fixture();
  await f.storage.close();
  let client = await StorageClient.open({
    database: f.sqlitePath,
    ownerId: f.ownerId,
    machineId: 'host-one',
  });
  await client.repositories.workspace.computers.patch(f.dot.id, {
    enabled: true,
    files: true,
  });
  await client.close();
  client = await StorageClient.open({
    database: f.sqlitePath,
    ownerId: f.ownerId,
    machineId: 'host-one',
  });
  expect(
    await client.repositories.workspace.computers.permissions(f.dot.id),
  ).toMatchObject({ enabled: true });
  await client.close();
  client = await StorageClient.open({
    database: f.sqlitePath,
    ownerId: f.ownerId,
    machineId: 'host-two',
  });
  cleanup.push(() => client.close());
  expect(
    await client.repositories.workspace.computers.permissions(f.dot.id),
  ).toMatchObject({ enabled: false });
  expect(
    (await client.repositories.workspace.memory.listOwner()).items,
  ).toHaveLength(1);
  expect(await client.repositories.store.settings()).toMatchObject({
    paused: true,
  });
});
it('preserves existing destinations and cleans an owned incomplete copy after disk failure', async () => {
  const f = await fixture();
  await mkdir(f.input.destination);
  await writeFile(join(f.input.destination, 'sentinel'), 'keep');
  await expect(f.service.prepare(f.input)).rejects.toThrow();
  expect(await readFile(join(f.input.destination, 'sentinel'), 'utf8')).toBe(
    'keep',
  );
  const destination = join(f.root, 'full-disk');
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
    await expect(
      f.service.prepare({ ...f.input, destination }),
    ).rejects.toThrow('Simulated full disk');
  } finally {
    failure.mockRestore();
    syncBuiltinESMExports();
  }
  expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
    f.directory,
  );
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('moves through the isolated packaged worker', async () => {
  const f = await fixture();
  const { buildStorageWorker } = await import(
    pathToFileURL(join(process.cwd(), 'scripts/desktop-runtime.mjs')).href
  );
  const entry = join(f.root, 'runtime/archive-worker.cjs');
  await buildStorageWorker(process.cwd(), entry);
  const worker = new ArchiveWorkerClient({ entry });
  const options = {
    signal: f.input.signal,
    stopWorkspace: () => f.storage.close(),
  };
  const preview = await worker.run(
    {
      kind: 'move-preview',
      profile: f.profile,
      source: f.input.source,
      destination: f.input.destination,
    },
    options,
  );
  if (!('operationId' in preview)) throw new Error('Missing move preview');
  await worker.run(
    {
      kind: 'move-activate',
      profile: f.profile,
      operationId: preview.operationId,
    },
    options,
  );
  expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
    f.input.destination,
  );
  expect(await readWorkspaceManifest(f.input.destination)).toMatchObject({
    id: f.id,
  });
});
it.each(['staging', 'verified', 'switching', 'active'])(
  'recovers a move interrupted by SIGKILL at %s',
  async (crashAt) => {
    const f = await fixture();
    await f.storage.close();
    const original = await fileSeal(f.sqlitePath, f.input.signal);
    const child = fork(
      new URL('../fixtures/workspace-move-process.ts', import.meta.url),
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
      const boundary = new Promise<{ operationId: string; error?: string }>(
        (resolve, reject) => {
          child.once('message', (value) =>
            resolve(value as { operationId: string }),
          );
          child.once('exit', () =>
            reject(
              new Error(diagnostics || 'Move child exited before boundary'),
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
      const result = await boundary;
      expect(result.error).toBeUndefined();
      child.kill('SIGKILL');
      await exit;
      await new RestoreService({
        profile: f.profile,
        stopWorkspace: async () => {},
      }).recover();
      expect(JSON.parse((await readSelection(f.profile))!).directory).toBe(
        crashAt === 'active' ? f.input.destination : f.directory,
      );
      if (crashAt === 'switching')
        await f.service.activate(result.operationId, f.input.signal);
      if (crashAt === 'staging' || crashAt === 'verified')
        await expect(stat(f.input.destination)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      expect(await fileSeal(f.sqlitePath, f.input.signal)).toBe(original);
    } finally {
      child.kill('SIGKILL');
      await exit;
    }
  },
  10000,
);
