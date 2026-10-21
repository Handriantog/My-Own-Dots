import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { folderRoutes } from '../src/server/folder-routes.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('returns persisted resolution detail through the worker and keeps asynchronous selection outside transactions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dots-folder-resolve-worker-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'Project');
  await mkdir(folder);
  const storage = await StorageClient.open({
    database: join(root, 'workspace.sqlite'),
    ownerId: 'owner',
  });
  cleanup.push(() => storage.close());
  const workspace = storage.repositories.workspace;
  const dot = (await workspace.dots())[0];
  const thread = await workspace.bindThread(randomUUID(), dot.id, 'Folder');
  const request = await workspace.folders.request(dot.id, thread.id, {
    folderHint: folder,
    reason: 'Read',
    access: 'read',
  });
  const app = new Hono().route('/api', folderRoutes(workspace.folders));
  const response = await app.request(
    `/api/conversations/${thread.id}/folder-requests/${request.id}/resolve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  expect(response.status).toBe(200);
  const detail = await response.json();
  expect(detail).toMatchObject({
    request: { status: 'pending' },
    selection: { name: 'Project' },
  });
  expect(await workspace.folders.getRequest(thread.id, request.id)).toEqual(
    detail,
  );
  expect(await workspace.folders.list(dot.id)).toEqual([]);
  expect(
    await workspace.folders.decide(thread.id, request.id, {
      toolCallId: 'review',
      approve: false,
    }),
  ).toMatchObject({ approved: false });
});
