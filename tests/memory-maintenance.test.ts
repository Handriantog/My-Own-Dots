import type { MemoryJobs } from '../src/server/memory-jobs.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import type { Message } from '@ag-ui/core';
import { PostgresConversations } from '../src/server/local-conversations.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  MemoryMaintenance,
  learningDayKey,
} from '../src/server/memory-maintenance.js';
import type { AgentOptions } from 'myown-llm-integrator';

it('uses the configured local day across DST and rejects an invalid time zone', () => {
  expect(
    learningDayKey(Date.parse('2026-11-01T05:30:00Z'), 'America/New_York'),
  ).toBe('2026-11-01');
  expect(
    learningDayKey(Date.parse('2026-11-01T06:30:00Z'), 'America/New_York'),
  ).toBe('2026-11-01');
  expect(
    learningDayKey(Date.parse('2026-11-02T04:30:00Z'), 'America/New_York'),
  ).toBe('2026-11-01');
  expect(() => learningDayKey(Date.now(), 'invalid/zone')).toThrow();
});
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'admits one idle compaction, coalesces boundaries, and supports a manual Dream while learning is off',
  async () => {
    const owner = randomUUID(),
      pg = new Pool({ connectionString: process.env.LOCAL_TEST_DATABASE_URL });
    const conversations = new PostgresConversations(
        process.env.LOCAL_TEST_DATABASE_URL!,
        owner,
      ),
      ws = new WorkspaceStore(':memory:', owner),
      store = new Store(':memory:');
    let now = Date.now();
    const calls: string[] = [];
    const invoke = async (options: AgentOptions) => {
      calls.push(options.prompt.includes('for compact') ? 'compact' : 'dream');
      return {
        result: options.prompt.includes('for compact')
          ? {
              goal: 'Finish task',
              constraints: [],
              decisions: [],
              completedWork: [],
              openQuestions: [],
              nextSteps: [],
              evidenceMessageIds: [],
            }
          : {
              kind: 'proposal',
              changes: [],
              noChangeReason: 'Nothing durable',
            },
        usage: {},
      };
    };
    const memory = new MemoryMaintenance(
      store,
      ws,
      {
        localDatabaseUrl: process.env.LOCAL_TEST_DATABASE_URL,
        llmProvider: 'claude-code',
      },
      { pg, clock: () => now, invoke },
    );
    const dot = ws.dots()[0];
    ws.bindThread('t', dot.id, 'Long task');
    try {
      await conversations.initialize();
      memory.start();
      await conversations.getOrCreateThread({
        threadId: 't',
        userId: owner,
        agentId: dot.id,
      });
      const messages: Message[] = [];
      for (let i = 0; i < 8; i++) {
        messages.push({
          id: 'u' + i,
          role: 'user',
          content: 'Please help with this task.',
        });
        const lease = (await conversations.acquireThread('t'))!;
        await lease.beginRun(
          {
            threadId: 't',
            runId: 'r' + i,
            messages: structuredClone(messages),
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
          },
          { originDotId: dot.id, spaceIds: [], pageIds: [] },
        );
        messages.push({
          id: 'a' + i,
          role: 'assistant',
          content: 'Completed this step.',
        });
        await lease.finishRun(messages, {}, 'finished');
        await lease.release();
      }
      const historyReads = vi.spyOn(pg, 'query');
      const historyCount = () =>
        historyReads.mock.calls.filter((call) =>
          /SELECT (?:t\.)?messages(?:,| FROM)/.test(String(call[0])),
        ).length;
      await memory.tick(now + 119998);
      const readCount = historyCount();
      await memory.tick(now + 119999);
      expect(historyCount()).toBe(readCount);
      expect(readCount).toBeGreaterThan(0);
      expect(calls).toEqual([]);
      now += 120000;
      await memory.tick(now);
      await vi.waitFor(() => expect(calls).toEqual(['compact']));
      await vi.waitFor(async () =>
        expect((await memory.jobs.list(dot.id))[0].state).toBe('succeeded'),
      );
      await memory.tick(now + 60000);
      expect(calls).toEqual(['compact']);
      expect((await memory.requestCompact('t')).id).toBe(
        (await memory.requestCompact('t')).id,
      );
      const dream = await memory.requestDream(dot.id);
      expect(dream.publicationPolicy).toBe('review_all');
      await memory.tick(now);
      await vi.waitFor(async () =>
        expect((await memory.jobs.get(dream.id))?.state).toBe('succeeded'),
      );
      expect(calls).toContain('dream');
      expect(ws.memory.history.receipt(dream.id)?.changes).toEqual([]);
      store.updateSettings({ memoryAllowed: false });
      await expect(memory.requestDream(dot.id)).rejects.toThrow(/disabled/);
    } finally {
      await memory.stop();
      await pg.query('DELETE FROM memory_jobs WHERE owner_id=$1', [owner]);
      await pg.query('DELETE FROM local_ai_runs WHERE owner_id=$1', [owner]);
      await pg.query('DELETE FROM local_ai_threads WHERE owner_id=$1', [owner]);
      ws.close();
      store.close();
      await conversations.close();
      await pg.end();
    }
  },
  15000,
);

