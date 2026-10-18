import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { runThreadTurn } from '../src/server/headless.js';

afterEach(() => vi.restoreAllMocks());

function runtimeFixture() {
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let input!: {
    runId: string;
    threadId: string;
    messages: unknown[];
    tools: unknown[];
  };
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stops: { path: string; body: unknown }[] = [];
  const encode = (event: unknown) =>
    encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/info'))
      return Response.json({ mode: 'sse', agents: { dot: {} } });
    if (path.endsWith('/connect'))
      return new Response(
        encode({
          type: 'MESSAGES_SNAPSHOT',
          messages: [
            { id: 'old-user', role: 'user', content: 'Earlier question' },
            { id: 'old-answer', role: 'assistant', content: 'Earlier answer' },
          ],
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    if (path.endsWith('/run')) {
      input = JSON.parse(String(init?.body));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      });
      init?.signal?.addEventListener(
        'abort',
        () => stream.error(init.signal?.reason),
        { once: true },
      );
      started();
      return new Response(body, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    if (path.includes('/stop/')) {
      stops.push({ path, body: JSON.parse(String(init?.body)) });
      return Response.json({ stopped: true });
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  return {
    ready,
    stops,
    input: () => input,
    send(event: unknown) {
      stream.enqueue(encode(event));
    },
    close() {
      stream.close();
    },
  };
}

async function begin() {
  const fixture = runtimeFixture();
  const controller = new AbortController();
  const answer = runThreadTurn(
    'http://localhost/api/copilotkit',
    {},
    'dot',
    'thread',
    'Current question',
    controller.signal,
  );
  await fixture.ready;
  fixture.send({
    type: 'RUN_STARTED',
    threadId: 'thread',
    runId: fixture.input().runId,
  });
  fixture.send({
    type: 'TEXT_MESSAGE_START',
    messageId: 'current',
    role: 'assistant',
  });
  fixture.send({
    type: 'TEXT_MESSAGE_CONTENT',
    messageId: 'current',
    delta: 'Current ',
  });
  fixture.send({
    type: 'TEXT_MESSAGE_CONTENT',
    messageId: 'current',
    delta: 'answer.',
  });
  fixture.send({ type: 'TEXT_MESSAGE_END', messageId: 'current' });
  return { fixture, controller, answer };
}

it('keeps the headless answer buffered after SSE text until the current run completes', async () => {
  const { fixture, answer } = await begin();
  let settled = false;
  void answer.then(() => {
    settled = true;
  });
  await setImmediate();
  expect(settled).toBe(false);
  fixture.send({
    type: 'RUN_FINISHED',
    threadId: 'thread',
    runId: fixture.input().runId,
  });
  fixture.close();
  expect(await answer).toBe('Current answer.');
  expect(fixture.input().tools).toEqual([]);
  expect(fixture.input().messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ content: 'Earlier question' }),
      expect.objectContaining({ content: 'Current question' }),
    ]),
  );
});

it('rejects partial assistant text when the real SDK receives a later runtime error', async () => {
  const { fixture, answer } = await begin();
  const rejected = expect(answer).rejects.toThrow('Fixture provider failed');
  fixture.send({ type: 'RUN_ERROR', message: 'Fixture provider failed' });
  fixture.close();
  await rejected;
});

it('requests a scoped server stop and discards partial SSE text on cancellation', async () => {
  const { fixture, controller, answer } = await begin();
  const rejected = expect(answer).rejects.toThrow('Call ended');
  controller.abort(new DOMException('Call ended', 'AbortError'));
  await rejected;
  expect(fixture.stops).toEqual([
    {
      path: 'http://localhost/api/copilotkit/agent/dot/stop/thread',
      body: { runId: fixture.input().runId },
    },
  ]);
});
