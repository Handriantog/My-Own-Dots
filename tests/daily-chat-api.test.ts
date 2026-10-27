import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Platform } from '../src/server/platform.js';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { workspaceRoutes } from '../src/server/workspace-routes.js';
import { VoiceService } from '../src/server/voice.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'daily-chat-api-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const storage = await StorageClient.open({
    database: join(directory, 'test.sqlite'),
    ownerId: randomUUID(),
    engine: 'sqlite',
  });
  cleanup.push(() => storage.close());
  const { workspace, store, voiceDelegations: jobs } = storage.repositories;
  const platform = await Platform.create(
    store,
    workspace,
    {
      conversationBackend: 'local',
      storageEngine: 'sqlite',
      llmBackend: 'subscription',
      llmProvider: 'codex',
      agentEngine: 'codex',
      baseUrl: '',
      runtimeUrl: 'http://localhost',
      voiceName: 'marin',
      slackUsers: [],
      webSearchProvider: 'disabled',
    },
    { storage },
  );
  cleanup.push(() => platform.stop());
  const routes = workspaceRoutes(platform, new VoiceService(platform));
  const dot = (await workspace.dots())[0];
  const daily = (body: unknown = { dotId: dot.id }) =>
    routes.request('/conversations/daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { storage, workspace, jobs, platform, routes, dot, daily };
}

it('uses host local dates at entry, keeps custom titles and leaves the prior call in place across midnight', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 27, 23, 59));
  const response = await f.daily();
  expect(response.status).toBe(200);
  const first = await response.json();
  expect(first.title).toBe('2026-10-27');
  expect(
    (
      await f.platform.localConversations!.getThreadMessages({
        threadId: first.id,
        userId: f.workspace.ownerId,
      })
    ).messages,
  ).toEqual([]);
  await f.workspace.updateConversation(first.id, { title: 'My custom day' });
  expect(await (await f.daily()).json()).toMatchObject({
    id: first.id,
    title: 'My custom day',
  });
  const call = await f.workspace.createCall(first.id);
  vi.setSystemTime(new Date(2026, 9, 28, 0, 1));
  const tomorrow = await (await f.daily()).json();
  expect(tomorrow.title).toBe('2026-10-28');
  expect(tomorrow.id).not.toBe(first.id);
  expect((await f.workspace.call(call.id)).threadId).toBe(first.id);
  expect((await f.daily({ dotId: f.dot.id, date: '1900-01-01' })).status).toBe(
    400,
  );
});

it('classifies durable workers without removing direct chat targets or misclassifying ordinary titles', async () => {
  const f = await fixture();
  const parent = await f.platform.dailyConversation(f.dot.id);
  const ordinary = await f.platform.createConversation(
    f.dot.id,
    'Voice task: unrelated title',
  );
  const call = await f.workspace.createCall(parent.id);
  const lease = (await f.platform.localConversations!.acquireThread(
    parent.id,
  ))!;
  const messages = [
    { id: 'source', role: 'user' as const, content: 'Read my notes.' },
  ];
  await lease.beginRun({
    threadId: parent.id,
    runId: 'source-run',
    messages,
    tools: [],
    context: [],
    state: {},
  });
  await lease.finishRun(messages, {}, 'finished');
  await lease.release();
  await f.jobs.enqueue({
    id: 'job',
    callId: call.id,
    dotId: f.dot.id,
    parentThreadId: parent.id,
    workerThreadId: 'worker',
    utteranceId: 'source',
    sourceMessageId: 'source',
    sourceText: messages[0].content,
    request: messages[0].content,
  });
  await f.jobs.cancel('job');
  await f.workspace.updateConversation('worker', { title: 'Renamed task' });
  const state = await (await f.routes.request('/workspace')).json();
  expect(
    state.conversations.find((row: { id: string }) => row.id === 'worker'),
  ).toMatchObject({ kind: 'delegated-task', title: 'Renamed task' });
  expect(
    state.conversations.find((row: { id: string }) => row.id === ordinary.id)
      .kind,
  ).toBeUndefined();
  expect(await f.workspace.requireThread('worker', f.dot.id)).toMatchObject({
    id: 'worker',
  });
  expect(
    await (await f.routes.request('/conversations/worker/chat-target')).json(),
  ).toMatchObject({ threadId: parent.id });
});

it('retries a provider failure with the same reserved daily identity and rejects returned scope mismatches', async () => {
  const f = await fixture();
  const create = vi.spyOn(f.platform.localConversations!, 'getOrCreateThread');
  create.mockRejectedValueOnce(new Error('Temporary provider failure'));
  await expect(f.platform.dailyConversation(f.dot.id)).rejects.toThrow(
    'Temporary provider failure',
  );
  const reserved = (await f.workspace.conversations())[0];
  expect((await f.platform.dailyConversation(f.dot.id)).id).toBe(reserved.id);
  expect(await f.workspace.conversations()).toHaveLength(1);
  create.mockResolvedValueOnce({
    id: reserved.id,
    agentId: 'wrong-dot',
    createdById: f.workspace.ownerId,
  } as Awaited<
    ReturnType<
      NonNullable<typeof f.platform.localConversations>['getOrCreateThread']
    >
  >);
  await expect(f.platform.dailyConversation(f.dot.id)).rejects.toThrow(
    'scope denied',
  );
});
