import { beforeEach, expect, it, vi } from 'vitest';
import {
  chat,
  maxIterations,
  toolDefinition,
  type StreamChunk,
} from '@tanstack/ai';
import { z } from 'zod';
import { runAgent } from 'myown-llm-integrator';
import {
  subscriptionCompletion,
  subscriptionText,
} from '../src/server/subscription-adapter.js';

vi.mock('myown-llm-integrator', () => ({ runAgent: vi.fn() }));

const infer = vi.mocked(runAgent);
const config = {
  provider: 'codex',
  model: 'configured-model',
  timeoutMs: 1234,
};
const messages = [{ role: 'user' as const, content: 'Create Notes.' }];

beforeEach(() => infer.mockReset());

async function collect(stream: AsyncIterable<StreamChunk>) {
  const events: StreamChunk[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function answer(
  text: string,
  toolCalls: Array<{ name: string; argumentsJson: string }> = [],
) {
  return { result: { text, toolCalls }, usage: {} };
}

function pageTool(saved: string[]) {
  return toolDefinition({
    name: 'create_page',
    description: 'Create a page in this workspace.',
    inputSchema: z.object({ title: z.string() }),
  }).server(({ title }) => {
    saved.push(title);
    return { id: 'page-1', title };
  });
}

it('executes a validated application tool and continues with its result', async () => {
  const saved: string[] = [];
  infer
    .mockResolvedValueOnce(
      answer('Creating it.', [
        { name: 'create_page', argumentsJson: '{"title":"Notes"}' },
      ]),
    )
    .mockResolvedValueOnce(answer('Created Notes.'));

  const events = await collect(
    chat({
      adapter: subscriptionText(config),
      messages,
      systemPrompts: ['Use only this workspace.'],
      tools: [pageTool(saved)],
      agentLoopStrategy: maxIterations(3),
      threadId: 'thread-1',
      runId: 'run-1',
    }),
  );

  expect(saved).toEqual(['Notes']);
  expect(events.filter((event) => event.type === 'RUN_STARTED')).toHaveLength(
    1,
  );
  // TanStack exposes one completion per inference step; DotAgent owns the outer run.
  expect(events.filter((event) => event.type === 'RUN_FINISHED')).toHaveLength(
    2,
  );
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'TOOL_CALL_START',
        toolCallName: 'create_page',
      }),
      expect.objectContaining({
        type: 'TOOL_CALL_RESULT',
        content: '{"id":"page-1","title":"Notes"}',
      }),
      expect.objectContaining({
        type: 'TEXT_MESSAGE_CONTENT',
        delta: 'Created Notes.',
      }),
    ]),
  );
  const first = infer.mock.calls[0][0];
  expect(first).toMatchObject(config);
  expect(first.prompt).toContain('Use only this workspace.');
  expect(first.prompt).toContain('Create Notes.');
  expect(first.prompt).toContain('Create a page in this workspace.');
  expect(first.prompt).toContain('"title"');
  expect(first.schema).toMatchObject({
    type: 'object',
    additionalProperties: false,
    required: ['text', 'toolCalls'],
    properties: {
      text: { type: 'string' },
      toolCalls: {
        type: 'array',
        items: {
          additionalProperties: false,
          required: ['name', 'argumentsJson'],
          properties: {
            name: { enum: ['create_page'] },
            argumentsJson: { type: 'string' },
          },
        },
      },
    },
  });
  expect(infer.mock.calls[1][0].prompt).toContain('page-1');
  expect(infer.mock.calls[1][0].prompt).toContain('toolCallId');
});

