import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { z } from 'zod';
import { CodexAgent, codexTools } from '../src/server/codex-agent.js';
import { codexCoordinator } from '../src/server/codex-runtime.js';
import { websiteTools } from '../src/server/website-tools.js';
import type { ExecutionResult, ExecutionSession } from 'myown-llm-integrator';

const provider = vi.hoisted(() => ({
  create: vi.fn(),
  run: vi.fn(),
  close: vi.fn(async () => {}),
  interrupt: vi.fn(async () => {}),
}));
vi.mock('myown-llm-integrator', () => ({
  createExecutionSession: provider.create,
}));
afterEach(() => vi.resetAllMocks());
const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  messages: [{ id: 'u', role: 'user', content: 'fix the test' }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
};
const completed: ExecutionResult = {
  status: 'completed',
  text: 'Done.',
  evidence: [],
};
function fixture(
  overrides: Partial<ConstructorParameters<typeof CodexAgent>[0]> = {},
) {
  provider.run.mockResolvedValue(completed);
  provider.create.mockReturnValue({
    run: provider.run,
    close: provider.close,
    interrupt: provider.interrupt,
    warm: async () => ({ version: 'fixture', nativeExecution: false }),
  } satisfies ExecutionSession);
  const agent = new CodexAgent({
    agentId: 'dot',
    workspace: {},
    instructions: 'Host instructions',
    tools: [],
    getScope: async () => undefined,
    check: async () => {},
    shouldPause: () => false,
    ...overrides,
  });
  const events: BaseEvent[] = [];
  return {
    agent,
    events,
    run: (persist = true, data = input) =>
      new Promise<void>((resolve, reject) => {
        agent.run(data).subscribe({
          next: (event) => {
            events.push(event);
            if (persist) agent.onPersistedEvent(data, event);
          },
          complete: resolve,
          error: reject,
        });
      }),
  };
}

