import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventType, type Message } from '@ag-ui/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import type { RunStatus } from '../src/server/local-conversations.js';
import { StorageClient } from '../src/server/storage/storage-client.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openApp(database: string) {
  const storage = await StorageClient.open({
    database,
    ownerId: 'owner',
    engine: 'sqlite',
  });
  cleanups.push(() => storage.close());
  const { store, workspace } = storage.repositories;
  const config = { mode: 'sample' as const, baseUrl: 'http://localhost' };
  const platform = await Platform.create(
    store,
    workspace,
    {
      baseUrl: config.baseUrl,
      voiceName: 'marin',
      slackUsers: [],
      runtimeUrl: '',
      conversationBackend: 'local',
    },
    { storage },
  );
  cleanups.push(() => platform.stop());
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken: 'owner-secret',
  });
  return { storage, workspace, platform, app };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dots-folder-approvals-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const database = join(root, 'workspace.sqlite');
  const { storage, workspace, platform, app } = await openApp(database);
  const conversations = platform.localConversations!;
  const dot = (await workspace.dots())[0];
  const threadId = randomUUID();
  await workspace.bindThread(threadId, dot.id, 'Folder approval');
  await conversations.createThread({
    threadId,
    agentId: dot.id,
    userId: workspace.ownerId,
  });
  const request = await workspace.folders.request(dot.id, threadId, {
    reason: 'Read the project',
    folderHint: 'Project folder',
    access: 'read',
  });
  const headers = { Authorization: 'Bearer owner-secret' };
  const feed = () => app.request('/api/folder-approvals', { headers });
  const save = async (
    messages: Message[],
    status: Exclude<RunStatus, 'running'> = 'finished',
    runId: string = randomUUID(),
  ) => {
    const lease = (await conversations.acquireThread(threadId))!;
    try {
      await lease.beginRun({
        threadId,
        runId,
        messages: [],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      });
      await lease.appendEvent({ type: EventType.MESSAGES_SNAPSHOT, messages });
      await lease.finishRun(messages, {}, status);
    } finally {
      await lease.release();
    }
  };
  const pending: Message = {
    id: 'assistant-review',
    role: 'assistant',
    toolCalls: [
      {
        id: 'folder-review',
        type: 'function',
        function: {
          name: 'review_local_folder_access',
          arguments: JSON.stringify({ requestId: request.id }),
        },
      },
    ],
  };
  const expected = {
    requestId: request.id,
    threadId,
    dotId: dot.id,
    dotName: dot.name,
    toolCallId: 'folder-review',
  };
  return {
    app,
    storage,
    workspace,
    platform,
    conversations,
    database,
    dot,
    threadId,
    request,
    headers,
    feed,
    save,
    pending,
    expected,
  };
}

it('discovers a durable pending folder tool through the async SQLite repository', async () => {
  const f = await fixture();
  await f.save([f.pending]);
  const response = await f.feed();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([f.expected]);
});

