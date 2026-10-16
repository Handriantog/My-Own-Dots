import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { MemoryMaintenance } from '../src/server/memory-maintenance.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { PostgresConversations } from '../src/server/local-conversations.js';
import type { AgentOptions } from 'myown-llm-integrator';
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'recovers exactly one SQLite publication after acknowledgement fails and the process restarts',
  async () => {
    const owner = randomUUID(),
      dir = await mkdtemp(join(tmpdir(), 'dots-memory-recovery-')),
      pg = new Pool({ connectionString: process.env.LOCAL_TEST_DATABASE_URL });
    const store = new Store(join(dir, 'app.sqlite'));
    let ws = new WorkspaceStore(join(dir, 'workspace.sqlite'), owner);
    const config = {
      localDatabaseUrl: process.env.LOCAL_TEST_DATABASE_URL,
      llmProvider: 'claude-code',
    };
    const invoke = vi.fn(async (options: AgentOptions) => {
      const evidence = JSON.parse(options.prompt.split('\n').at(-1)!).evidence;
      const user = evidence.find((s: { role: string }) => s.role === 'user');
      return {
        result: {
          kind: 'proposal',
          changes: [
            {
              kind: 'create',
              title: 'Answer style',
              text: user.text,
              sourceIds: [user.id],
              support: 'explicit_user',
              justification: 'Direct user preference',
              retention: 'stable',
              expiresAt: null,
            },
          ],
          noChangeReason: null,
        },
        usage: {},
      };
    });
    let service = new MemoryMaintenance(store, ws, config, { pg, invoke });
    const conversations = new PostgresConversations(
        process.env.LOCAL_TEST_DATABASE_URL!,
        owner,
      ),
      dot = ws.dots()[0];
    try {
      await conversations.initialize();
      await service.updateSettings(dot.id, 1, {
        learningEnabled: true,
        autoCompact: false,
        autoDream: false,
      });
      ws.bindThread('t', dot.id, 'Short chat');
      await conversations.getOrCreateThread({
        threadId: 't',
        userId: owner,
        agentId: dot.id,
      });
      const lease = (await conversations.acquireThread('t'))!;
      const messages = [
        {
          id: 'u',
          role: 'user' as const,
          content: 'I prefer concise replies.',
        },
        { id: 'a', role: 'assistant' as const, content: 'Understood.' },
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
        { originDotId: dot.id, spaceIds: [], pageIds: [] },
      );
      await lease.finishRun(messages, {}, 'finished');
      await lease.release();
      const job = await service.requestDream(dot.id, ['t']);
      const acknowledge = vi
        .spyOn(service.jobs, 'acknowledge')
        .mockRejectedValue(
          new Error('Injected process failure after SQLite commit'),
        );
      await service.tick();
      await vi.waitFor(() =>
        expect(ws.memory.history.receipt(job.id)).toBeDefined(),
      );
      await vi.waitFor(async () =>
        expect((await service.jobs.get(job.id))?.state).toBe('queued'),
      );
      const receipt = ws.memory.history.receipt(job.id)!,
        item = receipt.changes[0].after;
      await service.stop();
      acknowledge.mockRestore();
      ws.close();
      ws = new WorkspaceStore(join(dir, 'workspace.sqlite'), owner);
      service = new MemoryMaintenance(store, ws, config, { pg, invoke });
      await service.tick();
      expect((await service.jobs.get(job.id))?.state).toBe('succeeded');
      expect(ws.memory.history.receipt(job.id)?.id).toBe(receipt.id);
      expect(ws.memory.revisions(item.id)).toHaveLength(1);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(
        (
          await pg.query(
            'SELECT count(*) AS n FROM memory_processed_sources WHERE owner_id=$1',
            [owner],
          )
        ).rows[0].n,
      ).toBe('2');
      const missing = vi
        .spyOn(service.repository, 'readSource')
        .mockRejectedValue(new Error('Storage failed'));
      await expect(service.recall.read(dot.id, item.id)).rejects.toThrow(
        'Storage failed',
      );
      expect(ws.memory.revisions(item.id)).toHaveLength(1);
      missing.mockRestore();
    } finally {
      await service.stop();
      for (const table of [
        'memory_processed_sources',
        'memory_jobs',
        'local_ai_runs',
        'local_ai_threads',
        'memory_index_meta',
      ])
        await pg.query(`DELETE FROM ${table} WHERE owner_id=$1`, [owner]);
      await conversations.close();
      await pg.end();
      ws.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  15000,
);