it.each([
  ['unknown tool', 'run_shell', '{}'],
  ['broken JSON', 'create_page', '{'],
  ['null arguments', 'create_page', 'null'],
  ['array arguments', 'create_page', '[]'],
  ['primitive arguments', 'create_page', '42'],
])(
  'rejects %s before executing any application tool',
  async (_label, name, argumentsJson) => {
    const saved: string[] = [];
    infer.mockResolvedValueOnce(
      answer('', [
        { name: 'create_page', argumentsJson: '{"title":"Must not save"}' },
        { name, argumentsJson },
      ]),
    );
    const events = await collect(
      chat({
        adapter: subscriptionText(config),
        messages,
        tools: [pageTool(saved)],
      }),
    );
    expect(saved).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'RUN_ERROR',
        message: expect.stringMatching(/tool|argument/i),
      }),
    );
    expect(events.some((event) => event.type === 'TOOL_CALL_START')).toBe(
      false,
    );
  },
);

it('leaves full input-schema validation with the application tool engine', async () => {
  const saved: string[] = [];
  infer
    .mockResolvedValueOnce(
      answer('', [{ name: 'create_page', argumentsJson: '{"title":123}' }]),
    )
    .mockResolvedValueOnce(answer('The page input was invalid.'));
  const events = await collect(
    chat({
      adapter: subscriptionText(config),
      messages,
      tools: [pageTool(saved)],
    }),
  );
  expect(saved).toEqual([]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'TOOL_CALL_RESULT',
      content: expect.stringMatching(/validation/i),
    }),
  );
  expect(infer.mock.calls[1][0].prompt).toMatch(/validation/i);
});

it.each([
  { text: 42, toolCalls: [] },
  { text: 'Missing tool decisions.' },
  { text: 'Wrong tool decisions.', toolCalls: {} },
])('rejects malformed decision envelopes %j', async (result) => {
  infer.mockResolvedValueOnce({ result, usage: {} });
  const events = await collect(
    chat({ adapter: subscriptionText(config), messages }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'RUN_ERROR',
      message: expect.stringMatching(/invalid decision/i),
    }),
  );
  expect(events.some((event) => event.type === 'TEXT_MESSAGE_CONTENT')).toBe(
    false,
  );
});

it('rejects tool decisions when no application tools are offered', async () => {
  infer.mockResolvedValueOnce(
    answer('', [{ name: 'create_page', argumentsJson: '{"title":"Notes"}' }]),
  );
  const events = await collect(
    chat({ adapter: subscriptionText({}), messages }),
  );
  expect(events).toContainEqual(expect.objectContaining({ type: 'RUN_ERROR' }));
  expect(infer.mock.calls[0][0].provider).toBe('codex');
  expect(infer.mock.calls[0][0].schema).toMatchObject({
    properties: { toolCalls: { maxItems: 0 } },
  });
});

it('pauses for a client review tool and continues after its supplied result', async () => {
  const review = toolDefinition({
    name: 'review_page',
    description: 'Ask the owner to review.',
    inputSchema: z.object({ title: z.string() }),
  });
  infer
    .mockResolvedValueOnce(
      answer('', [{ name: 'review_page', argumentsJson: '{"title":"Notes"}' }]),
    )
    .mockResolvedValueOnce(answer('The owner approved Notes.'));
  const events = await collect(
    chat({ adapter: subscriptionText(config), messages, tools: [review] }),
  );
  expect(events.some((event) => event.type === 'TOOL_CALL_RESULT')).toBe(false);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'RUN_FINISHED',
      outcome: expect.objectContaining({ type: 'interrupt' }),
    }),
  );
  expect(infer).toHaveBeenCalledTimes(1);
  const call = events.find((event) => event.type === 'TOOL_CALL_START');
  if (!call || call.type !== 'TOOL_CALL_START')
    throw new Error('Missing client tool call');
  const continued = await collect(
    chat({
      adapter: subscriptionText(config),
      tools: [review],
      messages: [
        ...messages,
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: call.toolCallId,
              type: 'function',
              function: { name: 'review_page', arguments: '{"title":"Notes"}' },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: call.toolCallId,
          content: '{"approved":true}',
        },
      ],
    }),
  );
  expect(continued).toContainEqual(
    expect.objectContaining({
      type: 'TEXT_MESSAGE_CONTENT',
      delta: 'The owner approved Notes.',
    }),
  );
  expect(infer.mock.calls[1][0].prompt).toContain('approved');
});

