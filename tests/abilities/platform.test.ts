import { afterEach, expect, it } from 'vitest';
import { Platform } from '../../src/server/platform.js';
import { Store } from '../../src/server/store.js';
import { WorkspaceStore } from '../../src/server/workspace.js';
import { Runner } from '../../src/server/runner.js';
import { createApp } from '../../src/server/app.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it('mounts Ability owner routes behind authentication and pairs only with a socket identity', async () => {
  const store = new Store(':memory:'),
    workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    workspace.close();
  });
  const token = 'owner-fixture-token-that-is-long-enough';
  const config = {
    mode: 'sample' as const,
    baseUrl: 'https://api.openai.com/v1',
  };
  const platform = await Platform.create(store, workspace, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: 'http://127.0.0.1:4310/api/copilotkit',
    conversationBackend: 'local',
    ownerToken: token,
    workspaceId: 'workspace-fixture',
  });
  cleanup.push(() => platform.stop());
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken: token,
  });
  const url = `/api/dots/${workspace.dots()[0].id}/abilities`;
  expect((await app.request(url)).status).toBe(401);
  const response = await app.request(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ bindings: [] });
  expect(
    (
      await app.request('/ability-host/v1/pair', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId: 'workspace-fixture',
          nonce: 'a'.repeat(64),
        }),
      })
    ).status,
  ).toBe(403);
});
