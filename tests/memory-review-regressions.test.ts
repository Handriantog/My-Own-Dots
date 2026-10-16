import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import type { Message } from '@ag-ui/core';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { PostgresConversations } from '../src/server/local-conversations.js';
import { MemoryMaintenance } from '../src/server/memory-maintenance.js';
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of clean.splice(0)) await fn();
});
const integration = it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL);
async function fixture() {
  const owner = randomUUID(),
    pg = new Pool({ connectionString: process.env.LOCAL_TEST_DATABASE_URL }),
    ws = new WorkspaceStore(':memory:', owner),
    store = new Store(':memory:');
  let now = Date.now();
  const invoke = vi.fn(async () => ({
    result: { kind: 'proposal', changes: [], noChangeReason: 'No change' },
    usage: {},
  }));
  const conversations = new PostgresConversations(
      process.env.LOCAL_TEST_DATABASE_URL!,
      owner,
    ),
    memory = new MemoryMaintenance(
      store,
      ws,
      { localDatabaseUrl: process.env.LOCAL_TEST_DATABASE_URL },
      { pg, clock: () => now, invoke },
    );
  await conversations.initialize();
  const dot = ws.dots()[0];
  ws.memory.updateSettings(
    dot.id,
    ws.memory.settings(dot.id).revision,
    {
      autoCompact: false,
      learningEnabled: true,
      dreamIntervalMs: 60000,
      dreamIdleMs: 1000,
    },
    now - 10000,
  );
  const add = async (
    thread: string,
    text: string,
    pending = false,
    guard = {
      originDotId: dot.id,
      spaceIds: [] as string[],
      pageIds: [] as string[],
    },
  ) => {
    if (!ws.conversations().some((t) => t.id === thread)) {
      ws.bindThread(thread, dot.id, thread);
      await conversations.getOrCreateThread({
        threadId: thread,
        userId: owner,
        agentId: dot.id,
      });
    }
    const run = randomUUID(),
      messages: Message[] = [{ id: run, role: 'user', content: text }];
    if (pending)
      messages.push({
        id: run + 'approval',
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: run + 'call',
            type: 'function',
            function: { name: 'review_space_page', arguments: '{}' },
          },
        ],
      });
    const lease = (await conversations.acquireThread(thread))!;
    await lease.beginRun(
      {
        threadId: thread,
        runId: run,
        messages,
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      },
      guard,
    );
    await lease.finishRun(messages, {}, 'finished');
    await lease.release();
    return run;
  };
  clean.push(async () => {
    await memory.stop();
    await pg.query('DELETE FROM memory_jobs WHERE owner_id=$1', [owner]);
    await pg.query('DELETE FROM memory_processed_sources WHERE owner_id=$1', [
      owner,
    ]);
    await pg.query('DELETE FROM local_ai_runs WHERE owner_id=$1', [owner]);
    await pg.query('DELETE FROM local_ai_threads WHERE owner_id=$1', [owner]);
    await conversations.close();
    await pg.end();
    ws.close();
    store.close();
  });
  return {
    owner,
    pg,
    ws,
    store,
    dot,
    memory,
    invoke,
    add,
    advance: (ms = 120000) => (now += ms),
  };
}
integration(
  'cancels a recovered automatic Dream under current settings before inference',
  async () => {
    const f = await fixture();
    await f.add('t', 'I prefer concise answers.');
    const source = await f.memory.requestDream(f.dot.id, ['t']);
    await f.pg.query(
      "UPDATE memory_jobs SET origin='automatic',admitted_day='2026-10-17' WHERE owner_id=$1 AND id=$2",
      [f.owner, source.id],
    );
    await f.memory.jobs.claim();
    const settings = f.ws.memory.settings(f.dot.id);
    await f.memory.updateSettings(f.dot.id, settings.revision, {
      learningEnabled: false,
    });
    expect((await f.memory.jobs.get(source.id))?.state).toBe('cancelled');
    await f.memory.tick(f.advance());
    expect(f.invoke).not.toHaveBeenCalled();
  },
);
integration(
  'does not admit automatic Dream from a thread waiting for approval',
  async () => {
    const f = await fixture();
    await f.add('approval', 'I prefer weekly reports.', true);
    vi.spyOn(f.memory.jobs, 'claim').mockResolvedValue(undefined);
    await f.memory.tick(f.advance());
    expect(
      (await f.memory.jobs.list(f.dot.id)).filter((j) => j.kind === 'dream'),
    ).toHaveLength(0);
  },
);
integration(
  'defers an already admitted automatic Dream when approval becomes pending',
  async () => {
    const f = await fixture();
    await f.add('t', 'I prefer concise answers.');
    const job = await f.memory.requestDream(f.dot.id, ['t']);
    await f.pg.query(
      "UPDATE memory_jobs SET origin='automatic',admitted_day='2026-10-17' WHERE owner_id=$1 AND id=$2",
      [f.owner, job.id],
    );
    await f.add('t', 'Save only after approval.', true);
    await f.memory.tick(f.advance());
    await vi.waitFor(async () =>
      expect((await f.memory.jobs.get(job.id))?.state).not.toBe('running'),
    );
    expect(f.invoke).not.toHaveBeenCalled();
    expect((await f.memory.jobs.get(job.id))?.state).toBe('queued');
  },
);
integration(
  'advances bounded scans past revoked runs and chunks and includes long Unicode evidence',
  async () => {
    const f = await fixture();
    const page = f.ws.pages.create(f.dot.spaceId, {
        title: 'Removed',
        content: 'private',
      }),
      guard = {
        originDotId: f.dot.id,
        spaceIds: [f.dot.spaceId],
        pageIds: [page.id],
      };
    const blocked = await f.add(
      'blocked',
      'Private context. '.repeat(11000),
      false,
      guard,
    );
    await f.memory.repository.indexRun(blocked);
    const valid = await f.add('valid', '你好世界'.repeat(2000));
    // These newer, unindexable runs must not permanently starve valid evidence.
    for (let i = 0; i < 6; i++)
      await f.add('bad' + i, 'Unavailable source', false, guard);
    f.ws.pages.delete(f.dot.spaceId, page.id);
    let found = false;
    for (let i = 0; i < 8; i++) {
      const job = await f.memory.requestDream(f.dot.id, [
        'blocked',
        'valid',
        ...Array.from({ length: 6 }, (_, j) => 'bad' + j),
      ]);
      for (const id of job.sourceIds) {
        const source = await f.memory.repository.sourceById(id);
        if (source?.source.runId === valid) {
          found = true;
          expect(Buffer.byteLength(source.text)).toBeLessThanOrEqual(4000);
        }
      }
    }
    expect(found).toBe(true);
  },
);
integration(
  'does not publish Compact after losing its durable lease',
  async () => {
    const f = await fixture();
    await f.add('t', 'Context');
    const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
      id: 'm' + i,
      role: i % 2 ? 'assistant' : 'user',
      content: 'task',
    }));
    await f.pg.query(
      'UPDATE local_ai_threads SET messages=$3::jsonb WHERE owner_id=$1 AND id=$2',
      [f.owner, 't', JSON.stringify(messages)],
    );
    const job = await f.memory.requestCompact('t');
    const save = f.memory.repository.saveCheckpoint.bind(f.memory.repository);
    vi.spyOn(f.memory.repository, 'saveCheckpoint').mockImplementation(
      async (...args) => {
        await f.pg.query(
          "UPDATE memory_jobs SET lease_token='new-owner' WHERE owner_id=$1 AND id=$2",
          [f.owner, job.id],
        );
        return save(...args);
      },
    );
    f.invoke.mockImplementation(async () => {
      return {
        result: {
          goal: 'Task',
          constraints: [],
          decisions: [],
          completedWork: [],
          openQuestions: [],
          nextSteps: [],
          evidenceMessageIds: [],
        } as never,
        usage: {},
      };
    });
    await f.memory.tick();
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalled());
    await vi.waitFor(async () =>
      expect((await f.memory.status(f.dot.id)).activeJobId).toBeNull(),
    );
    expect(await f.memory.repository.latestCheckpoint('t')).toBeUndefined();
  },
);
it('defines each memory environment setting once', () => {
  const names = readFileSync('.env.example', 'utf8')
    .split('\n')
    .filter((line) => /^MEMORY_/.test(line))
    .map((line) => line.split('=')[0]);
  expect(names.length).toBe(new Set(names).size);
});