it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'gates automatic jobs by thresholds, approvals, enrollment and idle time; recovers receipts without inference',
  async () => {
    const owner = randomUUID(),
      pg = new Pool({ connectionString: process.env.LOCAL_TEST_DATABASE_URL });
    const conversations = new PostgresConversations(
        process.env.LOCAL_TEST_DATABASE_URL!,
        owner,
      ),
      ws = new WorkspaceStore(':memory:', owner),
      store = new Store(':memory:');
    let now = Date.now();
    const started = now;
    const memory = new MemoryMaintenance(
      store,
      ws,
      {
        localDatabaseUrl: process.env.LOCAL_TEST_DATABASE_URL,
        llmProvider: 'claude-code',
      },
      {
        pg,
        clock: () => now,
        invoke: async () => {
          throw new Error('Unexpected inference');
        },
      },
    );
    const dot = ws.dots()[0];
    try {
      await conversations.initialize();
      for (const [id, size, pending] of [
        ['threshold', 1200, false],
        ['idle', 300, false],
        ['pending', 1200, true],
        ['small', 2, false],
      ] as const) {
        ws.bindThread(id, dot.id, id);
        await conversations.getOrCreateThread({
          threadId: id,
          userId: owner,
          agentId: dot.id,
        });
        const messages: Message[] = Array.from({ length: 16 }, (_, i) => ({
          id: id + i,
          role: i % 2 ? 'assistant' : 'user',
          content: 'x'.repeat(size),
        }));
        if (pending)
          messages.push({
            id: 'approval',
            role: 'assistant',
            toolCalls: [
              {
                id: 'call',
                type: 'function',
                function: { name: 'review_space_page', arguments: '{}' },
              },
            ],
          });
        const lease = (await conversations.acquireThread(id))!;
        await lease.beginRun(
          {
            threadId: id,
            runId: id,
            messages,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
          },
          { originDotId: dot.id, spaceIds: [], pageIds: [] },
        );
        await lease.finishRun(messages, {}, 'finished');
        await lease.release();
      }
      // Observe durable admissions without starting a provider worker.
      const claim = vi.spyOn(memory.jobs, 'claim').mockResolvedValue(undefined);
      await memory.tick(now);
      expect((await memory.jobs.list(dot.id)).map((j) => j.threadId)).toEqual([
        'threshold',
      ]);
      now += 120000;
      await memory.tick(now);
      expect(
        (await memory.jobs.list(dot.id)).map((j) => j.threadId).sort(),
      ).toEqual(['idle', 'threshold']);
      let settings = ws.memory.settings(dot.id);
      settings = await memory.updateSettings(dot.id, settings.revision, {
        learningEnabled: true,
        autoCompact: false,
        dreamIntervalMs: 120000,
        dreamIdleMs: 300000,
      });
      now += 120000;
      await memory.tick(now);
      expect(
        (await memory.jobs.list(dot.id)).filter((j) => j.kind === 'dream'),
      ).toHaveLength(0);
      // Explicit new completion after enrollment is eligible; old episodes are not.
      await pg.query(
        "UPDATE memory_evidence SET completed_at=$2 WHERE owner_id=$1 AND thread_id='small'",
        [owner, now],
      );
      now += 180000;
      await memory.tick(now);
      const dreams = (await memory.jobs.list(dot.id)).filter(
        (j) => j.kind === 'dream',
      );
      expect(dreams).toHaveLength(1);
      expect(dreams[0].sourceIds).toHaveLength(16);
      await memory.tick(now + 1000);
      expect(
        (await memory.jobs.list(dot.id)).filter((j) => j.kind === 'dream'),
      ).toHaveLength(1);
      await memory.updateSettings(dot.id, settings.revision, {
        autoDream: false,
      });
      expect((await memory.jobs.get(dreams[0].id))?.state).toBe('cancelled');
      const manual = await memory.requestDream(dot.id, ['small']);
      ws.memory.history.saveReceipt({
        id: randomUUID(),
        jobId: manual.id,
        dotId: dot.id,
        createdAt: now,
        changes: [],
      });
      await pg.query(
        'UPDATE memory_jobs SET model_calls=3 WHERE owner_id=$1 AND id=$2',
        [owner, manual.id],
      );
      claim.mockRestore();
      store.updateSettings({ paused: true });
      await memory.tick(now);
      expect((await memory.jobs.get(manual.id))?.state).toBe('succeeded');
      expect(now - started).toBe(420000);
    } finally {
      await memory.stop();
      await pg.query('DELETE FROM memory_jobs WHERE owner_id=$1', [owner]);
      await pg.query('DELETE FROM memory_daily_admissions WHERE owner_id=$1', [
        owner,
      ]);
      await pg.query('DELETE FROM memory_processed_sources WHERE owner_id=$1', [
        owner,
      ]);
      await pg.query('DELETE FROM local_ai_runs WHERE owner_id=$1', [owner]);
      await pg.query('DELETE FROM local_ai_threads WHERE owner_id=$1', [owner]);
      await conversations.close();
      await pg.end();
      ws.close();
      store.close();
    }
  },
);

