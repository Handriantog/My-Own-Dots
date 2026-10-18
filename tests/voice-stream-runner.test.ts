import { expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { LocalAgentRunner } from '../src/server/local-runner.js';
import { MemoryStore } from './fixtures/memory-conversations.js';
import { setVoiceTurn } from '../src/server/local-voice/context.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type { BaseEvent } from '@ag-ui/client';

it.each(['success', 'storage failure', 'provider failure'] as const)(
  'speaks only persisted provider records through DotAgent and LocalAgentRunner (%s)',
  async (scenario) => {
    const failWrite = scenario === 'storage failure';
    const failProvider = scenario === 'provider failure';
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const conversations = new MemoryStore();
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Voice');
    const config = {
      conversationBackend: 'local',
      localDatabaseUrl: 'postgres://unused',
      llmBackend: 'subscription',
      llmProvider: 'codex',
      baseUrl: '',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      webSearchProvider: 'disabled',
    } as PlatformConfig;
    const runner = new LocalAgentRunner(conversations);
    const agent = new DotAgent(store, workspace, config, dot.id);
    const observed = vi.spyOn(agent, 'onPersistedEvent');
    const input = {
      threadId: 'thread',
      runId: 'run',
      messages: [{ id: 'u', role: 'user' as const, content: 'Hello Dot' }],
      state: {},
      context: [],
      tools: [],
      forwardedProps: {},
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heard: string[] = [];
    const settled = vi.fn();
    const acquire = conversations.acquireThread.bind(conversations);
    vi.spyOn(conversations, 'acquireThread').mockImplementation(async () => {
      const lease = await acquire();
      const append = lease!.appendEvent;
      lease!.appendEvent = async (event) => {
        if (failWrite && event.type === 'TEXT_MESSAGE_CONTENT')
          throw Error('Disk failed');
        await append(event);
      };
      return lease;
    });
    setVoiceTurn(workspace, {
      callId: 'call',
      dotId: dot.id,
      threadId: 'thread',
      messageId: 'u',
      text: 'Hello Dot',
      stream: async (request) => {
        await request.onText?.({ sequence: 0, text: 'Saved first. ' });
        await Promise.race([
          gate,
          new Promise<void>((_, reject) =>
            request.signal?.addEventListener(
              'abort',
              () => reject(Error('aborted')),
              { once: true },
            ),
          ),
        ]);
        request.signal?.throwIfAborted();
        if (failProvider) throw Error('Provider stopped after committed text');
        await request.onText?.({ sequence: 1, text: 'Saved second.' });
        return {
          result: { text: 'Saved first. Saved second.', toolCalls: [] },
          usage: {},
        };
      },
      commitText: (_user, assistantId, _sequence, text) => {
        expect(conversations.snapshot.lastRun?.events).toContainEqual(
          expect.objectContaining({
            type: 'TEXT_MESSAGE_CONTENT',
            messageId: assistantId,
            delta: text,
          }),
        );
        heard.push(text);
      },
      finishText: settled,
    });
    try {
      const events: BaseEvent[] = [];
      const running = lastValueFrom(
        runner.run({ threadId: 'thread', agent, input }).pipe(toArray()),
      ).then((result) => {
        events.push(...result);
      });
      if (!failWrite) {
        await vi.waitFor(() =>
          expect(
            heard,
            JSON.stringify({
              snapshot: conversations.snapshot,
              events,
              settled: settled.mock.calls,
              observed: observed.mock.calls,
            }),
          ).toEqual(['Saved first. ']),
        );
        expect(settled).not.toHaveBeenCalled();
      }
      release();
      await running;
      expect(heard).toEqual(
        failWrite
          ? []
          : failProvider
            ? ['Saved first. ']
            : ['Saved first. ', 'Saved second.'],
      );
      expect(settled).toHaveBeenCalledWith('u', failWrite || failProvider);
      if (failProvider)
        expect(
          (await conversations.getSnapshot()).messages.at(-1)?.content,
        ).toBe('Saved first. ');
      expect(events.some((event) => event.type === 'RUN_ERROR')).toBe(
        failWrite || failProvider,
      );
    } finally {
      release();
      await runner.stop({ threadId: 'thread' });
      workspace.close();
      store.close();
    }
  },
);
