import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SnapshotOperations } from '../../src/server/storage/snapshot-routes.js';
import { MaintenanceGate } from '../../src/server/storage/maintenance.js';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { Runner } from '../../src/server/runner.js';
import type { ArchiveManifest } from '../../src/shared/storage-archive.js';

it('authenticates snapshot controls, rejects paths, and cancels while capture holds admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dot-snapshot-api-'));
  const gate = new MaintenanceGate();
  const store = new Store(':memory:');
  const config = {
    mode: 'sample' as const,
    baseUrl: 'https://example.invalid',
  };
  let path = '';
  const capture = vi.fn(async (directory: string, signal: AbortSignal) => {
    path = directory;
    const lease = await gate.acquire({ origin: 'manual', signal });
    try {
      await mkdir(directory);
      lease.signal.throwIfAborted();
      await new Promise<void>((_, reject) => {
        lease.signal.addEventListener(
          'abort',
          () => reject(lease.signal.reason),
          { once: true },
        );
      });
      throw new Error('Unreachable');
    } finally {
      await rm(directory, { recursive: true, force: true });
      lease.release();
    }
  });
  const snapshots = new SnapshotOperations({ capture }, root);
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    ownerToken: 'owner-secret',
    maintenance: gate,
    snapshots,
  });
  const request = (path: string, body: unknown = {}, token = 'owner-secret') =>
    app.request('/api/storage/snapshots' + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  try {
    expect((await request('', {}, 'wrong')).status).toBe(401);
    expect((await request('', { directory: '/arbitrary' })).status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
    const started = await request('');
    expect(started.status).toBe(202);
    const operation = (await started.json()) as { id: string };
    await vi.waitFor(() => expect(gate.status().held).toBe(true));
    const status = await app.request(`/api/storage/snapshots/${operation.id}`, {
      headers: { authorization: 'Bearer owner-secret' },
    });
    expect(status.status).toBe(200);
    expect((await request(`/${operation.id}/cancel`)).status).toBe(200);
    expect(gate.status().held).toBe(false);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await request(`/${operation.id}/release`)).status).toBe(200);
    expect(
      (
        await app.request(`/api/storage/snapshots/${operation.id}`, {
          headers: { authorization: 'Bearer owner-secret' },
        })
      ).status,
    ).toBe(404);
  } finally {
    await snapshots.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('retains ready captures until release and rejects overlapping operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dot-snapshot-api-'));
  const manifest: ArchiveManifest = {
    version: 1,
    minimumReader: 1,
    kind: 'workspace-backup',
    archiveId: 'archive',
    workspaceId: 'workspace',
    ownerId: 'owner',
    createdAt: new Date().toISOString(),
    entries: [],
    coverage: [],
  };
  const snapshots = new SnapshotOperations(
    {
      async capture(directory) {
        await mkdir(directory);
        return manifest;
      },
    },
    root,
  );
  try {
    const operation = await snapshots.create('manual');
    await vi.waitFor(() =>
      expect(snapshots.status(operation.id)?.phase).toBe('ready'),
    );
    await expect(snapshots.create('manual')).rejects.toThrow(/active/i);
    const ready = snapshots.status(operation.id)!;
    expect(ready.manifest).toEqual(manifest);
    expect((await stat(ready.directory!)).isDirectory()).toBe(true);
    await snapshots.release(operation.id);
    await expect(stat(ready.directory!)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await snapshots.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('authenticates idle revision status without admitting itself as a writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dot-status-api-'));
  const gate = new MaintenanceGate();
  const store = new Store(':memory:');
  const config = {
    mode: 'sample' as const,
    baseUrl: 'https://example.invalid',
  };
  const snapshots = new SnapshotOperations(
    {
      capture: async () => {
        throw new Error('Unexpected capture');
      },
      activity: async () => ({
        idle: !gate.status().held && gate.status().activeWrites === 0,
        revision: 'revision-1',
      }),
    },
    root,
  );
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    ownerToken: 'secret',
    maintenance: gate,
    snapshots,
  });
  const request = (token = 'secret') =>
    app.request('/api/storage/status', {
      headers: { authorization: `Bearer ${token}` },
    });
  try {
    expect((await request('wrong')).status).toBe(401);
    expect(await (await request()).json()).toEqual({
      idle: true,
      revision: 'revision-1',
    });
    const release = await gate.enterWrite(new AbortController().signal);
    try {
      expect(await (await request()).json()).toMatchObject({ idle: false });
    } finally {
      release();
    }
  } finally {
    await snapshots.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
