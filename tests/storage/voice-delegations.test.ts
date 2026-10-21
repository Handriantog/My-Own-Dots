import { randomUUID } from 'node:crypto';
import { EventType, type Message } from '@ag-ui/core';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { StorageClient } from '../../src/server/storage/storage-client.js';
import { SQLiteConversations } from '../../src/server/storage/sqlite-conversations.js';
import {
  copyValidatedSQLite,
  restoreSQLite,
} from '../../src/server/storage/restore-sqlite.js';
import {
  createWorkspaceManifest,
  readWorkspaceManifest,
  updateWorkspaceManifestSchema,
} from '../../src/shared/workspace-manifest.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(engine: 'sqlite' | 'legacy-postgres' = 'sqlite') {
  const root = await mkdtemp(join(tmpdir(), 'dots-voice-jobs-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ownerId = randomUUID();
  const database = join(root, 'workspace.sqlite');
  const storage = await StorageClient.open({ database, ownerId, engine });
  cleanups.push(() => storage.close());
  const { workspace } = storage.repositories;
  const dot = (await workspace.dots())[0];
  const conversations = new SQLiteConversations(storage);
  if (engine === 'sqlite') {
    await conversations.createThread({
      threadId: 'parent',
      agentId: dot.id,
      userId: ownerId,
    });
    await workspace.bindThread('parent', dot.id, 'Conversation');
    const lease = (await conversations.acquireThread('parent'))!;
    const messages = [
      {
        id: 'source',
        role: 'user' as const,
        content: 'Please research this topic.',
      },
    ];
    await lease.beginRun({
      threadId: 'parent',
      runId: 'source-run',
      messages,
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    });
    await lease.finishRun(messages, {}, 'finished');
    await lease.release();
  }
  const call =
    engine === 'sqlite' ? await workspace.createCall('parent') : undefined;
  const input = {
    id: 'job',
    dotId: dot.id,
    callId: call?.id ?? 'call',
    parentThreadId: 'parent',
    workerThreadId: 'worker',
    utteranceId: 'utterance',
    sourceMessageId: 'source',
    sourceText: 'Please research this topic.',
    request: 'Research this topic.',
  };
  return {
    root,
    database,
    ownerId,
    storage,
    workspace,
    conversations,
    input,
    jobs: storage.repositories.voiceDelegations,
  };
}

it('exposes a worker-owned repository with atomic job and same-Dot thread binding', async () => {
  const f = await fixture();
  expect(f.jobs).toBeDefined();
  const result = await f.jobs.enqueue(f.input);
  expect(result.kind).toBe('created');
  expect(result.job).toMatchObject({
    id: 'job',
    ownerId: f.ownerId,
    status: 'queued',
    parentThreadId: 'parent',
    workerThreadId: 'worker',
    receiptMessageId: null,
  });
  expect(
    await f.workspace.requireThread('worker', f.input.dotId),
  ).toMatchObject({ ownerId: f.ownerId });
  expect((await f.conversations.getSnapshot('worker')).messages).toEqual([]);
  expect(await f.jobs.forThread('worker')).toEqual(result.job);
  expect(await f.jobs.list({ callId: f.input.callId, active: true })).toEqual([
    result.job,
  ]);
});

it('deduplicates the same handoff and rejects changed request or scope', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  expect((await f.jobs.enqueue(f.input)).kind).toBe('existing');
  for (const change of [
    { request: 'Different work' },
    { sourceMessageId: 'changed' },
    { workerThreadId: 'other' },
  ])
    await expect(f.jobs.enqueue({ ...f.input, ...change })).rejects.toThrow(
      /mismatch|source/i,
    );
  expect(await f.jobs.list()).toHaveLength(1);
});

it('returns busy for another accepted task without creating a thread or job', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  expect(
    await f.jobs.enqueue({
      ...f.input,
      id: 'another',
      utteranceId: 'another',
      workerThreadId: 'another',
    }),
  ).toMatchObject({ kind: 'busy', job: { id: 'job' } });
  await expect(f.workspace.requireThread('another')).rejects.toThrow();
  expect(await f.jobs.get('another')).toBeNull();
});

