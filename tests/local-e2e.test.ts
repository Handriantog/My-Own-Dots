import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { pageReviewTool } from '../src/shared/page-review.js';

afterEach(() => vi.unstubAllEnvs());
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'runs the real npm/Python subprocess over SSE and restores tools, approval and history after restart',
  async () => {
    vi.stubEnv(
      'AGENT_COMMAND_JSON',
      JSON.stringify([
        process.execPath,
        resolve('tests/fixtures/subscription-provider.mjs'),
      ]),
    );
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', `e2e-${randomUUID()}`);
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
    let platform = await Platform.create(store, workspace, config);
    const makeAgent = (threadId: string) =>
      new ProxiedCopilotRuntimeAgent({
        runtimeUrl: config.runtimeUrl,
        agentId: workspace.dots()[0].id,
        threadId,
        runtimeMode: 'sse',
        transport: 'rest',
        fetch: (url, init) => platform.handle(new Request(url, init)),
      });
    try {
      await platform.start();
      const thread = await platform.createConversation(
        workspace.dots()[0].id,
        'Real engine fixture',
      );
      const agent = makeAgent(thread.id);
      await agent.connectAgent();
      agent.addMessage({ id: 'user', role: 'user', content: 'save-fixture' });
      const first = await agent.runAgent();
      expect(
        first.newMessages.some(
          (message) =>
            message.role === 'assistant' &&
            message.content?.includes('Offline provider completed'),
        ),
      ).toBe(true);
      expect(
        workspace.pages
          .list(workspace.dots()[0].spaceId)
          .some((page) => page.title === 'Offline fixture note'),
      ).toBe(true);
      const before = structuredClone(agent.messages);
      await platform.stop();
      platform = await Platform.create(store, workspace, config);
      await platform.start();
      const resumed = makeAgent(thread.id);
      await resumed.connectAgent();
      expect(resumed.messages).toEqual(before);
      resumed.addMessage({
        id: 'second',
        role: 'user',
        content: 'What happened before?',
      });
      await resumed.runAgent();
      expect(resumed.messages.at(-1)?.content).toContain(
        'Saved note context: present',
      );
      const reviewThread = await platform.createConversation(
        workspace.dots()[0].id,
        'Review fixture',
      );
      const review = makeAgent(reviewThread.id);
      review.addMessage({
        id: 'review-user',
        role: 'user',
        content: 'review-fixture',
      });
      await review.runAgent({ tools: [pageReviewTool] });
      const call = review.messages
        .flatMap((message) =>
          message.role === 'assistant' ? (message.toolCalls ?? []) : [],
        )
        .at(-1)!;
      expect(call.function.name).toBe(pageReviewTool.name);
      await platform.stop();
      platform = await Platform.create(store, workspace, config);
      const approved = makeAgent(reviewThread.id);
      await approved.connectAgent();
      approved.addMessage({
        id: 'approval-result',
        role: 'tool',
        toolCallId: call.id,
        content: '{"approved":true}',
      });
      await approved.runAgent({ tools: [pageReviewTool] });
      expect(approved.messages.at(-1)?.content).toContain(
        'Offline provider completed',
      );
      expect(await platform.history(thread.id)).toContain(
        'What happened before?',
      );
    } finally {
      await platform.stop();
      store.close();
      workspace.close();
    }
  },
  60000,
);
