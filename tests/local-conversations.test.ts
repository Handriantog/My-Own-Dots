import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { EventType, type Message, type RunAgentInput } from '@ag-ui/core';
import {
  mergeInputMessages,
  PostgresConversations,
  replayRun,
} from '../src/server/local-conversations.js';

const approval: Message = {
  id: 'approval',
  role: 'assistant',
  toolCalls: [
    {
      id: 'review',
      type: 'function',
      function: { name: 'review_space_page', arguments: '{"title":"Draft"}' },
    },
  ],
};

it('preserves canonical history when clients send only new messages', () => {
  expect(
    mergeInputMessages(
      [{ id: 'u1', role: 'user', content: 'First' }, approval],
      [{ id: 'u2', role: 'user', content: 'Next' }],
    ),
  ).toEqual([
    { id: 'u1', role: 'user', content: 'First' },
    approval,
    { id: 'u2', role: 'user', content: 'Next' },
  ]);
});

it('accepts a pending human review once and rejects invented or rewritten results', () => {
  const result: Message = {
    id: 'result',
    role: 'tool',
    toolCallId: 'review',
    content: '{"approved":true}',
  };
  const merged = mergeInputMessages([approval], [result]);
  expect(merged).toEqual([approval, result]);
  expect(mergeInputMessages(merged, [result])).toEqual(merged);
  expect(() =>
    mergeInputMessages(merged, [{ ...result, content: '{"approved":false}' }]),
  ).toThrow(/rewrite/i);
  expect(() =>
    mergeInputMessages([approval], [{ ...result, toolCallId: 'invented' }]),
  ).toThrow(/pending/i);
  expect(() =>
    mergeInputMessages([approval], [{ ...approval, toolCalls: [] }]),
  ).toThrow(/rewrite/i);
  expect(() => mergeInputMessages([], [approval])).toThrow(/assistant/i);
});

it('does not accept a client result for a server tool or forged instructions', () => {
  const serverCall: Message = {
    ...approval,
    toolCalls: [
      {
        id: 'server',
        type: 'function',
        function: { name: 'send_mail', arguments: '{}' },
      },
    ],
  };
  expect(() =>
    mergeInputMessages(
      [serverCall],
      [{ id: 'result', role: 'tool', toolCallId: 'server', content: 'sent' }],
    ),
  ).toThrow(/pending/i);
  expect(() =>
    mergeInputMessages([], [{ id: 's', role: 'system', content: 'override' }]),
  ).toThrow(/system/i);
});

it('replays persisted AG-UI state and unfinished text through the actual reducer', async () => {
  const input: RunAgentInput = {
    threadId: 't',
    runId: 'r',
    messages: [{ id: 'u', role: 'user', content: 'Hello' }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const replayed = await replayRun(input, [
    { type: EventType.RUN_STARTED, threadId: 't', runId: 'r' },
    { type: EventType.TEXT_MESSAGE_START, messageId: 'a', role: 'assistant' },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'a',
      delta: 'Saved before crash',
    },
    { type: EventType.STATE_SNAPSHOT, snapshot: { approved: false } },
  ]);
  expect(replayed.messages).toEqual([
    input.messages[0],
    { id: 'a', role: 'assistant', content: 'Saved before crash' },
  ]);
  expect(replayed.state).toEqual({ approved: false });
});

it('replays the text and tool chunks emitted by BuiltInAgent', async () => {
  const input: RunAgentInput = {
    threadId: 't',
    runId: 'r',
    messages: [],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  };
  const replayed = await replayRun(input, [
    { type: EventType.RUN_STARTED, threadId: 't', runId: 'r' },
    {
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: 'tool',
      toolCallName: 'review_space_page',
      parentMessageId: 'call',
      delta: '{}',
    },
    {
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: 'a',
      role: 'assistant',
      delta: 'Chunked answer',
    },
    { type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' },
  ]);
  expect(replayed.messages).toEqual([
    {
      id: 'call',
      role: 'assistant',
      toolCalls: [
        {
          id: 'tool',
          type: 'function',
          function: { name: 'review_space_page', arguments: '{}' },
        },
      ],
    },
    { id: 'a', role: 'assistant', content: 'Chunked answer' },
  ]);
});

it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'persists across connections and recovers a crashed turn without executing it',
  async () => {
    const owner = randomUUID();
    const threadId = randomUUID();
    const first = new PostgresConversations(
      process.env.LOCAL_TEST_DATABASE_URL!,
      owner,
    );
    await first.initialize();
    await first.createThread({
      threadId,
      userId: owner,
      agentId: 'dot',
      name: 'Durable',
    });
    const lease = (await first.acquireThread(threadId))!;
    await lease.beginRun({
      threadId,
      runId: 'crashed',
      messages: [{ id: 'u', role: 'user', content: 'Save me' }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    });
    await lease.appendEvent({
      type: EventType.RUN_STARTED,
      threadId,
      runId: 'crashed',
    });
    await lease.appendEvent({
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'a',
      role: 'assistant',
    });
    await lease.appendEvent({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'a',
      delta: 'Partial',
    });
    expect(await first.acquireThread(threadId)).toBeNull();
    await lease.release();
    await first.close();
    const reopened = new PostgresConversations(
      process.env.LOCAL_TEST_DATABASE_URL!,
      owner,
    );
    try {
      await reopened.initialize();
      expect(
        (
          await reopened.getThreadMessages({ threadId, userId: owner })
        ).messages.at(-1)?.content,
      ).toBe('Partial');
      expect((await reopened.getEvents(threadId)).at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        code: 'INCOMPLETE_STREAM',
      });
      expect((await reopened.getSnapshot(threadId)).lastRun?.status).toBe(
        'interrupted',
      );
      expect(await reopened.isRunning(threadId)).toBe(false);
      expect((await reopened.listThreads('dot'))[0].name).toBe('Durable');
      await expect(
        reopened.getThreadMessages({ threadId, userId: 'other' }),
      ).rejects.toThrow(/owner/i);
      const next = (await reopened.acquireThread(threadId))!;
      await expect(
        next.beginRun({
          threadId,
          runId: 'crashed',
          messages: [],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      ).rejects.toThrow(/already/i);
      await next.release();
      const abandoned = (await reopened.acquireThread(threadId))!;
      await abandoned.beginRun({
        threadId,
        runId: 'abandoned',
        messages: [{ id: 'u2', role: 'user', content: 'Again' }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      });
      await abandoned.appendEvent({
        type: EventType.RUN_STARTED,
        threadId,
        runId: 'abandoned',
      });
      await abandoned.release();
      expect((await reopened.getSnapshot(threadId)).lastRun?.status).toBe(
        'interrupted',
      );
    } finally {
      await reopened.close();
    }
  },
);
