import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import type { Message } from '@ag-ui/core';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { PostgresConversations } from '../src/server/local-conversations.js';
import { MemoryMaintenance } from '../src/server/memory-maintenance.js';
import { renderSubscriptionPrompt } from '../src/server/subscription-prompt.js';
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'withholds revoked page history, deleted-page checkpoints and known recalled copies while keeping canonical protocol',
  async () => {
    const owner = randomUUID(),
      pg = new Pool({ connectionString: process.env.LOCAL_TEST_DATABASE_URL }),
      ws = new WorkspaceStore(':memory:', owner),
      store = new Store(':memory:');
    const conversations = new PostgresConversations(
        process.env.LOCAL_TEST_DATABASE_URL!,
        owner,
      ),
      memory = new MemoryMaintenance(
        store,
        ws,
        { localDatabaseUrl: process.env.LOCAL_TEST_DATABASE_URL },
        {
          pg,
          invoke: async () => ({
            result: {
              goal: 'Deleted page SECRET',
              constraints: [],
              decisions: [],
              completedWork: [],
              openQuestions: [],
              nextSteps: [],
              evidenceMessageIds: ['m0'],
            },
            usage: {},
          }),
        },
      );
    const dot = ws.dots()[0],
      page = ws.pages.create(dot.spaceId, {
        title: 'Secret',
        content: 'Deleted page SECRET',
      });
    const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
      id: 'm' + i,
      role: i % 2 ? 'assistant' : 'user',
      content: 'Deleted page SECRET',
    }));
    const saved = ws.memory.create({
      scope: { kind: 'dot', id: dot.id },
      title: 'Recalled fact',
      text: 'Recalled SECRET',
    });
    try {
      await conversations.initialize();
      ws.bindThread('t', dot.id, 'Private history');
      await conversations.getOrCreateThread({
        threadId: 't',
        userId: owner,
        agentId: dot.id,
      });
      let lease = (await conversations.acquireThread('t'))!;
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
        { originDotId: dot.id, spaceIds: [dot.spaceId], pageIds: [page.id] },
      );
      await lease.finishRun(messages, {}, 'finished');
      await lease.release();
      await memory.compaction.compact('t', new AbortController().signal);
      const project = async () =>
        renderSubscriptionPrompt(
          await memory.context.project(
            {
              systemPrompts: [],
              messages: messages.map((m) => ({
                ...m,
                role: m.role as 'user' | 'assistant' | 'tool',
                content: String(m.content),
              })),
              availableTools: [],
            },
            {
              ownerId: owner,
              dotId: dot.id,
              threadId: 't',
              runId: 'next',
              canonicalMessages: messages,
            },
            new AbortController().signal,
          ),
        );
      expect(await project()).toContain('Deleted page SECRET');
      vi.spyOn(memory.context, 'essentials').mockImplementationOnce(
        async () => {
          ws.pages.delete(dot.spaceId, page.id);
          return [];
        },
      );
      expect(await project()).not.toContain('Deleted page SECRET');
      expect(await memory.repository.threadMessages('t')).toEqual(messages);
      ws.bindThread('copies', dot.id, 'Recall copy');
      await conversations.getOrCreateThread({
        threadId: 'copies',
        userId: owner,
        agentId: dot.id,
      });
      lease = (await conversations.acquireThread('copies'))!;
      const copies: Message[] = [
        {
          id: 'call',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'tc',
              type: 'function',
              function: {
                name: 'read_memory',
                arguments: JSON.stringify({ id: saved.id }),
              },
            },
          ],
        },
        {
          id: 'copy',
          role: 'tool',
          toolCallId: 'tc',
          content: 'Recalled SECRET',
        },
      ];
      await lease.beginRun(
        {
          threadId: 'copies',
          runId: 'copy-run',
          messages: copies,
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        },
        {
          originDotId: dot.id,
          spaceIds: [],
          pageIds: [],
          memoryItemIds: [saved.id],
        } as never,
      );
      await lease.finishRun(copies, {}, 'finished');
      await lease.release();
      memory.publication.forget(saved.id, saved.revision);
      const projected = await memory.context.project(
        {
          systemPrompts: [],
          messages: copies.map((m) => ({
            ...m,
            role: m.role as 'user' | 'assistant' | 'tool',
            content: String(m.content),
          })),
          availableTools: [],
        },
        {
          ownerId: owner,
          dotId: dot.id,
          threadId: 'copies',
          runId: 'later',
          canonicalMessages: copies,
        },
        new AbortController().signal,
      );
      expect(renderSubscriptionPrompt(projected)).not.toContain(
        'Recalled SECRET',
      );
      expect(projected.messages[1].toolCallId).toBe('tc');
    } finally {
      await memory.stop();
      await pg.query('DELETE FROM local_ai_runs WHERE owner_id=$1', [owner]);
      await pg.query('DELETE FROM local_ai_threads WHERE owner_id=$1', [owner]);
      await conversations.close();
      await pg.end();
      ws.close();
      store.close();
    }
  },
);