async function awaitingFolder(
  f: Awaited<ReturnType<typeof fixture>>,
  otherApproval = false,
) {
  await f.jobs.enqueue(f.input);
  const request = await f.workspace.folders.request(f.input.dotId, 'worker', {
    reason: 'Read project notes',
    folderHint: 'Project Notes',
    access: 'read',
  });
  const messages: Message[] = [
    {
      id: 'approval',
      role: 'assistant',
      toolCalls: [
        {
          id: 'folder-call',
          type: 'function',
          function: {
            name: 'review_local_folder_access',
            arguments: JSON.stringify({ requestId: request.id }),
          },
        },
      ],
    },
  ];
  if (otherApproval && messages[0].role === 'assistant')
    messages[0].toolCalls!.push({
      id: 'other-approval',
      type: 'function',
      function: { name: 'request_connection_action', arguments: '{}' },
    });
  const lease = (await f.jobs.claim('job', 'folder-run', 60000))!;
  const thread = (await f.conversations.acquireThread('worker'))!;
  await thread.beginRun({
    threadId: 'worker',
    runId: 'folder-run',
    messages: [],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  });
  await thread.appendEvent({ type: EventType.MESSAGES_SNAPSHOT, messages });
  await thread.finishRun(messages, {}, 'finished');
  await thread.release();
  await f.jobs.settle(lease, { status: 'approval' });
  const expire = () => {
    const db = new DatabaseSync(f.database);
    try {
      db.prepare(
        "UPDATE folder_requests SET value=json_set(value,'$.request.expiresAt',?) WHERE ownerId=? AND id=?",
      ).run(Date.now() - 1000, f.ownerId, request.id);
    } finally {
      db.close();
    }
  };
  return { request, messages, expire };
}
const nextTask = (f: Awaited<ReturnType<typeof fixture>>) => ({
  ...f.input,
  id: 'next',
  utteranceId: 'next',
  workerThreadId: 'next-worker',
});

it('releases an expired folder approval before accepting another voice task, without deciding or granting', async () => {
  const f = await fixture();
  const approval = await awaitingFolder(f);
  approval.expire();
  expect((await f.jobs.enqueue(nextTask(f))).kind).toBe('created');
  expect(await f.jobs.get('job')).toMatchObject({
    status: 'interrupted',
    error: expect.stringContaining('expired'),
  });
  expect(await f.jobs.claim('job', 'late-approval', 1000)).toBeNull();
  const detail = await f.workspace.folders.getRequest(
    'worker',
    approval.request.id,
  );
  expect(detail.request.status).toBe('pending');
  expect(detail.decision).toBeUndefined();
  expect(await f.workspace.folders.list(f.input.dotId)).toEqual([]);
  expect((await f.conversations.getSnapshot('worker')).messages).toEqual(
    approval.messages,
  );
});

it('recovers expired folder waits on restart without waiting for a new voice request', async () => {
  const f = await fixture();
  const approval = await awaitingFolder(f);
  approval.expire();
  await f.jobs.recover();
  expect(await f.jobs.get('job')).toMatchObject({ status: 'interrupted' });
});

it('keeps unexpired approval waits active', async () => {
  const f = await fixture();
  await awaitingFolder(f);
  expect((await f.jobs.enqueue(nextTask(f))).kind).toBe('busy');
  expect(await f.jobs.get('job')).toMatchObject({ status: 'approval' });
});

it('keeps a task active when another approval still needs review', async () => {
  const f = await fixture();
  const approval = await awaitingFolder(f, true);
  approval.expire();
  expect(await f.jobs.expireApprovals()).toEqual([]);
  expect((await f.jobs.enqueue(nextTask(f))).kind).toBe('busy');
});

