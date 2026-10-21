import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(ownerToken?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dots-folder-route-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'approved-folder');
  await mkdir(folder);
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    workspace.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'http://localhost' };
  const platform = await Platform.create(store, workspace, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  const dot = workspace.dots()[0];
  const thread = workspace.bindThread(randomUUID(), dot.id, 'Folder approval');
  const request = workspace.folders.request(dot.id, thread.id, {
    reason: 'Read the project',
    folderHint: 'Project folder',
    access: 'readwrite',
  });
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken,
  });
  return {
    app,
    workspace,
    folder,
    dot,
    thread,
    request,
    path: `/api/conversations/${thread.id}/folder-requests/${request.id}`,
  };
}
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

it('serves owner review, selection, decision replay and revocation through the real app', async () => {
  const f = await fixture();
  const pending = await f.app.request(f.path);
  expect(pending.status).toBe(200);
  expect(await pending.json()).toMatchObject({
    request: { status: 'pending', reason: 'Read the project' },
  });
  const selectionResponse = await f.app.request(
    `${f.path}/selection`,
    json({ path: f.folder }),
  );
  expect(selectionResponse.status).toBe(200);
  const selection = await selectionResponse.json();
  const decision = {
    toolCallId: 'review-tool',
    approve: true,
    selectionId: selection.id,
    access: 'read',
  };
  const approved = await f.app.request(`${f.path}/decision`, json(decision));
  expect(approved.status).toBe(200);
  const receipt = await approved.json();
  expect(receipt).toMatchObject({
    approved: true,
    name: 'approved-folder',
    access: 'read',
  });
  expect(receipt).not.toHaveProperty('path');
  expect(
    await (await f.app.request(`${f.path}/decision`, json(decision))).json(),
  ).toEqual(receipt);
  expect(
    (
      await f.app.request(
        `${f.path}/decision`,
        json({ ...decision, toolCallId: 'other' }),
      )
    ).status,
  ).toBe(409);
  const grantsUrl = `/api/dots/${f.dot.id}/folder-grants`;
  expect(await (await f.app.request(grantsUrl)).json()).toEqual([
    expect.objectContaining({
      id: receipt.grantId,
      path: selection.path,
      access: 'read',
    }),
  ]);
  expect(
    (await f.app.request(`${grantsUrl}/${receipt.grantId}`, json({}, 'DELETE')))
      .status,
  ).toBe(200);
  expect(await (await f.app.request(grantsUrl)).json()).toEqual([]);
  expect(await (await f.app.request(f.path)).json()).toMatchObject({
    request: { status: 'approved' },
    decision: { approved: false },
    grant: { revokedAt: expect.any(Number) },
  });
});

it('requires owner authorization and rejects hostile browser origins or non-loopback hosts', async () => {
  const f = await fixture('owner-secret');
  const paths = [f.path, `/api/dots/${f.dot.id}/folder-grants`];
  for (const path of paths) {
    expect((await f.app.request(path)).status).toBe(401);
    expect(
      (
        await f.app.request(path, {
          headers: { Authorization: 'Bearer owner-secret' },
        })
      ).status,
    ).toBe(200);
  }
  expect(
    (
      await f.app.request(`${f.path}/selection`, {
        ...json({ path: f.folder }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer owner-secret',
          Origin: 'https://evil.example',
        },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.app.request(
        `${f.path}/decision`,
        json({ toolCallId: 't', approve: false }),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await f.app.request(`http://remote.example${f.path}`, {
        headers: { Authorization: 'Bearer owner-secret' },
      })
    ).status,
  ).toBe(403);
  const local = await fixture();
  expect(
    (
      await local.app.request(local.path, undefined, {
        incoming: { socket: { remoteAddress: '192.0.2.5' } },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await local.app.request(local.path, undefined, {
        incoming: { socket: { remoteAddress: '::ffff:127.0.0.1' } },
      })
    ).status,
  ).toBe(200);
  expect(
    (await local.app.request(`http://evil.example${local.path}`)).status,
  ).toBe(403);
  expect(
    (
      await local.app.request(local.path, {
        headers: { 'sec-fetch-site': 'cross-site' },
      })
    ).status,
  ).toBe(403);
});

it('rejects invalid input, missing grants, foreign conversations and oversized selections', async () => {
  const f = await fixture();
  expect(
    (
      await f.app.request(
        `${f.path}/selection`,
        json({ path: f.folder, access: 'readwrite' }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.app.request(
        `${f.path}/decision`,
        json({
          toolCallId: 't',
          approve: true,
          path: f.folder,
          access: 'read',
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.app.request(
        `${f.path}/decision`,
        json({ toolCallId: 't', approve: true, access: 'read' }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.app.request(`${f.path}/selection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.app.request(
        `${f.path}/selection`,
        json({ path: 'x'.repeat(20000) }),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await f.app.request(
        `/api/dots/${f.dot.id}/folder-grants/${randomUUID()}`,
        json({}, 'DELETE'),
      )
    ).status,
  ).toBe(404);
  const other = f.workspace.bindThread(randomUUID(), f.dot.id, 'Other');
  expect(
    (
      await f.app.request(
        `/api/conversations/${other.id}/folder-requests/${f.request.id}`,
      )
    ).status,
  ).toBe(404);
  const missing = `/api/conversations/${f.thread.id}/folder-requests/${randomUUID()}`;
  expect((await f.app.request(missing)).status).toBe(404);
  expect((await f.app.request('/api/dots/missing/folder-grants')).status).toBe(
    404,
  );
});

it('resolves only the stored hint on explicit owner POST and keeps detail GET read-only', async () => {
  const f = await fixture('owner-secret');
  const request = f.workspace.folders.request(f.dot.id, f.thread.id, {
    reason: 'Read this folder',
    folderHint: f.folder,
    access: 'read',
  });
  const path = `/api/conversations/${f.thread.id}/folder-requests/${request.id}`;
  const owner = { Authorization: 'Bearer owner-secret' };
  expect(
    await (await f.app.request(path, { headers: owner })).json(),
  ).not.toHaveProperty('selection');
  expect((await f.app.request(`${path}/resolve`, json({}))).status).toBe(401);
  const post = (body: unknown, extra: Record<string, string> = {}) =>
    f.app.request(`${path}/resolve`, {
      ...json(body),
      headers: { ...json(body).headers, ...owner, ...extra },
    });
  expect((await post({ path: f.folder })).status).toBe(400);
  expect((await post({}, { Origin: 'https://evil.example' })).status).toBe(403);
  expect(
    (
      await f.app.request(`http://remote.example${path}/resolve`, {
        ...json({}),
        headers: { ...json({}).headers, ...owner },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.app.request(
        `${path}/resolve`,
        { ...json({}), headers: { ...json({}).headers, ...owner } },
        { incoming: { socket: { remoteAddress: '192.0.2.5' } } },
      )
    ).status,
  ).toBe(403);
  const resolved = await post({});
  expect(resolved.status).toBe(200);
  const detail = await resolved.json();
  expect(detail).toMatchObject({
    request: { status: 'pending' },
    selection: { name: 'approved-folder' },
  });
  expect(f.workspace.folders.list(f.dot.id)).toEqual([]);
  expect(await (await post({})).json()).toEqual(detail);
  const other = f.workspace.bindThread(randomUUID(), f.dot.id, 'Other');
  expect(
    (
      await f.app.request(
        `/api/conversations/${other.id}/folder-requests/${request.id}/resolve`,
        { ...json({}), headers: { ...json({}).headers, ...owner } },
      )
    ).status,
  ).toBe(404);
});