it('queues background scans behind snapshots and cancels admission on stop', async () => {
  const { MaintenanceGate } =
    await import('../src/server/storage/maintenance.js');
  const gate = new MaintenanceGate();
  const pg = new Pool();
  const query = vi.spyOn(pg, 'query').mockResolvedValue({ rows: [] } as never);
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'admission-owner');
  const memory = new MemoryMaintenance(
    store,
    ws,
    {},
    { pg, maintenance: gate },
  );
  const lease = await gate.acquire({
    origin: 'manual',
    signal: new AbortController().signal,
  });
  const ticking = memory.tick();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(query).not.toHaveBeenCalled();
    memory.pause();
  } finally {
    lease.release();
  }
  await ticking;
  await memory.stop();
  expect(query).not.toHaveBeenCalled();
  ws.close();
  store.close();
  await pg.end();
});

it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'drains Dream publication through the final PostgreSQL acknowledgement',
  async () => {
    const { MaintenanceGate } =
      await import('../src/server/storage/maintenance.js');
    const gate = new MaintenanceGate();
    const owner = randomUUID();
    const pg = new Pool({
      connectionString: process.env.LOCAL_TEST_DATABASE_URL,
    });
    const conversations = new PostgresConversations(
      process.env.LOCAL_TEST_DATABASE_URL!,
      owner,
    );
    const store = new Store(':memory:');
    const ws = new WorkspaceStore(':memory:', owner);
    const memory = new MemoryMaintenance(
      store,
      ws,
      {},
      { pg, maintenance: gate },
    );
    const dot = ws.dots()[0];
    let releaseAck!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const acknowledge = (memory.jobs as MemoryJobs).acknowledge.bind(
      memory.jobs,
    );
    const ack = vi
      .spyOn(memory.jobs as MemoryJobs, 'acknowledge')
      .mockImplementation(async (...args) => {
        await blocked;
        return acknowledge(...args);
      });
    try {
      await conversations.initialize();
      const job = await memory.requestDream(dot.id);
      await memory.tick();
      await vi.waitFor(() =>
        expect(ack).toHaveBeenCalledWith(job.id, {
          lease: expect.any(String),
          generation: 1,
        }),
      );
      expect(ws.memory.history.receipt(job.id)).toBeDefined();
      let captured = false;
      const pending = gate
        .acquire({ origin: 'manual', signal: new AbortController().signal })
        .then((lease) => {
          captured = true;
          return lease;
        });
      await new Promise((resolve) => setImmediate(resolve));
      expect(captured).toBe(false);
      releaseAck();
      const lease = await pending;
      expect((await memory.jobs.get(job.id))?.state).toBe('succeeded');
      lease.release();
    } finally {
      releaseAck();
      await memory.stop();
      await pg.query('DELETE FROM memory_jobs WHERE owner_id=$1', [owner]);
      ws.close();
      store.close();
      await conversations.close();
      await pg.end();
    }
  },
);