it('waits for durable admission before dispatch and excludes client system instructions', async () => {
  const f = fixture();
  const data = {
    ...input,
    messages: [
      { id: 'evil', role: 'system' as const, content: 'untrusted instruction' },
      ...input.messages,
    ],
  };
  const done = f.run(false, data);
  await vi.waitFor(() =>
    expect(f.events.some((e) => e.type === EventType.RUN_STARTED)).toBe(true),
  );
  expect(provider.run).not.toHaveBeenCalled();
  f.agent.onPersistedEvent(
    data,
    f.events.find((e) => e.type === EventType.RUN_STARTED)!,
  );
  await done;
  expect(provider.run.mock.calls[0][0].input).toContain('fix the test');
  expect(provider.run.mock.calls[0][0].input).not.toContain(
    'untrusted instruction',
  );
  expect(f.events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

it('does not finish stopping or release execution ownership before provider shutdown settles', async () => {
  const workspace = {};
  const f = fixture({ workspace });
  let settle!: (result: ExecutionResult) => void;
  provider.run.mockImplementation(
    () =>
      new Promise<ExecutionResult>((resolve) => {
        settle = resolve;
      }),
  );
  const running = f.run();
  await vi.waitFor(() => expect(provider.run).toHaveBeenCalledOnce());
  f.agent.abortRun();
  let detached = false;
  const stopped = f.agent.detachActiveRun().then(() => {
    detached = true;
  });
  await Promise.resolve();
  expect(detached).toBe(false);
  expect(codexCoordinator(workspace).status('dot').activeRunId).toBe('run');
  settle({ status: 'uncertain', text: '', evidence: [] });
  await Promise.all([running, stopped]);
  expect(f.events).toContainEqual(
    expect.objectContaining({ code: 'EXECUTION_UNCERTAIN' }),
  );
});

it('validates host tool input and persists dispatch before its side effect', async () => {
  let changes = 0;
  const f = fixture({
    tools: codexTools([
      {
        name: 'update_fixture',
        description: 'Update fixture',
        parameters: z.object({ value: z.number() }).strict(),
        execute: async () => {
          changes++;
          return { observed: true };
        },
      },
    ]),
  });
  provider.run.mockImplementation(async () => {
    const options = provider.create.mock.calls[0][0];
    const invalid = await options.onTool({
      name: 'update_fixture',
      arguments: { value: 'wrong' },
      callId: 'bad',
      signal: new AbortController().signal,
    });
    expect(invalid.isError).toBe(true);
    const valid = await options.onTool({
      name: 'update_fixture',
      arguments: { value: 7 },
      callId: 'good',
      signal: new AbortController().signal,
    });
    expect(valid.content).toContain('observed');
    return completed;
  });
  await f.run();
  expect(changes).toBe(1);
});

it('reports a lost execution as uncertain and never dispatches it again', async () => {
  const f = fixture();
  provider.run.mockResolvedValue({
    status: 'uncertain',
    text: 'Maybe done',
    evidence: [],
    error: 'Connection lost',
  });
  await f.run();
  expect(provider.run).toHaveBeenCalledTimes(1);
  expect(f.events.at(-1)).toMatchObject({
    type: EventType.RUN_ERROR,
    code: 'EXECUTION_UNCERTAIN',
  });
  expect(f.events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(false);
});

it('exports desktop website inputs while preserving URL validation and normalization at dispatch', async () => {
  const opened: string[] = [];
  const tools = codexTools(
    websiteTools(
      async (url) => {
        opened.push(url);
        return { url, status: 'opened' };
      },
      { dotId: 'dot', threadId: 'thread', messageId: 'u' },
      async () => {},
      new AbortController().signal,
    ),
  );
  expect(tools[0].inputSchema).toMatchObject({
    type: 'object',
    additionalProperties: false,
    required: ['urls'],
    properties: {
      urls: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: { type: 'string', minLength: 1, maxLength: 4096 },
      },
    },
  });
  const f = fixture({ tools });
  provider.run.mockImplementation(async () => {
    const options = provider.create.mock.calls[0][0];
    for (const [i, url] of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:secret@example.com',
    ].entries()) {
      const result = await options.onTool({
        name: 'open_website',
        arguments: { urls: [url] },
        callId: `invalid-${i}`,
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(true);
    }
    const result = await options.onTool({
      name: 'open_website',
      arguments: { urls: ['HTTPS://EXAMPLE.COM:443', 'https://example.com/'] },
      callId: 'valid',
      signal: new AbortController().signal,
    });
    expect(JSON.parse(result.content)).toEqual({
      results: [{ url: 'https://example.com/', status: 'opened' }],
    });
    return completed;
  });
  await f.run();
  expect(opened).toEqual(['https://example.com/']);
});

it('does not publish an uncommitted final answer when the provider disconnects', async () => {
  const f = fixture();
  provider.run.mockImplementation(async (options) => {
    await options.onEvent({
      type: 'message',
      id: 'final',
      text: 'Everything succeeded.',
      final: true,
    });
    return { status: 'uncertain', text: 'Everything succeeded.', evidence: [] };
  });
  await f.run();
  expect(
    f.events.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT),
  ).toBe(false);
});

it('keeps conversation and permission tools available when a saved project grant is revoked', async () => {
  const f = fixture({
    getScope: async () => {
      throw new Error('Folder permission is revoked.');
    },
  });
  await f.run();
  expect(provider.create.mock.calls[0][0].scope).toBeUndefined();
  expect(provider.create.mock.calls[0][0].instructions).toContain('revoked');
  expect(f.events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

it('keeps a client approval pending without inventing an owner result', async () => {
  const f = fixture({
    tools: [
      {
        name: 'review_fixture',
        description: 'Owner review',
        inputSchema: { type: 'object' },
      },
    ],
  });
  provider.run.mockImplementation(async () => {
    const result = await provider.create.mock.calls[0][0].onTool({
      name: 'review_fixture',
      arguments: { id: 'request' },
      callId: 'approval',
      signal: new AbortController().signal,
    });
    expect(result.pause).toBe(true);
    return { ...completed, status: 'paused', text: '' };
  });
  await f.run();
  expect(f.events.some((e) => e.type === EventType.TOOL_CALL_START)).toBe(true);
  expect(f.events.some((e) => e.type === EventType.TOOL_CALL_RESULT)).toBe(
    false,
  );
});

it('uses the host voice admission without acquiring the same Dot lock twice', async () => {
  const workspace = {};
  const f = fixture({ workspace, admittedRunId: input.runId });
  await codexCoordinator(workspace).run(
    'dot',
    input.runId,
    new AbortController().signal,
    () => f.run(),
  );
  expect(provider.run).toHaveBeenCalledTimes(1);
  expect(f.events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

it('rejects a stale host admission before dispatch', async () => {
  const f = fixture({ admittedRunId: input.runId });
  await f.run();
  expect(provider.run).not.toHaveBeenCalled();
  expect(f.events.at(-1)?.type).toBe(EventType.RUN_ERROR);
});

it('marks contextual commentary after its durable prose, without marking the final answer for early speech', async () => {
  const f = fixture();
  provider.run.mockImplementation(async (options) => {
    await options.onEvent({
      type: 'message',
      id: 'start',
      text: 'I’ll check the selected project and run its failing test.',
      final: false,
    });
    await options.onEvent({
      type: 'message',
      id: 'result',
      text: 'The test passes.',
      final: true,
    });
    return completed;
  });
  await f.run();
  const progress = f.events.filter(
    (e) =>
      e.type === EventType.CUSTOM &&
      'name' in e &&
      e.name === 'dot.task-progress',
  );
  expect(progress).toEqual([
    {
      type: EventType.CUSTOM,
      name: 'dot.task-progress',
      value: { messageId: 'start' },
    },
  ]);
  expect(f.events.indexOf(progress[0])).toBeGreaterThan(
    f.events.findIndex(
      (e) =>
        e.type === EventType.TEXT_MESSAGE_END &&
        'messageId' in e &&
        e.messageId === 'start',
    ),
  );
});