it('preserves a saved approval decision awaiting delivery even after its deadline', async () => {
  const f = await fixture();
  const approval = await awaitingFolder(f);
  await f.workspace.folders.decide('worker', approval.request.id, {
    toolCallId: 'folder-call',
    approve: false,
  });
  approval.expire();
  expect((await f.jobs.enqueue(nextTask(f))).kind).toBe('busy');
  expect(await f.jobs.get('job')).toMatchObject({ status: 'approval' });
});

it('leaves an expired approval alone while its conversation is leased for continuation', async () => {
  const f = await fixture();
  const approval = await awaitingFolder(f);
  approval.expire();
  const lease = (await f.conversations.acquireThread('worker'))!;
  try {
    expect((await f.jobs.enqueue(nextTask(f))).kind).toBe('busy');
    expect(await f.jobs.get('job')).toMatchObject({ status: 'approval' });
  } finally {
    await lease.release();
  }
  expect((await f.jobs.enqueue(nextTask(f))).kind).toBe('created');
});

it('rejects cross-Dot calls, invented captions and absent source messages before mutation', async () => {
  const f = await fixture();
  const other = await f.workspace.createDot(
    (await f.workspace.spaces())[0].id,
    'Other Dot',
    '',
    false,
    false,
  );
  for (const change of [
    { dotId: other.id },
    { sourceText: 'Fabricated caption' },
    { sourceMessageId: 'missing' },
    { callId: 'missing' },
    { workerThreadId: 'parent' },
  ])
    await expect(f.jobs.enqueue({ ...f.input, ...change })).rejects.toThrow();
  expect(await f.jobs.list()).toEqual([]);
  await expect(f.workspace.requireThread('worker')).rejects.toThrow();
});

it('rolls back worker creation when a supplied job identity collides', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  await f.jobs.cancel('job');
  await expect(
    f.jobs.enqueue({
      ...f.input,
      utteranceId: 'another',
      workerThreadId: 'new-worker',
    }),
  ).rejects.toThrow();
  await expect(f.workspace.requireThread('new-worker')).rejects.toThrow();
  await expect(f.conversations.getSnapshot('new-worker')).rejects.toThrow();
});

it('fences expired leases and prior attempts across approval continuation', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  const lease = (await f.jobs.claim('job', 'task-run-1', 25))!;
  expect(lease.generation).toBe(1);
  expect(await f.jobs.claim('job', 'duplicate-run', 1000)).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await expect(f.jobs.renew(lease, 1000)).rejects.toThrow(/lease/i);
  await expect(
    f.jobs.settle(lease, { status: 'completed', result: 'Late' }),
  ).rejects.toThrow(/lease/i);
  await f.jobs.recover();
  expect(await f.jobs.get('job')).toMatchObject({
    status: 'interrupted',
    leaseToken: null,
  });
  expect(await f.jobs.claim('job', 'replay', 1000)).toBeNull();
  await f.jobs.enqueue({
    ...f.input,
    id: 'next',
    utteranceId: 'next',
    workerThreadId: 'next-worker',
  });
  const first = (await f.jobs.claim('next', 'next-run-1', 1000))!;
  const renewed = await f.jobs.renew(first, 2000);
  expect(renewed.expiresAt).toBeGreaterThanOrEqual(first.expiresAt);
  await f.jobs.settle(renewed, { status: 'approval' });
  await f.jobs.recover();
  expect(await f.jobs.get('next')).toMatchObject({ status: 'approval' });
  const second = (await f.jobs.claim('next', 'next-run-2', 1000))!;
  expect(second.generation).toBe(2);
  await expect(f.jobs.settle(first, { status: 'completed' })).rejects.toThrow(
    /lease/i,
  );
  await f.jobs.settle(second, {
    status: 'completed',
    result: 'Authoritative result',
  });
  expect(await f.jobs.cancel('next')).toMatchObject({
    status: 'completed',
    result: 'Authoritative result',
  });
});

