import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import type { Message } from '@ag-ui/core';
import { PostgresConversations } from '../src/server/local-conversations.js';
import {
  ConversationMemory,
  evidenceHash,
} from '../src/server/conversation-memory.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';
import { MemoryAccess } from '../src/server/memory-access.js';
import { MemoryRecall } from '../src/server/memory-recall.js';
import { ContextBuilder } from '../src/server/context-builder.js';
import { ContextCompaction } from '../src/server/context-compaction.js';
import { MemoryInference } from '../src/server/memory-inference.js';
import { renderSubscriptionPrompt } from '../src/server/subscription-prompt.js';
import type { runAgent } from 'myown-llm-integrator';

it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'compacts source-backed prefixes across restart while preserving exact constraints, pending calls, and canonical history',
  async () => {
    const owner = randomUUID(),
      pg = new Pool({ connectionString: process.env.LOCAL_TEST_DATABASE_URL });
    const conversations = new PostgresConversations(
        process.env.LOCAL_TEST_DATABASE_URL!,
        owner,
      ),
      ws = new WorkspaceStore(':memory:', owner),
      store = new Store(':memory:');
    const dot = ws.dots()[0];
    ws.bindThread('t', dot.id, 'Long task');
    const repository = new ConversationMemory(pg, owner, ws);
    const messages: Message[] = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 ? 'assistant' : 'user',
      content: `Other task detail ${i}`,
    }));
    messages[0].content = 'Original budget $123';
    messages[100].content = 'Correction: budget is $456';
    messages.push(
      {
        id: 'pending',
        role: 'assistant',
        toolCalls: [
          {
            id: 'approve',
            type: 'function',
            function: {
              name: 'review_space_page',
              arguments: '{"title":"Draft"}',
            },
          },
        ],
      },
      {
        id: 'latest',
        role: 'user',
        content: 'Wait for my approval before saving.',
      },
    );
    try {
      await conversations.initialize();
      await repository.initialize();
      await conversations.getOrCreateThread({
        threadId: 't',
        userId: owner,
        agentId: dot.id,
      });
      const lease = (await conversations.acquireThread('t'))!;
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
      const before = await conversations.getThreadMessages({
        threadId: 't',
        userId: owner,
      });
      const inference = new MemoryInference(
        { provider: 'codex' },
        (async () => ({
          result: {
            goal: 'Complete the task',
            constraints: ['Corrected budget $456; previous $123 superseded'],
            decisions: [],
            completedWork: [],
            openQuestions: ['Await approval'],
            nextSteps: ['Do not save before approval'],
            evidenceMessageIds: ['m0', 'm100'],
          },
          usage: {},
        })) as typeof runAgent,
      );
      const compact = new ContextCompaction(repository, inference);
      expect(await compact.compact('t', new AbortController().signal)).toBe(
        'updated',
      );
      const checkpoint = await new ConversationMemory(
        pg,
        owner,
        ws,
      ).latestCheckpoint('t');
      expect(checkpoint?.constraints.join(' ')).toContain('$456');
      expect(
        await conversations.getThreadMessages({ threadId: 't', userId: owner }),
      ).toEqual(before);
      const recall = new MemoryRecall(
        ws.memory,
        repository,
        new MemoryAccess(ws, store),
      );
      const context = new ContextBuilder(recall, {}, compact);
      const projected = await context.project(
        {
          systemPrompts: ['Trusted instructions'],
          messages: messages.map((m) => ({
            ...m,
            content: typeof m.content === 'string' ? m.content : null,
            role: m.role as 'user' | 'assistant' | 'tool',
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
      );
      expect(projected.messages.some((m) => m.id === 'm0')).toBe(false);
      expect(
        projected.messages.find((m) => m.id === 'pending')?.toolCalls?.[0].id,
      ).toBe('approve');
      expect(renderSubscriptionPrompt(projected)).toContain('$456');
      expect(renderSubscriptionPrompt(projected)).toContain(
        'Wait for my approval',
      );
      ws.memory.history.suppress(
        [
          {
            threadId: 't',
            runId: 'r',
            messageIds: ['m0'],
            contentHash: evidenceHash(messages[0]),
            guard: { originDotId: dot.id, spaceIds: [], pageIds: [] },
            start: 0,
            end: String(messages[0].content).length,
          },
        ],
        'Forgot original amount',
      );
      const afterForget = await context.project(
        {
          systemPrompts: [],
          messages: [
            { id: 'm0', role: 'user', content: 'Original budget $123' },
          ],
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
      );
      expect(renderSubscriptionPrompt(afterForget)).not.toContain('$123');
      // Appends do not invalidate the covered prefix; changed source bytes do.
      await pg.query(
        'UPDATE local_ai_threads SET messages=messages || $3::jsonb WHERE owner_id=$1 AND id=$2',
        [
          owner,
          't',
          JSON.stringify([
            { id: 'new', role: 'user', content: 'Another request' },
          ]),
        ],
      );
      expect(
        await repository.saveCheckpoint(checkpoint!, checkpoint!.sourceHash),
      ).toBe(true);
      await pg.query(
        "UPDATE local_ai_threads SET messages=jsonb_set(messages,'{0,content}','\"changed source\"') WHERE owner_id=$1 AND id=$2",
        [owner, 't'],
      );
      expect(
        await repository.saveCheckpoint(checkpoint!, checkpoint!.sourceHash),
      ).toBe(false);
      const changedPermissions = new ContextCompaction(
        repository,
        new MemoryInference({ provider: 'codex' }, (async () => {
          ws.updateDot(dot.id, { ...dot, memoryAllowed: false });
          return {
            result: {
              goal: 'Task',
              constraints: [],
              decisions: [],
              completedWork: [],
              openQuestions: [],
              nextSteps: [],
              evidenceMessageIds: ['m0'],
            },
            usage: {},
          };
        }) as typeof runAgent),
      );
      expect(
        await changedPermissions.compact('t', new AbortController().signal),
      ).toBe('stale');
      const controller = new AbortController();
      controller.abort();
      await expect(compact.compact('t', controller.signal)).rejects.toThrow();
      const bad = new ContextCompaction(
        repository,
        new MemoryInference({ provider: 'codex' }, (async () => ({
          result: { goal: 'Missing all required fields' },
          usage: {},
        })) as typeof runAgent),
      );
      await expect(
        bad.compact('t', new AbortController().signal),
      ).rejects.toThrow();
    } finally {
      await pg.query('DELETE FROM local_ai_runs WHERE owner_id=$1', [owner]);
      await pg.query('DELETE FROM local_ai_threads WHERE owner_id=$1', [owner]);
      ws.close();
      store.close();
      await conversations.close();
      await pg.end();
    }
  },
);
