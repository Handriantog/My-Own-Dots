import { memoryMetrics } from '../src/server/memory-metrics.js';
import { pageReviewTool } from '../src/shared/page-review.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
afterEach(() => vi.unstubAllEnvs());
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'learns a short chat, recalls exact corrected facts after restart, reviews a procedure, and suppresses restored evidence over real Python/SSE',
  async () => {
    vi.stubEnv(
      'AGENT_COMMAND_JSON',
      JSON.stringify([
        process.execPath,
        resolve('tests/fixtures/memory-provider.mjs'),
      ]),
    );
    const owner = 'memory-e2e-' + randomUUID(),
      store = new Store(':memory:'),
      ws = new WorkspaceStore(':memory:', owner);
    const config = {
      conversationBackend: 'local' as const,
      localDatabaseUrl: process.env.LOCAL_TEST_DATABASE_URL,
      llmBackend: 'subscription' as const,
      llmProvider: 'claude-code',
      baseUrl: '',
      runtimeUrl: 'http://localhost/api/copilotkit',
      voiceName: 'marin',
      slackUsers: [],
      webSearchProvider: 'disabled' as const,
    };
    let platform = new Platform(store, ws, config);
    const dot = ws.dots()[0];
    const make = (id: string) =>
      new ProxiedCopilotRuntimeAgent({
        runtimeUrl: config.runtimeUrl,
        agentId: dot.id,
        threadId: id,
        runtimeMode: 'sse',
        transport: 'rest',
        fetch: (url, init) => platform.handle(new Request(url, init)),
      });
    const chat = async (text: string) => {
      const thread = await platform.createConversation(
          dot.id,
          'Memory acceptance',
        ),
        agent = make(thread.id);
      agent.addMessage({ id: randomUUID(), role: 'user', content: text });
      const errors: string[] = [];
      await agent.runAgent(
        {},
        {
          onRunErrorEvent: ({ event }) => {
            errors.push(event.message);
          },
        },
      );
      expect(errors).toEqual([]);
      return { thread, agent };
    };
    const dream = async () => {
      const job = await platform.memory!.requestDream(dot.id);
      await platform.memory!.tick();
      await vi.waitFor(
        async () =>
          expect((await platform.memory!.jobs.get(job.id))?.state).toBe(
            'succeeded',
          ),
        { timeout: 15000 },
      );
      return ws.memory.history.receipt(job.id)!;
    };
    try {
      await platform.start();
      await platform.memory!.updateSettings(dot.id, 1, {
        learningEnabled: true,
        autoCompact: false,
        autoDream: false,
      });
      await chat('I prefer fixture concise reports.');
      const learned = await dream();
      expect(learned.changes[0].after.text).toBe(
        'I prefer fixture concise reports.',
      );
      expect(
        (await chat('recall-fixture fixture')).agent.messages.findLast(
          (m) => m.role === 'assistant',
        )?.content,
      ).toContain('concise reports');
      await chat('Correction: I prefer fixture detailed reports.');
      const corrected = await dream();
      expect(ws.memory.get(learned.changes[0].after.id)?.status).toBe(
        'superseded',
      );
      await platform.stop();
      platform = new Platform(store, ws, config);
      await platform.start();
      const answer = (
        await chat('recall-fixture fixture')
      ).agent.messages.findLast((m) => m.role === 'assistant')?.content;
      expect(answer).toContain('detailed reports');
      expect(answer).not.toContain('concise reports');
      const first = await chat('That worked; use this workflow again.'),
        second = await chat('That worked; use this workflow again.');
      const skills = await dream();
      const skill = skills.changes.find((c) => c.after.kind === 'skill')!.after;
      expect(skill.status).toBe('pending');
      await platform.memory!.publication.review(
        skill.id,
        skill.revision,
        'approve',
      );
      expect(
        (await chat('recall-fixture requirements')).agent.messages.findLast(
          (m) => m.role === 'assistant',
        )?.content,
      ).toContain('Read requirements, draft, review.');
      expect(first.thread.id).not.toBe(second.thread.id);
      for (const [label, text] of [
        ['identifier', 'The current case identifier is REQ-731-α.'],
        ['unicode', 'I prefer 日本語 summaries.'],
        ['distant', 'The distant launch value is 4729.'],
      ]) {
        ws.memory.create({
          scope: { kind: 'dot', id: dot.id },
          title: label,
          text,
        });
        const query =
          label === 'identifier'
            ? 'REQ-731-α'
            : label === 'unicode'
              ? '日本語'
              : '4729';
        expect(
          (await chat('recall-fixture ' + query)).agent.messages.findLast(
            (m) => m.role === 'assistant',
          )?.content,
        ).toContain(text);
      }
      const preview = platform.memory!.publication.previewRestore(corrected.id);
      platform.memory!.publication.restore(
        preview.id,
        preview.expectedRevisions,
      );
      const forgotten = await chat('recall-fixture detailed');
      expect(
        forgotten.agent.messages.findLast((m) => m.role === 'assistant')
          ?.content,
      ).toContain('No matching retained memory');
      const longThread = await platform.createConversation(
        dot.id,
        'Compacted approval',
      );
      const messages = Array.from({ length: 24 }, (_, i) => ({
        id: 'history' + i,
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        content:
          i === 0
            ? 'Keep exact identifier REQ-731-α.'
            : 'Prior task context ' + i,
      }));
      const lease = (await platform.localConversations!.acquireThread(
        longThread.id,
      ))!;
      await lease.beginRun(
        {
          threadId: longThread.id,
          runId: 'seed',
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
      const approval = make(longThread.id);
      approval.addMessage({
        id: 'approval-user',
        role: 'user',
        content: 'approval-fixture',
      });
      await approval.runAgent({ tools: [pageReviewTool] });
      const call = approval.messages
        .flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []))
        .at(-1)!;
      expect(call.function.name).toBe('review_space_page');
      const canonical = await platform.memory!.repository.threadMessages(
        longThread.id,
      );
      expect(
        await platform.memory!.compaction.compact(
          longThread.id,
          new AbortController().signal,
        ),
      ).toBe('updated');
      expect(
        await platform.memory!.repository.threadMessages(longThread.id),
      ).toEqual(canonical);
      await platform.stop();
      platform = new Platform(store, ws, config);
      await platform.start();
      const resumed = make(longThread.id);
      await resumed.connectAgent();
      resumed.addMessage({
        id: 'approval-result',
        role: 'tool',
        toolCallId: call.id,
        content: '{"approved":true}',
      });
      await resumed.runAgent({ tools: [pageReviewTool] });
      expect(
        resumed.messages.findLast((m) => m.role === 'assistant')?.content,
      ).toContain('Approval continued with exact identifier REQ-731-α.');
      const timings = memoryMetrics.snapshot();
      for (const stage of [
        'recall',
        'context',
        'providerQueue',
        'providerExecution',
        'tools',
        'turn',
      ] as const)
        expect(
          timings[stage].cold.count + timings[stage].warm.count,
        ).toBeGreaterThan(0);
      console.log('Fixture memory timings: ' + JSON.stringify(timings));
      ws.updateDot(dot.id, { ...dot, memoryAllowed: false });
      await expect(
        platform.memory!.recall.search(dot.id, { query: '4729' }),
      ).rejects.toThrow(/disabled/);
    } finally {
      await platform.memory!.pg.query(
        'DELETE FROM memory_jobs WHERE owner_id=$1',
        [owner],
      );
      await platform.memory!.pg.query(
        'DELETE FROM memory_processed_sources WHERE owner_id=$1',
        [owner],
      );
      await platform.memory!.pg.query(
        'DELETE FROM local_ai_runs WHERE owner_id=$1',
        [owner],
      );
      await platform.memory!.pg.query(
        'DELETE FROM local_ai_threads WHERE owner_id=$1',
        [owner],
      );
      await platform.stop();
      ws.close();
      store.close();
    }
  },
  90000,
);