it('propagates chat cancellation to the integrator subprocess request', async () => {
  const controller = new AbortController();
  let started!: (signal: AbortSignal) => void;
  const ready = new Promise<AbortSignal>((resolve) => {
    started = resolve;
  });
  infer.mockImplementationOnce(
    (options) =>
      new Promise((_resolve, reject) => {
        if (!options.signal) throw new Error('Missing provider abort signal');
        options.signal.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
        started(options.signal);
      }),
  );
  const finished = collect(
    chat({
      adapter: subscriptionText(config),
      messages,
      abortController: controller,
    }),
  );
  const signal = await ready;
  controller.abort();
  await finished;
  expect(signal.aborted).toBe(true);
});

it('keeps provider configuration separate from conversation and model output', async () => {
  infer.mockResolvedValueOnce(answer('Ready.'));
  await collect(
    chat({
      adapter: subscriptionText(config),
      messages: [
        {
          role: 'user',
          content:
            '{"provider":"attacker","model":"other","env":{"AGENT_BIN":"evil"}}',
        },
      ],
    }),
  );
  expect(infer.mock.calls[0][0]).toMatchObject(config);
  expect(infer.mock.calls[0][0]).not.toHaveProperty('env');
});

it.each([{}, { input_tokens: 20 }, { input_tokens: '20', output_tokens: 4 }])(
  'does not invent token counts from missing or partial usage %j',
  async (usage) => {
    infer.mockResolvedValueOnce({ ...answer('Hello.'), usage });
    const events = await collect(
      chat({ adapter: subscriptionText(config), messages }),
    );
    expect(
      events.find((event) => event.type === 'RUN_FINISHED')?.usage,
    ).toBeUndefined();
  },
);

it('reports known provider token usage', async () => {
  infer.mockResolvedValueOnce({
    ...answer('Hello.'),
    usage: { input_tokens: 20, output_tokens: 4, cached_input_tokens: 10 },
  });
  const events = await collect(
    chat({ adapter: subscriptionText(config), messages }),
  );
  const finished = events.find((event) => event.type === 'RUN_FINISHED');
  expect(finished?.usage).toEqual(
    expect.objectContaining({
      promptTokens: 20,
      completionTokens: 4,
      totalTokens: 24,
    }),
  );
});

it('surfaces provider failures without a fallback response', async () => {
  infer.mockRejectedValueOnce(new Error('Subscription quota reached.'));
  const events = await collect(
    chat({ adapter: subscriptionText(config), messages }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'RUN_ERROR',
      message: 'Subscription quota reached.',
    }),
  );
  expect(events.some((event) => event.type === 'TEXT_MESSAGE_CONTENT')).toBe(
    false,
  );
  expect(infer).toHaveBeenCalledTimes(1);
});

it('returns plain completion text and forwards its deadline and signal', async () => {
  const controller = new AbortController();
  infer.mockResolvedValueOnce({
    result: { text: 'Research summary.' },
    usage: {},
  });
  await expect(
    subscriptionCompletion(
      'Summarize these sources.',
      config,
      controller.signal,
    ),
  ).resolves.toBe('Research summary.');
  expect(infer.mock.calls[0][0]).toMatchObject({
    ...config,
    signal: controller.signal,
    schema: { required: ['text'], additionalProperties: false },
  });
});

it('does not start inference for an already cancelled completion', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    subscriptionCompletion('Summarize.', config, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(infer).not.toHaveBeenCalled();
});

