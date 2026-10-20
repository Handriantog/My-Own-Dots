import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Runner } from '../src/server/runner.js';
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'authenticates memory controls, enforces revisions/scopes and forwards legacy local memory',
  async () => {
    const owner = randomUUID(),
      store = new Store(':memory:'),
      ws = new WorkspaceStore(':memory:', owner);
    const legacy = store.saveMemory('Existing preference');
    const platform = await Platform.create(store, ws, {
      conversationBackend: 'local',
      localDatabaseUrl: process.env.LOCAL_TEST_DATABASE_URL,
      llmBackend: 'subscription',
      llmProvider: 'codex',
      baseUrl: '',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    });
    const config = { mode: 'sample' as const, baseUrl: '' };
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      platform,
      ownerToken: 'owner',
    });
    const request = (path: string, method = 'GET', body?: unknown) =>
      app.request('/api' + path, {
        method,
        headers: {
          authorization: 'Bearer owner',
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const dot = ws.dots()[0];
    try {
      await platform.localConversations!.initialize();
      expect((await app.request('/api/memory-items')).status).toBe(401);
      expect(
        (
          await app.request('/api/memory-items', {
            headers: {
              authorization: 'Bearer owner',
              origin: 'https://evil.test',
            },
          })
        ).status,
      ).toBe(403);
      const list = await request('/memory-items');
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({
        items: [{ id: legacy.id, text: legacy.text }],
      });
      expect(
        (
          await request('/memory-items', 'POST', {
            scope: { kind: 'dot', id: 'missing' },
            title: 'x',
            text: 'x',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request('/memory-items', 'POST', {
            scope: { kind: 'owner' },
            title: 'x',
            text: 'x',
            sources: [],
          })
        ).status,
      ).toBe(400);
      const created = await request('/memory-items', 'POST', {
        scope: { kind: 'dot', id: dot.id },
        title: 'Preference',
        text: 'I prefer short answers.',
      });
      expect(created.status).toBe(201);
      const item = await created.json();
      expect(
        (
          await request('/memory-items/' + item.id, 'PATCH', {
            expectedRevision: 99,
            patch: { text: 'Changed' },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await request('/memory-items/' + item.id, 'PATCH', {
            expectedRevision: 1,
            patch: { scope: { kind: 'owner' } },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request('/memory-items/' + item.id, 'PATCH', {
            expectedRevision: 1,
            patch: { pinned: true },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request('/memories/' + legacy.id, 'PUT', {
            text: 'Updated legacy',
          })
        ).status,
      ).toBe(200);
      expect(ws.memory.get(legacy.id)?.text).toBe('Updated legacy');
      expect(store.memories()[0].text).toBe('Existing preference');
      expect(await (await request('/state')).json()).toMatchObject({
        memories: expect.arrayContaining([
          expect.objectContaining({ id: legacy.id, text: 'Updated legacy' }),
        ]),
      });
      const settings = await (
        await request(`/dots/${dot.id}/memory-settings`)
      ).json();
      expect(
        (
          await request(`/dots/${dot.id}/memory-settings`, 'PUT', {
            expectedRevision: settings.revision,
            patch: { learningEnabled: true },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(`/dots/${dot.id}/memory-settings`, 'PUT', {
            expectedRevision: settings.revision,
            patch: { autoDream: false },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(`/dots/${dot.id}/dream`, 'POST', {
            selectedThreadIds: ['foreign'],
          })
        ).status,
      ).toBe(404);
      const dream = await request(`/dots/${dot.id}/dream`, 'POST', {});
      expect(dream.status).toBe(202);
      const job = await dream.json();
      expect(
        (await (await request(`/dots/${dot.id}/dream`, 'POST', {})).json()).id,
      ).toBe(job.id);
      expect(
        (await request('/conversations/unbound/compact', 'POST', {})).status,
      ).toBe(404);
      store.updateSettings({ memoryAllowed: false });
      expect((await request(`/dots/${dot.id}/dream`, 'POST', {})).status).toBe(
        403,
      );
      expect(
        (
          await request(`/memory-items/${item.id}/forget`, 'POST', {
            expectedRevision: 2,
          })
        ).status,
      ).toBe(200);
      const receipt = ws.memory.history.receipts()[0];
      const preview = await (
        await request(
          `/memory-changes/${receipt.id}/restore-preview`,
          'POST',
          {},
        )
      ).json();
      expect(
        (
          await request('/memory-changes/wrong/restore', 'POST', {
            previewId: preview.id,
            expectedRevisions: preview.expectedRevisions,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(`/memory-changes/${receipt.id}/restore`, 'POST', {
            previewId: preview.id,
            expectedRevisions: {},
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(`/memory-changes/${receipt.id}/restore`, 'POST', {
            previewId: preview.id,
            expectedRevisions: preview.expectedRevisions,
          })
        ).status,
      ).toBe(200);
      expect((await request('/memory-items/%20')).status).toBe(400);
    } finally {
      await platform.memory!.pg.query(
        'DELETE FROM memory_jobs WHERE owner_id=$1',
        [owner],
      );
      await platform.stop();
      ws.close();
      store.close();
    }
  },
);