it('persists cancellation and results through reopening, rejects late completion', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  const lease = (await f.jobs.claim('job', 'run', 1000))!;
  expect(await f.jobs.cancel('job')).toMatchObject({
    status: 'cancelled',
    leaseToken: null,
  });
  await expect(
    f.jobs.settle(lease, { status: 'completed', result: 'Late' }),
  ).rejects.toThrow(/lease/i);
  await f.jobs.enqueue({
    ...f.input,
    id: 'done',
    utteranceId: 'done',
    workerThreadId: 'done-worker',
  });
  await f.jobs.settle((await f.jobs.claim('done', 'done-run', 1000))!, {
    status: 'completed',
    result: 'Saved result',
  });
  await f.storage.close();
  const reopened = await StorageClient.open({
    database: f.database,
    ownerId: f.ownerId,
  });
  cleanups.push(() => reopened.close());
  expect(
    await reopened.repositories.voiceDelegations.get('done'),
  ).toMatchObject({
    status: 'completed',
    result: 'Saved result',
    receiptMessageId: null,
  });
  expect(await reopened.repositories.voiceDelegations.get('job')).toMatchObject(
    { status: 'cancelled' },
  );
});

it('only acknowledges an actually persisted parent assistant receipt, idempotently', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  await expect(
    f.jobs.markDelivered('job', 'receipt', { status: 'queued', generation: 0 }),
  ).rejects.toThrow();
  await f.jobs.settle((await f.jobs.claim('job', 'run', 1000))!, {
    status: 'completed',
    result: 'Done',
  });
  await expect(
    f.jobs.markDelivered('job', 'receipt', {
      status: 'completed',
      generation: 1,
    }),
  ).rejects.toThrow();
  const lease = (await f.conversations.acquireThread('parent'))!;
  const snapshot = await lease.read();
  const messages = [
    ...snapshot.messages,
    { id: 'receipt', role: 'assistant' as const, content: 'Done' },
  ];
  await lease.beginRun({
    threadId: 'parent',
    runId: 'receipt-run',
    messages: snapshot.messages,
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  });
  await lease.finishRun(messages, {}, 'finished');
  await lease.release();
  const delivered = await f.jobs.markDelivered('job', 'receipt', {
    status: 'completed',
    generation: 1,
  });
  expect(delivered).toMatchObject({ receiptMessageId: 'receipt' });
  expect(delivered.deliveredAt).toEqual(expect.any(Number));
  expect(
    await f.jobs.markDelivered('job', 'receipt', {
      status: 'completed',
      generation: 1,
    }),
  ).toEqual(delivered);
  await expect(
    f.jobs.markDelivered('job', 'other', {
      status: 'completed',
      generation: 1,
    }),
  ).rejects.toThrow();
});

it('fails cleanly on the legacy backend without adding delegation schema', async () => {
  const f = await fixture('legacy-postgres');
  await expect(f.jobs.list()).rejects.toThrow(/SQLite/i);
  await expect(f.jobs.enqueue(f.input)).rejects.toThrow(/SQLite/i);
  await f.storage.close();
  const db = new DatabaseSync(f.database, { readOnly: true });
  expect(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE name='voice_delegations'")
      .get(),
  ).toBeUndefined();
  db.close();
});

it('restores known schema-2 history into schema 3 without mutating the source', async () => {
  const f = await fixture();
  await f.storage.close();
  const old = new DatabaseSync(f.database);
  old.exec(
    'DROP TABLE voice_delegations; DELETE FROM workspace_storage_schema WHERE version=3',
  );
  old.close();
  const destination = join(f.root, 'restored');
  await mkdir(join(destination, 'data'), { recursive: true });
  await mkdir(join(destination, 'recovery'));
  await restoreSQLite(
    f.database,
    join(destination, 'data/workspace.sqlite'),
    f.ownerId,
    new AbortController().signal,
    'sqlite',
  );
  const restored = new DatabaseSync(
    join(destination, 'data/workspace.sqlite'),
    { readOnly: true },
  );
  expect(
    restored
      .prepare('SELECT max(version) AS version FROM workspace_storage_schema')
      .get()!.version,
  ).toBe(3);
  expect(
    restored.prepare('SELECT count(*) AS n FROM voice_delegations').get()!.n,
  ).toBe(0);
  expect(
    restored.prepare('SELECT message_id FROM conversation_messages').get()!
      .message_id,
  ).toBe('source');
  restored.close();
  const original = new DatabaseSync(f.database, { readOnly: true });
  expect(
    original
      .prepare('SELECT max(version) AS version FROM workspace_storage_schema')
      .get()!.version,
  ).toBe(2);
  original.close();
});

