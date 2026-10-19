import { ConversationMemory } from '../../src/server/conversation-memory.js';
import { EventType } from '@ag-ui/core';
import { MemoryJobs } from '../../src/server/memory-jobs.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Store } from '../../src/server/store.js';
import { WorkspaceStore } from '../../src/server/workspace.js';
import { PostgresConversations } from '../../src/server/local-conversations.js';
import { MaintenanceGate } from '../../src/server/storage/maintenance.js';

export async function storageWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'dot-snapshot-'));
  const sqlitePath = join(root, 'workspace.sqlite');
  const configurationPath = join(root, 'workspace.env');
  const ownerId = randomUUID();
  const foreignOwner = randomUUID();
  const workspaceId = randomUUID();
  const store = new Store(sqlitePath);
  const workspace = new WorkspaceStore(sqlitePath, ownerId);
  const postgresUrl = process.env.LOCAL_TEST_DATABASE_URL!;
  const conversations = new PostgresConversations(postgresUrl, ownerId);
  const foreign = new PostgresConversations(postgresUrl, foreignOwner);
  const pg = new Pool({ connectionString: postgresUrl });
  const gate = new MaintenanceGate();
  await conversations.initialize();
  await foreign.initialize();
  const dot = workspace.dots()[0];
  const thread = randomUUID();
  workspace.bindThread(thread, dot.id, 'Selected conversation');
  await conversations.createThread({
    threadId: thread,
    agentId: dot.id,
    userId: ownerId,
  });
  await foreign.createThread({
    threadId: randomUUID(),
    agentId: dot.id,
    userId: foreignOwner,
    name: 'OTHER_OWNER_SENTINEL',
  });
  await conversations.createThread({
    threadId: randomUUID(),
    agentId: randomUUID(),
    userId: ownerId,
    name: 'OTHER_WORKSPACE_SENTINEL',
  });
  const lease = (await conversations.acquireThread(thread))!;
  const runId = randomUUID();
  const messages = [
    {
      id: randomUUID(),
      role: 'user' as const,
      content: 'Keep this conversation',
    },
  ];
  await lease.beginRun(
    {
      threadId: thread,
      runId,
      messages,
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    },
    { originDotId: dot.id, spaceIds: [], pageIds: [] },
  );
  const assistantId = randomUUID();
  for (const event of [
    { type: EventType.RUN_STARTED, threadId: thread, runId },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: assistantId,
      role: 'assistant',
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: assistantId,
      delta: 'Retained answer',
    },
    { type: EventType.TEXT_MESSAGE_END, messageId: assistantId },
    { type: EventType.RUN_FINISHED, threadId: thread, runId },
  ])
    await lease.appendEvent(event);
  await lease.finishRun(
    [
      ...messages,
      { id: assistantId, role: 'assistant', content: 'Retained answer' },
    ],
    {},
    'finished',
  );
  await lease.release();
  const repository = new ConversationMemory(pg, ownerId, workspace);
  await repository.indexRun(runId);
  const sources = await pg.query(
    'SELECT source_id,source FROM memory_episode_chunks WHERE owner_id=$1',
    [ownerId],
  );
  const job = await new MemoryJobs(pg, ownerId).enqueue({
    kind: 'dream',
    dotId: dot.id,
    sourceIds: sources.rows.map((row) => row.source_id),
    origin: 'manual',
    logicalKey: randomUUID(),
  });
  await pg.query(
    'UPDATE memory_jobs SET lease_until=$3 WHERE owner_id=$1 AND id=$2',
    [ownerId, job.id, '9007199254740993'],
  );
  if (sources.rows[0])
    workspace.memory.history.suppress(
      [sources.rows[0].source],
      'forgotten in fixture',
    );
  const forgotten = workspace.memory.create({
    scope: { kind: 'owner' },
    title: 'Forgotten',
    text: 'Do not recall',
  });
  workspace.memory.edit(forgotten.id, 1, { status: 'forgotten' });
  store.saveMemory('Committed SQLite WAL memory', 'wal-memory');
  const memory = workspace.memory.create({
    scope: { kind: 'owner' },
    title: 'Preference',
    text: 'Keep this preference',
  });
  const call = workspace.createCall(thread);
  workspace.setCall(call.id, 'ended', 'Saved voice transcript');
  const connection = workspace.connections.create(
    dot.id,
    {
      name: 'Test connection',
      url: 'https://example.invalid',
      token: 'recover-only-secret',
    },
    [],
  );
  workspace.connections.createApproval({
    threadId: thread,
    dotId: dot.id,
    connectionId: connection.id,
    tool: 'sample',
    arguments: { value: 1 },
  });
  workspace.pages.create(dot.spaceId, {
    title: 'Saved page',
    content: 'Persistent page',
    parentId: null,
  });
  await writeFile(
    configurationPath,
    'OWNER_TOKEN=recovery-evidence-only\nLOCAL_DATABASE_URL=do-not-activate\n',
  );
  return {
    root,
    sqlitePath,
    configurationPath,
    ownerId,
    workspaceId,
    postgresUrl,
    gate,
    store,
    workspace,
    pg,
    conversations,
    dot,
    thread,
    runId,
    memory,
    forgotten,
    job,
    call,
    directory: join(root, 'capture'),
    async dispose() {
      store.close();
      workspace.close();
      await conversations.close();
      await foreign.close();
      for (const owner of [ownerId, foreignOwner]) {
        await pg.query('DELETE FROM memory_jobs WHERE owner_id=$1', [owner]);
        await pg.query('DELETE FROM local_ai_runs WHERE owner_id=$1', [owner]);
        await pg.query('DELETE FROM local_ai_threads WHERE owner_id=$1', [
          owner,
        ]);
      }
      await pg.end();
      await rm(root, { recursive: true, force: true });
    },
  };
}