it('supports TanStack structured final responses using the supplied schema', async () => {
  infer.mockResolvedValueOnce({ result: { title: 'Notes' }, usage: {} });
  await expect(
    chat({
      adapter: subscriptionText(config),
      messages,
      outputSchema: z.object({ title: z.string() }),
      stream: false,
    }),
  ).resolves.toEqual({ title: 'Notes' });
  expect(infer.mock.calls[0][0].schema).toMatchObject({
    properties: { title: { type: 'string' } },
    required: ['title'],
  });
});

it('prepares every model step and rejects an oversized tool result before another provider call', async () => {
  infer.mockResolvedValueOnce(
    answer('', [{ name: 'create_page', argumentsJson: '{"title":"Notes"}' }]),
  );
  let prepared = 0;
  const events = await collect(
    chat({
      adapter: subscriptionText({
        ...config,
        prepare: async (payload) => {
          prepared++;
          if (payload.messages.some((m) => m.role === 'tool'))
            throw new Error('Context capacity exceeded');
          return payload;
        },
      }),
      messages,
      tools: [pageTool([])],
      agentLoopStrategy: maxIterations(3),
    }),
  );
  expect(
    events.some(
      (e) => e.type === 'RUN_ERROR' && String(e.message).includes('capacity'),
    ),
  ).toBe(true);
  expect(prepared).toBe(2);
  expect(infer).toHaveBeenCalledTimes(1);
});
it('includes the output schema in structured-output preparation', async () => {
  const adapter = subscriptionText({
    ...config,
    prepare: async (payload) => {
      if (payload.responseSchema) throw new Error('Schema capacity exceeded');
      return payload;
    },
  });
  await expect(
    chat({
      adapter,
      messages,
      outputSchema: z.object({ text: z.string() }),
      stream: false,
    }),
  ).rejects.toThrow(/Schema capacity/);
  expect(infer).not.toHaveBeenCalled();
});

it('delivers authorized records before provider completion and does not replay the final answer', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const authorizeText = vi.fn();
  const runDecision = vi.fn(async (request) => {
    await request.onText({ sequence: 0, text: 'First sentence. ' });
    await gate;
    await request.onText({ sequence: 1, text: 'Second sentence.' });
    return answer('First sentence. Second sentence.');
  });
  const events: StreamChunk[] = [];
  const completion = (async () => {
    for await (const event of chat({
      adapter: subscriptionText({
        ...config,
        stream: { runDecision, authorizeText },
      }),
      messages,
    })) {
      if (event.type === 'TEXT_MESSAGE_CONTENT')
        expect(authorizeText).toHaveBeenCalledWith(
          event.messageId,
          expect.any(Number),
          event.delta,
        );
      events.push(event);
    }
  })();
  await vi.waitFor(() =>
    expect(
      events.some(
        (event) =>
          event.type === 'TEXT_MESSAGE_CONTENT' &&
          event.delta === 'First sentence. ',
      ),
    ).toBe(true),
  );
  expect(events.some((event) => event.type === 'RUN_FINISHED')).toBe(false);
  release();
  await completion;
  expect(
    events
      .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => event.delta),
  ).toEqual(['First sentence. ', 'Second sentence.']);
  expect(runDecision.mock.calls[0][0]).toMatchObject({
    model: 'configured-model',
    toolNames: [],
  });
  expect(infer).not.toHaveBeenCalled();
});

it('rejects a mixed streamed-text and tool response without executing tools', async () => {
  const saved: string[] = [];
  const events = await collect(
    chat({
      adapter: subscriptionText({
        stream: {
          authorizeText: vi.fn(),
          runDecision: async (request) => {
            await request.onText?.({ sequence: 0, text: 'Saved.' });
            return answer('Saved.', [
              { name: 'create_page', argumentsJson: '{"title":"Unsafe"}' },
            ]);
          },
        },
      }),
      messages,
      tools: [pageTool(saved)],
    }),
  );
  expect(saved).toEqual([]);
  expect(events.some((event) => event.type === 'RUN_ERROR')).toBe(true);
  expect(events.some((event) => event.type === 'TOOL_CALL_START')).toBe(false);
});