it('rejects a schema-2 archive with an unknown table before upgrading it', async () => {
  const f = await fixture();
  await f.storage.close();
  const db = new DatabaseSync(f.database);
  db.exec(
    'DROP TABLE voice_delegations; DELETE FROM workspace_storage_schema WHERE version=3; CREATE TABLE unexpected(value TEXT)',
  );
  db.close();
  await expect(
    copyValidatedSQLite(
      f.database,
      join(f.root, 'copy.sqlite'),
      f.ownerId,
      new AbortController().signal,
      'sqlite',
    ),
  ).rejects.toThrow(/schema/i);
});

it('archives outcomes and idempotency while restore fences active callbacks and approvals', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  const lease = (await f.jobs.claim('job', 'run', 60_000))!;
  await f.storage.close();
  const destination = join(f.root, 'restored');
  await mkdir(join(destination, 'data'), { recursive: true });
  await mkdir(join(destination, 'recovery'));
  const dbPath = join(destination, 'data/workspace.sqlite');
  await restoreSQLite(
    f.database,
    dbPath,
    f.ownerId,
    new AbortController().signal,
    'sqlite',
  );
  const restored = await StorageClient.open({
    database: dbPath,
    ownerId: f.ownerId,
  });
  cleanups.push(() => restored.close());
  expect(await restored.repositories.voiceDelegations.get('job')).toMatchObject(
    { status: 'interrupted', leaseToken: null },
  );
  await expect(
    restored.repositories.voiceDelegations.settle(lease, {
      status: 'completed',
      result: 'Stale callback',
    }),
  ).rejects.toThrow(/lease/i);
  expect(
    (await restored.repositories.voiceDelegations.enqueue(f.input)).kind,
  ).toBe('existing');
  expect(
    await restored.repositories.voiceDelegations.claim('job', 'replay', 1000),
  ).toBeNull();
});

it('validates delegation ownership and source captions when importing an archive', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  await f.storage.close();
  const db = new DatabaseSync(f.database);
  db.prepare(
    "UPDATE voice_delegations SET source_text='Invented caption'",
  ).run();
  db.close();
  await expect(
    copyValidatedSQLite(
      f.database,
      join(f.root, 'copy.sqlite'),
      f.ownerId,
      new AbortController().signal,
      'sqlite',
    ),
  ).rejects.toThrow(/delegation|reference|binding/i);
});

it('atomically updates a known workspace manifest after runtime schema upgrade', async () => {
  const f = await fixture();
  const identity = {
    version: 1 as const,
    id: randomUUID(),
    ownerId: f.ownerId,
    storage: 'sqlite' as const,
    schema: 2,
  };
  await createWorkspaceManifest(f.root, identity);
  await updateWorkspaceManifestSchema(f.root, f.ownerId);
  expect(await readWorkspaceManifest(f.root)).toEqual({
    ...identity,
    schema: 3,
  });
  await updateWorkspaceManifestSchema(f.root, f.ownerId);
  await expect(
    updateWorkspaceManifestSchema(f.root, 'other-owner'),
  ).rejects.toThrow(/owner/i);
});

it('binds an unused same-Dot worker but rejects a worker leased by another run', async () => {
  const f = await fixture();
  await f.conversations.createThread({
    userId: f.ownerId,
    agentId: f.input.dotId,
    threadId: 'worker',
  });
  const lease = (await f.conversations.acquireThread('worker'))!;
  await expect(f.jobs.enqueue(f.input)).rejects.toThrow(/lease|running/i);
  expect(await f.jobs.list()).toEqual([]);
  await expect(f.workspace.requireThread('worker')).rejects.toThrow();
  await lease.release();
  expect((await f.jobs.enqueue(f.input)).kind).toBe('created');
  expect(
    await f.workspace.requireThread('worker', f.input.dotId),
  ).toMatchObject({ id: 'worker' });
});

