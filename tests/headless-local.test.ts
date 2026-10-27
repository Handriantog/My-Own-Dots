import { afterEach, expect, it, vi } from 'vitest';
import { runThreadTurn } from '../src/server/headless.js';

afterEach(() => vi.restoreAllMocks());
function stream(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
}
it('runs scheduled work over local SSE with persisted context and no Intelligence gateway', async () => {
  const membership = vi.fn(async (_ids: string[]) => {});
  let submitted:
    { messages: { id: string; role: string; content: string }[] } | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/info'))
      return Response.json({ mode: 'sse', agents: { dot: {} } });
    if (path.endsWith('/connect'))
      return stream([
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [
            {
              id: 'previous',
              role: 'user',
              content: 'Remember the blue notebook.',
            },
            { id: 'answer', role: 'assistant', content: 'Remembered.' },
          ],
        },
      ]);
    if (path.endsWith('/run')) {
      submitted = JSON.parse(String(init?.body));
      const input = JSON.parse(String(init?.body));
      return stream([
        { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
        { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
        {
          type: 'TEXT_MESSAGE_CONTENT',
          messageId: 'reply',
          delta: 'The blue notebook.',
        },
        { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
        { type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId },
      ]);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  expect(
    await runThreadTurn(
      'http://localhost/api/copilotkit',
      {},
      'dot',
      'thread',
      'Which notebook?',
      new AbortController().signal,
      undefined,
      membership,
    ),
  ).toBe('The blue notebook.');
  expect(submitted?.messages.map((m) => m.content)).toEqual([
    'Remember the blue notebook.',
    'Remembered.',
    'Which notebook?',
  ]);
  expect(membership.mock.calls.flatMap(([ids]) => ids)).toEqual([
    submitted!.messages.at(-1)!.id,
    'reply',
  ]);
});
