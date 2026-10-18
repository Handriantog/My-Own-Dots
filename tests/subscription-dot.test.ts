import { afterEach, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  setVoiceTurn,
  clearVoiceTurn,
} from '../src/server/local-voice/context.js';
const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);
afterEach(() => vi.restoreAllMocks());
it('adds English-only guidance to governed voice turns without changing typed chat', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = workspace.dots()[0];
    workspace.bindThread('voice', dot.id, 'Voice');
    workspace.setVoiceSettings(dot.id, {
      voiceId: 'bm_george',
      personality: 'serious',
    });
    engine.runAgent.mockReset().mockResolvedValue({
      result: { text: 'Hello', toolCalls: [] },
      usage: {},
    });
    const agent = new DotAgent(
      store,
      workspace,
      {
        conversationBackend: 'local',
        localDatabaseUrl: 'postgres://unused',
        llmBackend: 'subscription',
        llmProvider: 'codex',
        baseUrl: '',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
        webSearchProvider: 'disabled',
      },
      dot.id,
    );
    const input = {
      threadId: 'voice',
      runId: 'run',
      messages: [{ id: 'user', role: 'user' as const, content: 'Hello' }],
      context: [],
      state: {},
      tools: [],
      forwardedProps: {},
    };
    setVoiceTurn(workspace, {
      callId: 'call',
      dotId: dot.id,
      threadId: 'voice',
      messageId: 'user',
      text: 'Hello',
    });
    await lastValueFrom(agent.run(input).pipe(toArray()));
    expect(engine.runAgent.mock.calls.at(-1)?.[0].prompt).toContain(
      'Reply in English only',
    );
    expect(engine.runAgent.mock.calls.at(-1)?.[0].prompt).toContain(
      'measured, professional',
    );
    clearVoiceTurn(workspace, 'call');
    await lastValueFrom(
      agent.run({ ...input, runId: 'typed' }).pipe(toArray()),
    );
    expect(engine.runAgent.mock.calls.at(-1)?.[0].prompt).not.toContain(
      'Reply in English only',
    );
  } finally {
    store.close();
    workspace.close();
  }
});
it('runs Dot tools through the subscription without Intelligence or API credentials', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = workspace.dots()[0];
    workspace.bindThread('local', dot.id, 'Local');
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No hosted service allowed'));
    engine.runAgent
      .mockResolvedValueOnce({
        result: {
          text: '',
          toolCalls: [
            {
              name: 'create_space_page',
              argumentsJson: JSON.stringify({
                title: 'Subscription note',
                content: 'Saved locally',
              }),
            },
          ],
        },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: { text: 'Saved your note.', toolCalls: [] },
        usage: {},
      });
    const agent = new DotAgent(
      store,
      workspace,
      {
        conversationBackend: 'local',
        localDatabaseUrl: 'postgres://unused',
        llmBackend: 'subscription',
        llmProvider: 'codex',
        baseUrl: '',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
        webSearchProvider: 'disabled',
      },
      dot.id,
    );
    const events = await lastValueFrom(
      agent
        .run({
          threadId: 'local',
          runId: 'turn',
          messages: [{ id: 'user', role: 'user', content: 'Save a note.' }],
          context: [],
          state: {},
          tools: [],
          forwardedProps: { provider: 'untrusted' },
        })
        .pipe(toArray()),
    );
    expect(events.some((event) => event.type === 'RUN_ERROR')).toBe(false);
    expect(
      workspace.pages
        .list(dot.spaceId)
        .some((page) => page.title === 'Subscription note'),
    ).toBe(true);
    expect(events.some((event) => event.type === 'RUN_FINISHED')).toBe(true);
    expect(network).not.toHaveBeenCalled();
  } finally {
    store.close();
    workspace.close();
  }
});

it('uses essential context and recall tools without preloading unrelated memories', async () => {
  const { MemoryAccess } = await import('../src/server/memory-access.js');
  const { MemoryRecall } = await import('../src/server/memory-recall.js');
  const { ContextBuilder } = await import('../src/server/context-builder.js');
  const store = new Store(':memory:'),
    workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const dot = workspace.dots()[0];
    workspace.bindThread('memory-thread', dot.id, 'Memory');
    const recall = new MemoryRecall(
      workspace.memory,
      {
        generation: async () => 0,
        coverage: async () => ({
          indexedRuns: 0,
          eligibleRuns: 0,
          complete: true,
        }),
        searchEpisodes: async () => ({
          matches: [],
          coverage: { indexedRuns: 0, eligibleRuns: 0, complete: true },
        }),
        sourceById: async () => undefined,
        readSource: async () => undefined,
      },
      new MemoryAccess(workspace, store),
    );
    const context = new ContextBuilder(recall);
    workspace.memory.create({
      scope: { kind: 'owner' },
      title: 'Tone',
      text: 'Essential concise tone',
      pinned: true,
    });
    workspace.memory.create({
      scope: { kind: 'owner' },
      title: 'Archive',
      text: 'Unrelated archived detail',
    });
    engine.runAgent.mockReset().mockResolvedValue({
      result: { text: 'Ready', toolCalls: [] },
      usage: {},
    });
    const agent = new DotAgent(
      store,
      workspace,
      {
        conversationBackend: 'local',
        localDatabaseUrl: 'postgres://unused',
        llmBackend: 'subscription',
        llmProvider: 'codex',
        baseUrl: '',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
        webSearchProvider: 'disabled',
      },
      dot.id,
      false,
      undefined,
      { recall, context },
    );
    const events = await lastValueFrom(
      agent
        .run({
          threadId: 'memory-thread',
          runId: 'memory-run',
          messages: [{ id: 'canonical-user', role: 'user', content: 'Hello' }],
          context: [],
          state: {},
          tools: [],
          forwardedProps: {},
        })
        .pipe(toArray()),
    );
    expect(events.some((e) => e.type === 'RUN_ERROR')).toBe(false);
    const prompt = engine.runAgent.mock.calls[0][0].prompt;
    expect(prompt).toContain('Essential concise tone');
    expect(prompt).not.toContain('Unrelated archived detail');
    expect(prompt).toContain('search_memory');
    expect(prompt).toContain('canonical-user');
  } finally {
    workspace.close();
    store.close();
  }
});
