import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import type { Message, RunAgentInput } from '@ag-ui/core';
import { PostgresConversations } from '../src/server/local-conversations.js';
import {
  ConversationMemory,
  evidenceHash,
} from '../src/server/conversation-memory.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { pageAccess, pageTools } from '../src/server/page-tools.js';

it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'indexes only bound, guarded evidence once and retains page provenance after deletion',
  async () => {
    const owner = randomUUID();
    const pg = new Pool({
      connectionString: process.env.LOCAL_TEST_DATABASE_URL,
    });
    const conversations = new PostgresConversations(
      process.env.LOCAL_TEST_DATABASE_URL!,
      owner,
    );
    const workspace = new WorkspaceStore(':memory:', owner);
    const dot = workspace.dots()[0];
    const repository = new ConversationMemory(pg, owner, workspace);
    const page = workspace.pages.create(dot.spaceId, {
      title: 'Launch',
      content: 'secret launch facts',
    });
    try {
      await conversations.initialize();
      await repository.initialize();
      for (const [threadId, bound, guarded] of [
        ['thread', true, true],
        ['unbound', false, true],
        ['legacy', true, false],
      ] as const) {
        if (bound) workspace.bindThread(threadId, dot.id, 'Test');
        await conversations.getOrCreateThread({
          threadId,
          userId: owner,
          agentId: dot.id,
        });
        const lease = (await conversations.acquireThread(threadId))!;
        const input: RunAgentInput = {
          threadId,
          runId: `run-${threadId}`,
          messages: [
            { id: 'u', role: 'user', content: 'Remember launch SKU-001' },
          ],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        };
        const guard = { originDotId: dot.id, spaceIds: [], pageIds: [] };
        await lease.beginRun(input, guarded ? guard : undefined);
        if (guarded)
          await lease.addEvidenceGuard!({
            ...guard,
            spaceIds: [page.spaceId],
            pageIds: [page.id],
          });
        const messages: Message[] = [
          ...input.messages,
          { id: 'a', role: 'assistant', content: 'Recorded exact SKU-001' },
          {
            id: 't',
            role: 'tool',
            toolCallId: 'read',
            content: 'Delivery on October 20',
          },
        ];
        await lease.finishRun(messages, {}, 'finished');
        await lease.release();
        if (threadId === 'thread') {
          const known = {
            threadId,
            runId: input.runId,
            messageIds: ['u'],
            contentHash: evidenceHash(input.messages[0]),
            guard: {
              originDotId: dot.id,
              spaceIds: [page.spaceId],
              pageIds: [page.id],
            },
            start: 0,
            end: 23,
          };
          expect(await repository.readSource(known)).toMatchObject({
            text: 'Remember launch SKU-001',
          });
        }
        await repository.indexRun(input.runId);
        await repository.indexRun(input.runId);
      }
      const found = await repository.searchEpisodes({
        allowedThreadIds: ['thread', 'legacy', 'unbound'],
        query: 'SKU-001',
      });
      expect(found.matches).toHaveLength(2);
      expect(
        found.matches.every((match) => match.source.threadId === 'thread'),
      ).toBe(true);
      expect(await repository.coverage(dot.id)).toMatchObject({
        indexedRuns: 1,
        eligibleRuns: 2,
        complete: false,
      });
      const source = found.matches[0];
      expect(await repository.readSource(source.source)).toMatchObject({
        guard: { pageIds: [page.id] },
      });
      expect(
        await repository.readSource({
          ...source.source,
          contentHash: 'f'.repeat(64),
        }),
      ).toBeUndefined();
      expect(
        (
          await repository.searchEpisodes({
            allowedThreadIds: ['thread'],
            query: 'Delivery',
          })
        ).matches[0].role,
      ).toBe('tool');
      workspace.pages.delete(page.spaceId, page.id);
      expect(await repository.readSource(source.source)).toBeUndefined();
      const persisted = await pg.query(
        'SELECT evidence_guard FROM local_ai_runs WHERE owner_id=$1 AND run_id=$2',
        [owner, 'run-thread'],
      );
      expect(persisted.rows[0].evidence_guard.pageIds).toContain(page.id);
    } finally {
      await pg.query('DELETE FROM local_ai_runs WHERE owner_id=$1', [owner]);
      await pg.query('DELETE FROM local_ai_threads WHERE owner_id=$1', [owner]);
      workspace.close();
      await conversations.close();
      await pg.end();
    }
  },
);

it('waits for durable page provenance before returning tool content', async () => {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Test');
  const page = workspace.pages.create(dot.spaceId, {
    title: 'Private',
    content: 'private evidence',
  });
  const recorded: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tools = pageTools(
    await pageAccess(workspace, dot.spaceId, 'thread', () => {}),
    async (guard) => {
      await gate;
      recorded.push(guard);
    },
  );
  const read = tools.find((tool) => tool.name === 'read_space_page')!;
  let delivered = false;
  const result = Promise.resolve(read.execute!({ id: page.id } as never)).then(
    (value) => {
      delivered = true;
      return value;
    },
  );
  await Promise.resolve();
  expect(delivered).toBe(false);
  release();
  expect(await result).toMatchObject({ content: 'private evidence' });
  expect(recorded).toEqual([{ spaceIds: [page.spaceId], pageIds: [page.id] }]);
  workspace.close();
});

it('keeps evidence fingerprints stable when JSON storage reorders object keys', () => {
  expect(
    evidenceHash({
      id: 'm',
      role: 'user',
      content: 'Keep exact value',
      nested: { a: 1, b: 2 },
    }),
  ).toBe(
    evidenceHash({
      nested: { b: 2, a: 1 },
      content: 'Keep exact value',
      role: 'user',
      id: 'm',
    }),
  );
});
