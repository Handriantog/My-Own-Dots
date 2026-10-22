import { afterEach, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { setVoiceTurn } from '../src/server/local-voice/context.js';

const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
});
const decision = (urls?: string[]) => ({
  result: {
    text: urls ? '' : 'The browser action finished.',
    toolCalls: urls
      ? [{ name: 'open_website', argumentsJson: JSON.stringify({ urls }) }]
      : [],
  },
  usage: {},
});
function fixture(messageId = 'owner-message', channel = false) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    workspace.close();
    store.close();
  });
  const dot = workspace.dots()[0];
  workspace.bindThread('voice', dot.id, 'Voice');
  const opened: string[] = [];
  const openWebsite = vi.fn<
    import('../src/shared/desktop-browser.js').OpenWebsite
  >(async (url: string) => {
    opened.push(url);
    return { url, status: 'opened' as const };
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
    channel,
    undefined,
    undefined,
    undefined,
    openWebsite,
  );
  const input = {
    threadId: 'voice',
    runId: 'run',
    messages: [
      {
        id: messageId,
        role: 'user' as const,
        content: 'Open all the references in my browser.',
      },
    ],
    context: [],
    state: {},
    tools: [],
    forwardedProps: {},
  };
  setVoiceTurn(workspace, {
    callId: 'call',
    dotId: dot.id,
    threadId: 'voice',
    messageId,
    text: input.messages[0].content,
  });
  engine.runAgent.mockReset();
  return { agent, input, opened, openWebsite };
}

it('opens requested voice references once and returns actual results to the agent', async () => {
  const f = fixture();
  engine.runAgent
    .mockResolvedValueOnce(
      decision([
        'https://example.com/source',
        'https://example.org/',
        'https://example.com/source',
      ]),
    )
    .mockResolvedValueOnce(decision(['https://example.com/source']))
    .mockResolvedValueOnce(decision());
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(events.filter((e) => e.type === 'RUN_ERROR')).toEqual([]);
  expect(f.opened).toEqual([
    'https://example.com/source',
    'https://example.org/',
  ]);
  const results = events.filter((e) => e.type === 'TOOL_CALL_RESULT');
  expect(results.map((e) => JSON.parse(String(e.content)))).toEqual([
    {
      results: [
        { url: 'https://example.com/source', status: 'opened' },
        { url: 'https://example.org/', status: 'opened' },
      ],
    },
    { results: [{ url: 'https://example.com/source', status: 'opened' }] },
  ]);
});

it.each([
  'file:///etc/passwd',
  'javascript:alert(1)',
  'https://user:secret@example.com',
  'https://example.com/\nsecret',
])('never sends invalid website %s to the desktop', async (url) => {
  const f = fixture();
  engine.runAgent
    .mockResolvedValueOnce(decision([url]))
    .mockResolvedValueOnce(decision());
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(f.opened).toEqual([]);
});

it.each(['opendots:scheduled_task:job', 'opendots:voice_receipt:call'])(
  'does not open websites during background message %s',
  async (messageId) => {
    const f = fixture(messageId);
    engine.runAgent
      .mockResolvedValueOnce(decision(['https://example.com']))
      .mockResolvedValueOnce(decision());
    await expect(
      lastValueFrom(f.agent.run(f.input).pipe(toArray())),
    ).rejects.toThrow('unknown application tool');
    expect(f.opened).toEqual([]);
  },
);

it('returns a browser failure without inventing success or retrying the same URL', async () => {
  const f = fixture();
  f.openWebsite.mockImplementation(async (url) => ({
    url,
    status: 'failed',
    error: 'The browser could not open this website.',
  }));
  engine.runAgent
    .mockResolvedValueOnce(decision(['https://example.com']))
    .mockResolvedValueOnce(decision(['https://example.com']))
    .mockResolvedValueOnce(decision());
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(f.openWebsite).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(events.filter((e) => e.type === 'TOOL_CALL_RESULT')),
  ).toContain('could not open');
});