it('reconciles a persisted terminal run after a crash, without claiming another attempt', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  await f.jobs.claim('job', 'task-run', 1000);
  await expect(
    f.jobs.recover({
      reconciled: [
        {
          id: 'job',
          runId: 'task-run',
          status: 'completed',
          result: 'Fabricated',
        },
      ],
    }),
  ).rejects.toThrow(/canonical run/i);
  const lease = (await f.conversations.acquireThread('worker'))!;
  const input = {
    threadId: 'worker',
    runId: 'task-run',
    messages: [],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  await lease.beginRun(input);
  await lease.finishRun(
    [{ id: 'answer', role: 'assistant', content: 'Persisted answer' }],
    {},
    'finished',
  );
  await lease.release();
  await expect(
    f.jobs.recover({
      reconciled: [{ id: 'job', runId: 'wrong', status: 'completed' }],
    }),
  ).rejects.toThrow(/mismatch/i);
  expect(
    await f.jobs.recover({
      reconciled: [
        {
          id: 'job',
          runId: 'task-run',
          status: 'completed',
          result: 'Persisted answer',
        },
      ],
    }),
  ).toMatchObject([
    {
      id: 'job',
      status: 'completed',
      result: 'Persisted answer',
      leaseToken: null,
    },
  ]);
  expect(await f.jobs.recover()).toEqual([]);
  expect(await f.jobs.claim('job', 'replay', 1000)).toBeNull();
});

it('interrupts portable-host approval waits and fences the prior delivery state', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  await f.jobs.settle((await f.jobs.claim('job', 'run', 1000))!, {
    status: 'approval',
  });
  await f.storage.close();
  const rebound = await StorageClient.open({
    database: f.database,
    ownerId: f.ownerId,
    machineId: 'other-machine',
  });
  cleanups.push(() => rebound.close());
  expect(await rebound.repositories.voiceDelegations.get('job')).toMatchObject({
    status: 'interrupted',
    leaseGeneration: 2,
    receiptMessageId: null,
  });
  await expect(
    rebound.repositories.voiceDelegations.markDelivered('job', 'receipt', {
      status: 'approval',
      generation: 1,
    }),
  ).rejects.toThrow(/state/i);
  expect(
    await rebound.repositories.voiceDelegations.claim('job', 'replay', 1000),
  ).toBeNull();
});

it('rejects archive descriptor/schema mismatches even when both schemas are known', async () => {
  const f = await fixture();
  await f.storage.close();
  await expect(
    copyValidatedSQLite(
      f.database,
      join(f.root, 'copy.sqlite'),
      f.ownerId,
      new AbortController().signal,
      'sqlite',
      2,
    ),
  ).rejects.toThrow(/manifest/i);
});

it('delivers approval and final receipts separately and fences a late approval acknowledgement', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  const first = (await f.jobs.claim('job', 'run-1', 1000))!;
  await f.jobs.settle(first, { status: 'approval', result: 'Approval needed' });
  const lease = (await f.conversations.acquireThread('parent'))!;
  const snapshot = await lease.read();
  const messages = [
    ...snapshot.messages,
    {
      id: 'approval-receipt',
      role: 'assistant' as const,
      content: 'Approval needed',
    },
    { id: 'final-receipt', role: 'assistant' as const, content: 'Done' },
  ];
  await lease.beginRun({
    threadId: 'parent',
    runId: 'receipt-run',
    messages: snapshot.messages,
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  });
  await lease.finishRun(messages, {}, 'finished');
  await lease.release();
  expect(
    await f.jobs.markDelivered('job', 'approval-receipt', {
      status: 'approval',
      generation: 1,
    }),
  ).toMatchObject({ receiptMessageId: 'approval-receipt' });
  const second = (await f.jobs.claim('job', 'run-2', 1000))!;
  expect(await f.jobs.get('job')).toMatchObject({
    receiptMessageId: null,
    deliveredAt: null,
  });
  await f.jobs.settle(second, { status: 'completed', result: 'Done' });
  await expect(
    f.jobs.markDelivered('job', 'approval-receipt', {
      status: 'approval',
      generation: 1,
    }),
  ).rejects.toThrow(/receipt|state/i);
  expect(await f.jobs.get('job')).toMatchObject({ receiptMessageId: null });
  expect(
    await f.jobs.markDelivered('job', 'final-receipt', {
      status: 'completed',
      generation: 2,
    }),
  ).toMatchObject({ receiptMessageId: 'final-receipt' });
});

