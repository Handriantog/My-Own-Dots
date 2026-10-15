import { afterEach, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);
afterEach(() => vi.restoreAllMocks());
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
