import { afterEach, expect, it, vi } from 'vitest';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { PostgresConversations } from '../src/server/local-conversations.js';
const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.restoreAllMocks();
});
function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, {
    conversationBackend: 'local',
    localDatabaseUrl: 'postgresql://127.0.0.1:1/unused',
    llmBackend: 'subscription',
    llmProvider: 'codex',
    baseUrl: '',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  });
  closers.push(
    () => platform.stop(),
    () => store.close(),
    () => workspace.close(),
  );
  return { platform, workspace };
}
it('discovers SSE and thread inspection with no hosted Intelligence or model API key', async () => {
  const { platform } = fixture();
  const response = await platform.handle(
    new Request('http://localhost/api/copilotkit/info'),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    mode: 'sse',
    threadEndpoints: { list: true, inspect: true, realtimeMetadata: false },
  });
  expect(platform.intelligence).toBeUndefined();
});
it('creates conversations in local storage and preserves workspace bindings', async () => {
  const create = vi
    .spyOn(PostgresConversations.prototype, 'createThread')
    .mockResolvedValue({} as never);
  const { platform, workspace } = fixture();
  const dot = workspace.dots()[0];
  const thread = await platform.createConversation(dot.id, 'Local note');
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: thread.id,
      userId: 'owner',
      agentId: dot.id,
      name: 'Local note',
    }),
  );
  expect(workspace.requireThread(thread.id).dotId).toBe(dot.id);
});
it('only lists threads bound to this workspace and rejects unbound inspection', async () => {
  const list = vi
    .spyOn(PostgresConversations.prototype, 'listThreads')
    .mockResolvedValue([
      { id: 'visible', agentId: 'x' },
      { id: 'foreign', agentId: 'x' },
    ] as never);
  const { platform, workspace } = fixture();
  workspace.bindThread('visible', workspace.dots()[0].id, 'Bound');
  const response = await platform.handle(
    new Request('http://localhost/api/copilotkit/threads'),
  );
  expect(await response.json()).toMatchObject({
    threads: [{ id: 'visible' }],
    nextCursor: null,
  });
  expect(list).toHaveBeenCalled();
  expect(
    (
      await platform.handle(
        new Request('http://localhost/api/copilotkit/threads/foreign/messages'),
      )
    ).status,
  ).toBe(403);
});
