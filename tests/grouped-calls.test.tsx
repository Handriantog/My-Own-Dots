import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ChatTranscript,
  revealChatMessage,
} from '../src/client/ChatTranscript';
import type { CallReceipt } from '../src/shared/types';
const call = (
  id: string,
  messageIds: string[],
  startedAt: number,
): CallReceipt => ({
  id,
  threadId: 't',
  startedAt,
  endedAt: startedAt + 1000,
  status: 'ended',
  transcript: 'RAW SECRET',
  error: null,
  messageIds,
});
it('groups only explicit canonical IDs, including late outcomes, preserving typed and legacy messages', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      calls={[
        call('second', ['random-b'], 20),
        call('first', ['random-a', 'late'], 10),
      ]}
      messages={[
        { id: 'random-a', role: 'user', content: 'First voice' },
        { id: 'typed', role: 'user', content: 'Typed between' },
        { id: 'random-b', role: 'assistant', content: 'Second voice' },
        {
          id: 'voice-first-spoof',
          role: 'assistant',
          content: 'Unmapped legacy',
        },
        { id: 'late', role: 'assistant', content: 'Late outcome' },
      ]}
    />,
  );
  expect(html.match(/<details/g)).toHaveLength(2);
  const first = html.slice(
    html.indexOf('<details'),
    html.indexOf('</details>'),
  );
  expect(first).toContain('First voice');
  expect(first).toContain('Late outcome');
  expect(first).not.toContain('Typed between');
  expect(first).not.toContain('Unmapped legacy');
  expect(html).toContain('chat-message-late');
  expect(html).toContain('Unmapped legacy');
  expect(html).not.toContain('RAW SECRET');
});
it('renders empty failed calls at their saved anchor', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      calls={[
        { ...call('empty', [], 1), status: 'failed', afterMessageId: 'typed' },
      ]}
      messages={[{ id: 'typed', role: 'user', content: 'Before empty' }]}
    />,
  );
  expect(html.indexOf('Before empty')).toBeLessThan(html.indexOf('<details'));
  expect(html).toContain('Call failed');
});
it('keeps a delayed caption at its call-start anchor before the earlier typed response', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      calls={[
        {
          ...call('delayed', ['caption'], 10),
          afterMessageId: 'typed-request',
        },
      ]}
      messages={[
        { id: 'typed-request', role: 'user', content: 'Earlier typed request' },
        {
          id: 'typed-response',
          role: 'assistant',
          content: 'Typed response finished during call',
        },
        { id: 'caption', role: 'user', content: 'Deferred voice caption' },
      ]}
    />,
  );
  expect(html.indexOf('<details')).toBeLessThan(
    html.indexOf('Typed response finished during call'),
  );
});
it('keeps approval identity and all tasks in their original call with collapsed status', () => {
  const jobs = Array.from({ length: 25 }, (_, i) => ({
    id: `job-${i}`,
    callId: 'first',
    dotId: 'dot',
    workerThreadId: `worker-${i}`,
    request: `Task ${i}`,
    status: i === 0 ? 'approval' : 'running',
  })) as import('../src/shared/voice-delegation').VoiceDelegation[];
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[]}
      calls={[call('first', [], 1), call('second', [], 2)]}
      tasks={{ jobs, error: '', stopping: undefined, stop: async () => {} }}
    />,
  );
  const first = html.slice(
    html.indexOf('<details'),
    html.indexOf('</details>'),
  );
  expect(first).toContain('1 need approval');
  expect(first).toContain('24 working');
  expect(first).toContain('#/chat/dot/worker-0');
  expect(first).toContain('Review approval');
  expect(first.match(/class="voice-task"/g)).toHaveLength(25);
  expect(html.match(/class="voice-task"/g)).toHaveLength(25);
  expect(first).not.toContain('<details class="chat-call" open');
});

it('reveals collapsed ancestors before scrolling and focusing the original article', () => {
  const details = { tagName: 'DETAILS', open: false, parentElement: null };
  const events: string[] = [];
  const article = {
    parentElement: { tagName: 'DIV', parentElement: details },
    scrollIntoView: () => {
      expect(details.open).toBe(true);
      events.push('scroll');
    },
    focus: () => {
      expect(details.open).toBe(true);
      events.push('focus');
    },
  };
  revealChatMessage(article as unknown as HTMLElement);
  expect(events).toEqual(['scroll', 'focus']);
  details.open = false; // Ordinary subsequent user collapse remains possible.
  expect(details.open).toBe(false);
});