it('omits orphan requests and calls without an exact strict folder request match', async () => {
  const f = await fixture();
  expect((await f.feed()).status).toBe(200);
  expect(await (await f.feed()).json()).toEqual([]);
  for (const [name, args] of [
    ['another_tool', { requestId: f.request.id }],
    ['review_local_folder_access', { requestId: randomUUID() }],
    ['review_local_folder_access', { requestId: f.request.id, approve: true }],
    ['review_local_folder_access', { requestId: 'invalid' }],
  ] as const) {
    await f.save([
      {
        id: randomUUID(),
        role: 'assistant',
        toolCalls: [
          {
            id: 'folder-review',
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    ]);
    expect(await (await f.feed()).json()).toEqual([]);
  }
});

it('keeps a saved decision available for continuation until the tool result is durable', async () => {
  const f = await fixture();
  await f.save([f.pending]);
  await f.workspace.folders.decide(f.threadId, f.request.id, {
    toolCallId: 'folder-review',
    approve: false,
  });
  expect((await f.feed()).status).toBe(200);
  expect(await (await f.feed()).json()).toEqual([f.expected]);
  await f.save([
    f.pending,
    { id: 'answer', role: 'tool', toolCallId: 'folder-review', content: '{}' },
  ]);
  expect(await (await f.feed()).json()).toEqual([]);
});

it('omits a saved decision bound to another tool call', async () => {
  const f = await fixture();
  await f.save([f.pending]);
  await f.workspace.folders.decide(f.threadId, f.request.id, {
    toolCallId: 'different-review',
    approve: false,
  });
  expect((await f.feed()).status).toBe(200);
  expect(await (await f.feed()).json()).toEqual([]);
});

it.each(['stopped', 'interrupted', 'failed'] as const)(
  'omits approvals left behind by a %s run',
  async (status) => {
    const f = await fixture();
    await f.save([f.pending], status);
    expect((await f.feed()).status).toBe(200);
    expect(await (await f.feed()).json()).toEqual([]);
  },
);

it('keeps expired requests reviewable and declineable', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.database);
  try {
    db.prepare(
      "UPDATE folder_requests SET value=json_set(value, '$.request.expiresAt', 1)",
    ).run();
  } finally {
    db.close();
  }
  await f.save([f.pending]);
  expect((await f.feed()).status).toBe(200);
  expect(await (await f.feed()).json()).toEqual([f.expected]);
  await expect(
    f.workspace.folders.decide(f.threadId, f.request.id, {
      toolCallId: 'folder-review',
      approve: false,
    }),
  ).resolves.toMatchObject({ approved: false });
});

it('requires owner authentication, trusted origins and a real loopback peer', async () => {
  const f = await fixture();
  expect((await f.feed()).status).toBe(200);
  expect((await f.app.request('/api/folder-approvals')).status).toBe(401);
  expect(
    (
      await f.app.request('/api/folder-approvals', {
        headers: { Authorization: 'Bearer other-owner' },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.app.request('http://remote.example/api/folder-approvals', {
        headers: f.headers,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.app.request(
        '/api/folder-approvals',
        { headers: f.headers },
        {
          incoming: { socket: { remoteAddress: '192.0.2.5' } },
        },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.app.request('/api/folder-approvals', {
        headers: { ...f.headers, Origin: 'https://evil.example' },
      })
    ).status,
  ).toBe(403);
});

it.each(['owner', 'dot', 'missing-dot'] as const)(
  'ignores folder requests after their %s scope stops matching',
  async (scope) => {
    const f = await fixture();
    await f.save([f.pending]);
    const db = new DatabaseSync(f.database);
    try {
      if (scope === 'owner')
        db.prepare('UPDATE folder_requests SET ownerId=?').run('other-owner');
      else if (scope === 'dot') {
        const other = await f.workspace.createDot(
          f.dot.spaceId,
          'Other Dot',
          '',
          false,
          false,
        );
        db.prepare('UPDATE thread_bindings SET dotId=? WHERE id=?').run(
          other.id,
          f.threadId,
        );
      } else db.prepare('DELETE FROM dots WHERE id=?').run(f.dot.id);
    } finally {
      db.close();
    }
    expect((await f.feed()).status).toBe(200);
    expect(await (await f.feed()).json()).toEqual([]);
  },
);

it('reads only candidate conversations and shares each snapshot within a poll', async () => {
  const f = await fixture();
  const other = await f.workspace.folders.request(f.dot.id, f.threadId, {
    reason: 'Another folder',
    folderHint: '',
    access: 'read',
  });
  await f.save([
    f.pending,
    {
      id: 'other-assistant',
      role: 'assistant',
      toolCalls: [
        {
          id: 'other-tool',
          type: 'function',
          function: {
            name: 'review_local_folder_access',
            arguments: JSON.stringify({ requestId: other.id }),
          },
        },
      ],
    },
  ]);
  await f.conversations.createThread({
    threadId: 'unrelated',
    agentId: f.dot.id,
    userId: 'owner',
  });
  const snapshot = vi.spyOn(f.conversations, 'getSnapshot');
  const enumerate = vi.spyOn(f.conversations, 'listThreads');
  const response = await f.feed();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([
    { ...f.expected, requestId: other.id, toolCallId: 'other-tool' },
    f.expected,
  ]);
  expect(snapshot).toHaveBeenCalledExactlyOnceWith(f.threadId);
  expect(enumerate).not.toHaveBeenCalled();
});

it('returns an empty feed for a backend without local conversation snapshots', async () => {
  const f = await fixture();
  await f.save([f.pending]);
  f.platform.localConversations = undefined;
  const response = await f.feed();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
});

it('preserves finished pending approvals through a storage and conversation restart', async () => {
  const f = await fixture();
  await f.save([f.pending]);
  await f.platform.stop();
  await f.storage.close();
  const reopened = await openApp(f.database);
  await reopened.platform.localConversations!.initialize();
  const response = await reopened.app.request('/api/folder-approvals', {
    headers: f.headers,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([f.expected]);
});

it('does not offer an approval while its generating run still holds the conversation lease', async () => {
  const f = await fixture();
  const lease = (await f.conversations.acquireThread(f.threadId))!;
  try {
    await lease.beginRun({
      threadId: f.threadId,
      runId: randomUUID(),
      messages: [f.pending],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    });
    const response = await f.feed();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  } finally {
    await lease.release();
  }
});

it('finds an old pending approval behind more than 100 newer answered requests', async () => {
  const f = await fixture();
  const messages: Message[] = [f.pending];
  for (let i = 0; i < 105; i++) {
    const request = await f.workspace.folders.request(f.dot.id, f.threadId, {
      reason: 'Another request',
      folderHint: '',
      access: 'read',
    });
    await f.workspace.folders.decide(f.threadId, request.id, {
      approve: false,
      toolCallId: `answered-${i}`,
    });
    messages.push(
      {
        id: `review-${i}`,
        role: 'assistant',
        toolCalls: [
          {
            id: `answered-${i}`,
            type: 'function',
            function: {
              name: 'review_local_folder_access',
              arguments: JSON.stringify({ requestId: request.id }),
            },
          },
        ],
      },
      {
        id: `answer-${i}`,
        role: 'tool',
        toolCallId: `answered-${i}`,
        content: '{}',
      },
    );
  }
  await f.save(messages);
  const snapshot = vi.spyOn(f.conversations, 'getSnapshot');
  expect(await (await f.feed()).json()).toEqual([f.expected]);
  expect(snapshot).toHaveBeenCalledExactlyOnceWith(f.threadId);
});

it('ignores an owner binding with no matching canonical conversation', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.database);
  try {
    db.prepare('DELETE FROM conversation_threads WHERE id=?').run(f.threadId);
  } finally {
    db.close();
  }
  const response = await f.feed();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
});

it('bounds the feed to 100 verified pending approvals', async () => {
  const f = await fixture();
  const messages: Message[] = [f.pending];
  for (let i = 0; i < 105; i++) {
    const request = await f.workspace.folders.request(f.dot.id, f.threadId, {
      reason: 'Read a folder',
      folderHint: '',
      access: 'read',
    });
    messages.push({
      id: `review-${i}`,
      role: 'assistant',
      toolCalls: [
        {
          id: `tool-${i}`,
          type: 'function',
          function: {
            name: 'review_local_folder_access',
            arguments: JSON.stringify({ requestId: request.id }),
          },
        },
      ],
    });
  }
  await f.save(messages);
  const response = await f.feed();
  expect(response.status).toBe(200);
  const approvals = await response.json();
  expect(approvals).toHaveLength(100);
  expect(approvals[0].toolCallId).toBe('tool-104');
  expect(approvals[99].toolCallId).toBe('tool-5');
});

it('omits a cancelled voice task even though its approval run finished normally', async () => {
  const f = await fixture();
  const parentId = randomUUID();
  await f.workspace.bindThread(parentId, f.dot.id, 'Voice parent');
  await f.conversations.createThread({
    threadId: parentId,
    agentId: f.dot.id,
    userId: 'owner',
  });
  const parentLease = (await f.conversations.acquireThread(parentId))!;
  const source: Message = {
    id: 'source',
    role: 'user',
    content: 'Read the project folder',
  };
  try {
    await parentLease.beginRun({
      threadId: parentId,
      runId: randomUUID(),
      messages: [source],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    });
    await parentLease.finishRun([source], {}, 'finished');
  } finally {
    await parentLease.release();
  }
  const call = await f.workspace.createCall(parentId);
  const jobs = f.storage.repositories.voiceDelegations;
  await jobs.enqueue({
    id: 'task',
    dotId: f.dot.id,
    callId: call.id,
    parentThreadId: parentId,
    workerThreadId: f.threadId,
    utteranceId: 'utterance',
    sourceMessageId: source.id,
    sourceText: 'Read the project folder',
    request: 'Read the project folder',
  });
  const lease = (await jobs.claim('task', 'task-run', 30_000))!;
  await f.save([f.pending], 'finished', 'task-run');
  await jobs.settle(lease, { status: 'approval' });
  expect(await (await f.feed()).json()).toEqual([f.expected]);
  await jobs.cancel('task');
  expect((await f.conversations.getSnapshot(f.threadId)).lastRun?.status).toBe(
    'finished',
  );
  expect(await (await f.feed()).json()).toEqual([]);
});
