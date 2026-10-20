import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from '@ag-ui/client';
import { lastValueFrom, of, toArray } from 'rxjs';
import {
  PostgresConversations,
  mergeInputMessages,
} from '../src/server/local-conversations.js';
import { LocalAgentRunner } from '../src/server/local-runner.js';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { SQLiteConversations } from '../src/server/storage/sqlite-conversations.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const input = (threadId: string, runId = randomUUID()): RunAgentInput => ({
  threadId,
  runId,
  messages: [{ id: 'user', role: 'user', content: 'Remember this' }],
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
});
async function sqliteFixture(entry?: URL) {
  const root = await mkdtemp(join(tmpdir(), 'dots-conversations-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const database = join(root, 'workspace.sqlite');
  const owner = randomUUID();
  const client = await StorageClient.open({ database, ownerId: owner, entry });
  const store = new SQLiteConversations(client);
  cleanups.push(async () => {
    await store.close();
    await client.close();
  });
  return { root, database, owner, client, store };
}
async function fixture(adapter: 'sqlite' | 'postgres') {
  if (adapter === 'sqlite') {
    const f = await sqliteFixture();
    return {
      store: f.store,
      owner: f.owner,
      reopen: async () => {
        await f.store.close();
        await f.client.close();
        const client = await StorageClient.open({
          database: f.database,
          ownerId: f.owner,
        });
        const store = new SQLiteConversations(client);
        cleanups.push(async () => {
          await store.close();
          await client.close();
        });
        return store;
      },
    };
  }
  const owner = randomUUID();
  const connection = process.env.LOCAL_TEST_DATABASE_URL!;
  cleanups.push(async () => {
    const pg = new Pool({ connectionString: connection });
    try {
      await pg.query('DELETE FROM local_ai_runs WHERE owner_id=$1', [owner]);
      await pg.query('DELETE FROM local_ai_threads WHERE owner_id=$1', [owner]);
    } finally {
      await pg.end();
    }
  });
  const store = new PostgresConversations(connection, owner);
  cleanups.push(() => store.close());
  return {
    store,
    owner,
    reopen: async () => {
      const reopened = new PostgresConversations(connection, owner);
      cleanups.push(() => reopened.close());
      return reopened;
    },
  };
}
for (const adapter of ['sqlite', 'postgres'] as const) {
  describe.skipIf(
    adapter === 'postgres' && !process.env.LOCAL_TEST_DATABASE_URL,
  )(adapter, () => {
    it('keeps thread ownership separate and recovers unfinished output after reopening', async () => {
      const f = await fixture(adapter);
      const threadId = randomUUID();
      const other = randomUUID();
      await f.store.getOrCreateThread({
        threadId,
        userId: f.owner,
        agentId: 'dot',
        name: 'Saved',
      });
      await f.store.createThread({
        threadId: other,
        userId: f.owner,
        agentId: 'other',
      });
      const lease = (await f.store.acquireThread(threadId))!;
      const independent = (await f.store.acquireThread(other))!;
      expect(independent).not.toBeNull();
      expect(await f.store.acquireThread(threadId)).toBeNull();
      await independent.release();
      const run = input(threadId);
      await lease.beginRun(run);
      await lease.appendEvent({
        type: EventType.RUN_STARTED,
        threadId,
        runId: run.runId,
      });
      await lease.appendEvent({
        type: EventType.TEXT_MESSAGE_START,
        messageId: 'assistant',
        role: 'assistant',
      });
      await lease.appendEvent({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'assistant',
        delta: 'Preserved partial answer',
      });
      await lease.release();
      const reopened = await f.reopen();
      const snapshot = await reopened.getSnapshot(threadId);
      expect(snapshot.messages.at(-1)?.content).toBe(
        'Preserved partial answer',
      );
      expect(snapshot.lastRun?.status).toBe('interrupted');
      expect(
        (await reopened.getEvents(threadId)).filter(
          (event) => event.type === EventType.RUN_ERROR,
        ),
      ).toHaveLength(1);
      expect(
        (await reopened.listThreads('dot')).map((thread) => thread.name),
      ).toEqual(['Saved']);
      await expect(
        reopened.getThreadMessages({ threadId, userId: 'wrong-owner' }),
      ).rejects.toThrow(/owner/i);
      await expect(
        reopened.getOrCreateThread({
          threadId,
          userId: f.owner,
          agentId: 'wrong-dot',
        }),
      ).rejects.toThrow(/agent/i);
      const next = (await reopened.acquireThread(threadId))!;
      await expect(next.beginRun(run)).rejects.toThrow(/already/i);
      await next.release();
    });
    it('retains pending approvals and settles a run with exactly one terminal event', async () => {
      const f = await fixture(adapter);
      const threadId = randomUUID();
      await f.store.createThread({ threadId, userId: f.owner, agentId: 'dot' });
      const lease = (await f.store.acquireThread(threadId))!;
      const run = input(threadId);
      await lease.beginRun(run);
      const events: BaseEvent[] = [
        { type: EventType.RUN_STARTED, threadId, runId: run.runId },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: 'approval',
          toolCallName: 'review_space_page',
          parentMessageId: 'assistant',
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'approval', delta: '{}' },
        { type: EventType.TOOL_CALL_END, toolCallId: 'approval' },
      ];
      for (const event of events) await lease.appendEvent(event);
      const current = await lease.read();
      await lease.finishRun(current.messages, current.state, 'finished', {
        type: EventType.RUN_FINISHED,
        threadId,
        runId: run.runId,
      });
      await expect(lease.finishRun([], {}, 'failed')).rejects.toThrow(
        /active|ownership|finished/i,
      );
      await lease.release();
      const saved = await f.store.getSnapshot(threadId);
      expect(saved.messages.at(-1)).toMatchObject({
        toolCalls: [{ id: 'approval' }],
      });
      const answered = mergeInputMessages(saved.messages, [
        {
          id: 'approval-result',
          role: 'tool',
          toolCallId: 'approval',
          content: '{"approved":false}',
        },
      ]);
      expect(answered.at(-1)?.id).toBe('approval-result');
      expect(
        (await f.store.getEvents(threadId)).filter(
          (event) => event.type === EventType.RUN_FINISHED,
        ),
      ).toHaveLength(1);
    });
  });
}
it('fences expired SQLite leases, including stale releases and finalization', async () => {
  const { client, store, owner } = await sqliteFixture();
  const threadId = randomUUID();
  await store.createThread({ threadId, userId: owner, agentId: 'dot' });
  const old = (await client.call('conversations.acquire', [threadId, 50]))!;
  await client.call('conversations.beginRun', [old, input(threadId)]);
  await new Promise((resolve) => setTimeout(resolve, 70));
  const current = (await client.call('conversations.acquire', [
    threadId,
    30_000,
  ]))!;
  expect(current.generation).toBeGreaterThan(old.generation);
  await expect(
    client.call('conversations.appendEvent', [
      old,
      { type: EventType.RUN_ERROR, message: 'stale' },
    ]),
  ).rejects.toThrow(/lease|ownership/i);
  await expect(
    client.call('conversations.finishRun', [old, [], {}, 'finished']),
  ).rejects.toThrow(/lease|ownership/i);
  await client.call('conversations.release', [old]);
  expect(await store.acquireThread(threadId)).toBeNull();
  await client.call('conversations.release', [current]);
});
it('does not emit text to chat or voice before the worker commits it', async () => {
  const { client, store, database } = await sqliteFixture(
    new URL('./fixtures/repository-worker-probe.ts', import.meta.url),
  );
  const db = new DatabaseSync(database, { readOnly: true });
  cleanups.push(async () => db.close());
  const threadId = randomUUID();
  const run = input(threadId);
  const seen: string[] = [];
  const voiced: string[] = [];
  class Agent extends AbstractAgent {
    run() {
      return of<BaseEvent[]>(
        { type: EventType.RUN_STARTED, threadId, runId: run.runId },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: 'answer',
          role: 'assistant',
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: 'answer',
          delta: 'Durable answer',
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' },
        { type: EventType.RUN_FINISHED, threadId, runId: run.runId },
      );
    }
    onPersistedEvent(_input: RunAgentInput, event: BaseEvent) {
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
        expect(
          Number(
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM conversation_events WHERE type='TEXT_MESSAGE_CONTENT'",
              )
              .get()!.n,
          ),
        ).toBe(1);
        voiced.push('heard');
      }
    }
  }
  const runner = new LocalAgentRunner(store);
  cleanups.push(() => runner.close());
  const stream = runner.run({
    threadId,
    input: run,
    agent: new Agent({ agentId: 'dot' }),
  });
  const result = lastValueFrom(stream.pipe(toArray()));
  const observer = stream.subscribe((event) => {
    if (event.type === EventType.TEXT_MESSAGE_CONTENT)
      seen.push(String(event.delta));
  });
  try {
    await vi.waitFor(async () =>
      expect(await readFile(database + '.started', 'utf8')).toBe('started'),
    );
    expect(seen).toEqual([]);
    expect(voiced).toEqual([]);
    expect(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM conversation_events WHERE type='TEXT_MESSAGE_CONTENT'",
          )
          .get()!.n,
      ),
    ).toBe(0);
    await writeFile(database + '.continue', 'continue');
    expect((await result).at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(seen).toEqual(['Durable answer']);
    expect(voiced).toEqual(['heard']);
    expect((await store.getSnapshot(threadId)).messages.at(-1)?.content).toBe(
      'Durable answer',
    );
  } finally {
    observer.unsubscribe();
    await client.repositories.store.settings();
  }
});
it('keeps canonical message order while retaining immutable inputs for earlier runs', async () => {
  const { client, store, owner } = await sqliteFixture();
  const threadId = randomUUID();
  await store.createThread({ threadId, userId: owner, agentId: 'dot' });
  const lease = (await store.acquireThread(threadId))!;
  const run = input(threadId);
  await lease.beginRun(run);
  const canonical = [
    {
      id: 'replacement',
      role: 'user' as const,
      content: 'Only canonical message',
    },
  ];
  await lease.appendEvent({
    type: EventType.MESSAGES_SNAPSHOT,
    messages: canonical,
  });
  await lease.finishRun(canonical, {}, 'finished', {
    type: EventType.RUN_FINISHED,
    threadId,
    runId: run.runId,
  });
  await lease.release();
  const records = await client.call('conversations.readSnapshot', [threadId]);
  expect(records.messages).toEqual(canonical);
  expect(records.lastRun?.input.messages).toEqual([
    { id: 'user', role: 'user', content: 'Remember this' },
  ]);
});
it('rolls back an event if its lease expires during the write', async () => {
  const { client, store, owner, database } = await sqliteFixture(
    new URL('./fixtures/repository-worker-probe.ts', import.meta.url),
  );
  const threadId = randomUUID();
  await store.createThread({ threadId, userId: owner, agentId: 'dot' });
  const lease = (await client.call('conversations.acquire', [threadId, 150]))!;
  await client.call('conversations.beginRun', [lease, input(threadId)]);
  const write = client.call('conversations.appendEvent', [
    lease,
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'late',
      delta: 'Expired text',
    },
  ]);
  const rejected = expect(write).rejects.toThrow(/lease|ownership/i);
  await vi.waitFor(async () =>
    expect(await readFile(database + '.started', 'utf8')).toBe('started'),
  );
  await new Promise((resolve) => setTimeout(resolve, 160));
  await writeFile(database + '.continue', 'continue');
  await rejected;
  expect(await store.getEvents(threadId)).toEqual([]);
});
it.each(['committed', 'inflight'])(
  'recovers after SIGKILL with %s event writes',
  async (mode) => {
    const { fork } = await import('node:child_process');
    const { once } = await import('node:events');
    const { fileURLToPath } = await import('node:url');
    const root = await mkdtemp(join(tmpdir(), 'dots-conversation-crash-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const database = join(root, 'workspace.sqlite');
    const owner = randomUUID();
    const child = fork(
      fileURLToPath(
        new URL('./fixtures/conversation-crash.ts', import.meta.url),
      ),
      [database, owner, mode],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    const exit = once(child, 'exit');
    cleanups.push(async () => {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
      await exit;
    });
    expect((await once(child, 'message'))[0]).toBe(
      mode === 'committed' ? 'ready' : 'writing',
    );
    if (mode === 'inflight')
      await vi.waitFor(async () =>
        expect(await readFile(database + '.started', 'utf8')).toBe('started'),
      );
    child.kill('SIGKILL');
    await exit;
    const client = await StorageClient.open({ database, ownerId: owner });
    const store = new SQLiteConversations(client);
    cleanups.push(async () => {
      await store.close();
      await client.close();
    });
    await vi.waitFor(async () =>
      expect((await store.getSnapshot('crash-thread')).lastRun?.status).toBe(
        'interrupted',
      ),
    );
    const messages = (await store.getSnapshot('crash-thread')).messages;
    expect(messages[0]).toMatchObject({ content: 'Saved input' });
    expect(
      messages.some((message) => message.content === 'Committed output'),
    ).toBe(mode === 'committed');
    const events = await store.getEvents('crash-thread');
    expect(
      events.filter((event) => event.type === EventType.RUN_ERROR),
    ).toHaveLength(1);
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe(
        'ok',
      );
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  },
);
it('rejects a newer SQLite schema without modifying its records', async () => {
  const { client, store, database, owner } = await sqliteFixture();
  await store.close();
  await client.close();
  const db = new DatabaseSync(database);
  const schema = db
    .prepare('SELECT name,sql FROM sqlite_schema ORDER BY name')
    .all();
  try {
    db.prepare('INSERT INTO workspace_storage_schema VALUES(99,123)').run();
    await expect(
      StorageClient.open({ database, ownerId: owner }),
    ).rejects.toThrow(/unsupported.*schema/i);
    expect(
      db
        .prepare(
          'SELECT version,applied_at FROM workspace_storage_schema WHERE version=99',
        )
        .get(),
    ).toMatchObject({ version: 99, applied_at: 123 });
    expect(
      db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(),
    ).toEqual(schema);
  } finally {
    db.close();
  }
});
