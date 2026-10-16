import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { MemoryJobs } from '../src/server/memory-jobs.js';
import { PostgresConversations } from '../src/server/local-conversations.js';
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'coalesces jobs and persists lease, call, retry, and elapsed limits across restart',
  async () => {
    const owner = randomUUID(),
      pg = new Pool({ connectionString: process.env.LOCAL_TEST_DATABASE_URL });
    const conversations = new PostgresConversations(
      process.env.LOCAL_TEST_DATABASE_URL!,
      owner,
    );
    let now = Date.now();
    try {
      await conversations.initialize();
      const jobs = new MemoryJobs(pg, owner, () => now);
      const input = {
        kind: 'dream' as const,
        dotId: 'dot',
        origin: 'manual' as const,
        sourceIds: ['evidence'],
        logicalKey: 'one',
      };
      const one = await jobs.enqueue(input);
      expect((await jobs.enqueue(input)).id).toBe(one.id);
      const claim = (await jobs.claim(now))!;
      expect(claim.state).toBe('running');
      await jobs.recordUsage(claim.id, claim.leaseToken!, {
        modelCalls: 1,
        elapsedMs: 50,
      });
      await jobs.recordUsage(claim.id, claim.leaseToken!, {
        modelCalls: 1,
        elapsedMs: 60,
      });
      now += 61000;
      const reopened = new MemoryJobs(pg, owner, () => now);
      const second = (await reopened.claim(now))!;
      expect(second.modelCalls).toBe(2);
      expect(second.elapsedMs).toBe(110);
      await expect(
        jobs.settle(claim.id, claim.leaseToken!, { state: 'succeeded' }),
      ).rejects.toThrow(/lease/i);
      await reopened.recordUsage(second.id, second.leaseToken!, {
        modelCalls: 1,
        elapsedMs: 10,
      });
      await reopened.settle(second.id, second.leaseToken!, {
        state: 'queued',
        dueAt: now + 30000,
        error: 'transient',
      });
      now += 30000;
      expect(await reopened.claim(now)).toBeUndefined();
      expect((await reopened.get(one.id))?.state).toBe('failed');
      const interrupted = await reopened.enqueue({
        ...input,
        logicalKey: 'crash',
      });
      const inflight = (await reopened.claim(now))!;
      await reopened.recordUsage(inflight.id, inflight.leaseToken!, {
        modelCalls: 1,
      });
      now += 301000;
      expect(await reopened.claim(now)).toBeUndefined();
      expect(
        (await reopened.get(interrupted.id))?.elapsedMs,
      ).toBeGreaterThanOrEqual(300000);
    } finally {
      await pg.query('DELETE FROM memory_jobs WHERE owner_id=$1', [owner]);
      await conversations.close();
      await pg.end();
    }
  },
);
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'saves completion evidence in the run transaction without treating pending approvals as workflow success',
  async () => {
    const owner = randomUUID(),
      pg = new Pool({ connectionString: process.env.LOCAL_TEST_DATABASE_URL });
    const conversations = new PostgresConversations(
      process.env.LOCAL_TEST_DATABASE_URL!,
      owner,
    );
    try {
      await conversations.initialize();
      await conversations.getOrCreateThread({
        threadId: 't',
        userId: owner,
        agentId: 'dot',
      });
      const lease = (await conversations.acquireThread('t'))!;
      const messages = [
        { id: 'u', role: 'user' as const, content: 'Please review' },
        {
          id: 'a',
          role: 'assistant' as const,
          toolCalls: [
            {
              id: 'pending',
              type: 'function' as const,
              function: { name: 'review_space_page', arguments: '{}' },
            },
          ],
        },
      ];
      await lease.beginRun(
        {
          threadId: 't',
          runId: 'r',
          messages,
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        },
        { originDotId: 'dot', spaceIds: [], pageIds: [] },
      );
      await lease.finishRun(messages, {}, 'finished');
      await lease.release();
      const evidence = await pg.query(
        'SELECT workflow_complete FROM memory_evidence WHERE owner_id=$1',
        [owner],
      );
      expect(evidence.rows).toEqual([{ workflow_complete: false }]);
    } finally {
      await pg.query('DELETE FROM local_ai_runs WHERE owner_id=$1', [owner]);
      await pg.query('DELETE FROM local_ai_threads WHERE owner_id=$1', [owner]);
      await conversations.close();
      await pg.end();
    }
  },
);