it('projects bounded masked same-Dot context and carries its evidence guard', async () => {
  const f = await fixture();
  const lease = (await f.conversations.acquireThread('parent'))!;
  const messages = [
    { id: 'source', role: 'user' as const, content: f.input.sourceText },
    {
      id: 'known',
      role: 'user' as const,
      content: 'The diagnostic label is amber fox.',
    },
  ];
  await lease.beginRun(
    {
      threadId: 'parent',
      runId: 'known-context',
      messages,
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    },
    { originDotId: f.input.dotId, spaceIds: [], pageIds: [] },
  );
  await lease.finishRun(messages, {}, 'finished');
  await lease.release();
  // Prior input in this fixture has no provenance: do not invent trust for it.
  expect(await f.jobs.threadContext('parent', f.input.dotId)).toMatchObject({
    available: false,
    messages: [],
  });
  await expect(f.jobs.threadContext('parent', 'another-dot')).rejects.toThrow();
  await f.jobs.enqueue(f.input);
  const child = (await f.conversations.acquireThread('worker'))!;
  await child.beginRun(
    {
      threadId: 'worker',
      runId: 'guarded',
      messages,
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    },
    { originDotId: f.input.dotId, spaceIds: [], pageIds: [] },
  );
  await child.finishRun(messages, {}, 'finished');
  await child.release();
  expect(await f.jobs.threadContext('worker', f.input.dotId)).toMatchObject({
    available: true,
    messages,
    guard: { originDotId: f.input.dotId },
  });
});

it('interrupts only the same expired job attempt after the thread lease is released', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  const lease = (await f.jobs.claim('job', 'run', 25))!;
  const thread = (await f.conversations.acquireThread('worker'))!;
  await new Promise((resolve) => setTimeout(resolve, 40));
  await expect(f.jobs.interrupt(lease)).rejects.toThrow(/running|lease/i);
  await thread.release();
  expect(await f.jobs.interrupt(lease)).toMatchObject({
    status: 'interrupted',
  });
  expect(await f.jobs.interrupt(lease)).toBeNull();
});

it('withholds delegated context when a referenced page is deleted', async () => {
  const f = await fixture();
  await f.jobs.enqueue(f.input);
  const dot = (await f.workspace.dots())[0];
  const page = await f.workspace.pages.create(dot.spaceId, {
    title: 'Private',
    content: 'Private label.',
  });
  const lease = (await f.conversations.acquireThread('worker'))!;
  const messages = [
    { id: 'answer', role: 'assistant' as const, content: 'Private label.' },
  ];
  await lease.beginRun(
    {
      threadId: 'worker',
      runId: 'page-result',
      messages,
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    },
    { originDotId: dot.id, spaceIds: [dot.spaceId], pageIds: [page.id] },
  );
  await lease.finishRun(messages, {}, 'finished');
  await lease.release();
  expect((await f.jobs.threadContext('worker', dot.id)).available).toBe(true);
  await f.workspace.pages.delete(dot.spaceId, page.id);
  expect(await f.jobs.threadContext('worker', dot.id)).toMatchObject({
    available: false,
    messages: [],
  });
});
