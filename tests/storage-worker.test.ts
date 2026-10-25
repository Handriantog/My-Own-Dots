import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { PageError } from '../src/server/pages.js';
import { FolderAccessError } from '../src/server/folder-access.js';
import { z } from 'zod';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(entry?: URL) {
  const root = await mkdtemp(join(tmpdir(), 'dots-repository-worker-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const database = join(root, 'workspace.sqlite');
  const client = await StorageClient.open({
    database,
    ownerId: 'worker-owner',
    entry,
  });
  cleanup.push(() => client.close());
  return { root, database, client };
}
it('resolves and binds execution scope through the worker without serializing an unfinished promise', async () => {
  const { client, root } = await fixture();
  const { workspace } = client.repositories;
  const dot = (await workspace.dots())[0];
  const thread = await workspace.bindThread('project', dot.id, 'Project');
  const request = await workspace.folders.request(dot.id, thread.id, {
    reason: 'Run fixture tests',
    folderHint: root,
    access: 'execute',
  });
  const selection = await workspace.folders.select(thread.id, request.id, root);
  const approved = await workspace.folders.decide(thread.id, request.id, {
    toolCallId: 'fixture',
    approve: true,
    selectionId: selection.id,
    access: 'execute',
  });
  expect(
    await workspace.folders.executionScope(dot.id, thread.id),
  ).toMatchObject({ path: await realpath(root), access: 'execute' });
  expect(
    await workspace.folders.bindExecution(dot.id, thread.id, approved.grantId!),
  ).toMatchObject({ grantId: approved.grantId });
  await workspace.folders.revoke(dot.id, approved.grantId!);
  await expect(
    workspace.folders.executionScope(dot.id, thread.id),
  ).rejects.toThrow(/revoked/);
});
it('persists typed repository operations through a worker and drains on close', async () => {
  const { client, database } = await fixture();
  const { workspace, store } = client.repositories;
  expect(workspace.ownerId).toBe('worker-owner');
  const space = await workspace.createSpace('Travel', 'Plans');
  const page = await workspace.pages.create(space.id, {
    title: 'Tokyo',
    content: 'April',
  });
  const task = await store.createTask('Plan the trip');
  const write = store.saveMemory('Train ticket', 'memory-fixed-id');
  await client.close();
  expect(client.signal.aborted).toBe(false);
  expect(await write).toMatchObject({
    id: 'memory-fixed-id',
    text: 'Train ticket',
  });
  await expect(store.settings()).rejects.toThrow(/closed/i);
  const reopened = await StorageClient.open({
    database,
    ownerId: 'worker-owner',
  });
  cleanup.push(() => reopened.close());
  expect(
    await reopened.repositories.workspace.pages.get(space.id, page.id),
  ).toMatchObject({ title: 'Tokyo', content: 'April' });
  expect(await reopened.repositories.store.task(task.id)).toMatchObject({
    prompt: 'Plan the trip',
  });
  expect(await reopened.repositories.store.memories()).toEqual([
    expect.objectContaining({ text: 'Train ticket' }),
  ]);
});
it('keeps the parent responsive during a database lock and cancels a queued write without mutation', async () => {
  const { client, database } = await fixture();
  const lock = new DatabaseSync(database);
  try {
    lock.exec('BEGIN IMMEDIATE');
    const abort = new AbortController();
    const write = client.call('store.createTask', ['never written'], {
      priority: 'background',
      signal: abort.signal,
    });
    const rejected = expect(write).rejects.toThrow(/cancel|abort/i);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(ticks).toBeGreaterThan(3);
      expect(await client.repositories.store.settings()).toMatchObject({
        paused: false,
      });
      abort.abort();
      await rejected;
    } finally {
      clearInterval(timer);
    }
    lock.exec('ROLLBACK');
    expect(await client.repositories.store.tasks()).toEqual([]);
  } finally {
    if (lock.isTransaction) lock.exec('ROLLBACK');
    lock.close();
  }
});
it('runs a foreground write before queued busy background batches', async () => {
  const { client, database } = await fixture();
  const lock = new DatabaseSync(database);
  const order: string[] = [];
  try {
    lock.exec('BEGIN IMMEDIATE');
    const background = Array.from({ length: 8 }, (_, index) =>
      client
        .call('store.createTask', ['background ' + index], {
          priority: 'background',
        })
        .then(() => order.push('background')),
    );
    await client.repositories.store.settings();
    const foreground = client
      .call('store.updateSettings', [{ name: 'Foreground' }])
      .then(() => order.push('foreground'));
    await client.repositories.store.settings();
    lock.exec('ROLLBACK');
    await Promise.all([...background, foreground]);
    expect(order[0]).toBe('foreground');
    expect(await client.repositories.store.settings()).toMatchObject({
      name: 'Foreground',
    });
    expect(await client.repositories.store.tasks()).toHaveLength(8);
  } finally {
    if (lock.isTransaction) lock.exec('ROLLBACK');
    lock.close();
  }
});
it('rejects unknown methods, callbacks and oversized payloads before they can mutate', async () => {
  const { client } = await fixture();
  // Deliberately exercise the untyped IPC boundary.
  const call = client.call.bind(client) as unknown as (
    method: string,
    args: unknown[],
  ) => Promise<unknown>;
  await expect(call('store.db.exec', ['DROP TABLE settings'])).rejects.toThrow(
    /method/i,
  );
  await expect(call('memory.atomic', [() => undefined])).rejects.toThrow(
    /method/i,
  );
  await expect(call('store.saveMemory', [() => undefined])).rejects.toThrow(
    /clone/i,
  );
  await expect(
    call('store.saveMemory', ['x'.repeat(16 * 1024 * 1024)]),
  ).rejects.toThrow(/limit|large/i);
  expect(await client.repositories.store.memories()).toEqual([]);
});
it('bounds outstanding requests while a writer is locked and drains cancelled work', async () => {
  const { client, database } = await fixture();
  const lock = new DatabaseSync(database);
  const abort = new AbortController();
  try {
    lock.exec('BEGIN IMMEDIATE');
    const pending = Array.from({ length: 1024 }, () =>
      client
        .call('store.createTask', ['queued'], { signal: abort.signal })
        .then(
          () => 'committed',
          (error) => (error as Error).message,
        ),
    );
    await expect(
      client.repositories.store.createTask('over capacity'),
    ).rejects.toThrow(/queue.*limit/i);
    abort.abort();
    lock.exec('ROLLBACK');
    expect(
      (await Promise.all(pending)).every((result) => /cancel/i.test(result)),
    ).toBe(true);
    expect(await client.repositories.store.tasks()).toEqual([]);
  } finally {
    if (lock.isTransaction) lock.exec('ROLLBACK');
    lock.close();
  }
});
it('acknowledges an in-flight cancellation only after its transaction rolls back', async () => {
  const { client, database } = await fixture(
    new URL('./fixtures/repository-worker-probe.ts', import.meta.url),
  );
  const abort = new AbortController();
  let settled = false;
  const write = client
    .call('store.saveMemory', ['must roll back'], { signal: abort.signal })
    .finally(() => {
      settled = true;
    });
  const rejected = expect(write).rejects.toThrow(/cancel|abort/i);
  await vi.waitFor(async () =>
    expect(await readFile(database + '.started', 'utf8')).toBe('started'),
  );
  abort.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  await writeFile(database + '.continue', 'continue');
  await rejected;
  expect(await client.repositories.store.memories()).toEqual([]);
});
it('rejects all outstanding requests when the storage worker dies', async () => {
  const { client, database } = await fixture(
    new URL('./fixtures/repository-worker-probe.ts', import.meta.url),
  );
  const lock = new DatabaseSync(database);
  try {
    lock.exec('BEGIN IMMEDIATE');
    const writes = [
      client.repositories.store.createTask('one'),
      client.repositories.store.createTask('two'),
    ];
    const rejected = writes.map((write) =>
      expect(write).rejects.toThrow(/worker.*(exit|stop)|closed/i),
    );
    await writeFile(database + '.crash', 'crash');
    await Promise.all(rejected);
    expect(client.signal.aborted).toBe(true);
    await expect(client.repositories.store.settings()).rejects.toThrow(
      /closed|worker/i,
    );
  } finally {
    lock.exec('ROLLBACK');
    lock.close();
  }
});
it('preserves repository errors used by HTTP status handling', async () => {
  const { client } = await fixture();
  await expect(
    client.repositories.workspace.pages.get('missing-space', 'missing-page'),
  ).rejects.toBeInstanceOf(PageError);
  await expect(
    client.repositories.workspace.folders.revoke(
      'missing-dot',
      'missing-grant',
    ),
  ).rejects.toBeInstanceOf(FolderAccessError);
  const dot = (await client.repositories.workspace.dots())[0];
  await expect(
    client.repositories.workspace.setVoiceSettings(dot.id, { invalid: true }),
  ).rejects.toBeInstanceOf(z.ZodError);
});

it('records a folder failure through storage RPC and HTTP, then recovers with managed Python under Finder PATH', async () => {
  const { folderRoutes } = await import('../src/server/folder-routes.js');
  const { folderPython } = await import('../src/server/folder-python.js');
  const { readdir } = await import('node:fs/promises');
  const python = folderPython();
  const root = await mkdtemp(join(tmpdir(), 'dots-folder-runtime-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  cleanup.push(async () => {
    vi.unstubAllEnvs();
  });
  vi.stubEnv('DOTS_ERROR_LOG_DIR', join(root, 'logs'));
  vi.stubEnv('DOTS_FOLDER_PYTHON', join(root, 'missing-python'));
  vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin');
  const options = {
    database: join(root, 'test.sqlite'),
    ownerId: 'runtime-test',
    engine: 'sqlite' as const,
  };
  const first = await StorageClient.open(options);
  cleanup.push(() => first.close());
  const { workspace } = first.repositories;
  const dot = (await workspace.dots())[0];
  const thread = await workspace.bindThread(
    'folder-runtime',
    dot.id,
    'Folder runtime',
  );
  const request = await workspace.folders.request(dot.id, thread.id, {
    reason: 'Fixture',
    folderHint: 'my own stack',
    access: 'read',
  });
  const route = `/conversations/${thread.id}/folder-requests/${request.id}/selection`;
  const choose = () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: root }),
  });
  const response = await folderRoutes(workspace.folders).request(
    route,
    choose(),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining('Python 3.12'),
  });
  const logs = join(root, 'logs');
  const rows = (await readFile(join(logs, (await readdir(logs))[0]), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(rows).toContainEqual(
    expect.objectContaining({
      event: 'folder_request_failed',
      context: expect.objectContaining({
        requestId: request.id,
        threadId: thread.id,
      }),
    }),
  );
  expect(rows).toContainEqual(
    expect.objectContaining({ event: 'folder_runtime_start_failed' }),
  );
  await first.close();
  vi.stubEnv('DOTS_FOLDER_PYTHON', python);
  const second = await StorageClient.open(options);
  cleanup.push(() => second.close());
  const selectedResponse = await folderRoutes(
    second.repositories.workspace.folders,
  ).request(route, choose());
  expect(selectedResponse.status).toBe(200);
  const selection = await selectedResponse.json();
  expect(selection.path).toBe(await realpath(root));
  await second.repositories.workspace.folders.decide(thread.id, request.id, {
    toolCallId: 'test',
    approve: true,
    selectionId: selection.id,
    access: 'read',
  });
  const grants = await second.repositories.workspace.folders.list(dot.id);
  expect(grants).toContainEqual(
    expect.objectContaining({ path: await realpath(root), access: 'read' }),
  );
});
