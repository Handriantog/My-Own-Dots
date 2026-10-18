import { expect, it, vi } from 'vitest';
import { EventType } from '@ag-ui/client';
import { VoiceTurnTiming } from '../src/server/local-voice/timing';
import {
  clearVoiceTurn,
  setVoiceTurn,
  voiceTurnInstructions,
  voiceTurnInference,
  voiceTurnStreaming,
  persistedVoiceEvent,
  bindVoiceEvent,
  settledVoiceRun,
} from '../src/server/local-voice/context';

it('times buffered text at durable persistence without authorizing it for streaming speech', () => {
  const rows: string[] = [];
  const timing = new VoiceTurnTiming('call', 'u', 0, {
    enabled: true,
    now: () => 125,
    write: (row) => rows.push(row),
  });
  const workspace = {};
  const input = {
    threadId: 'thread',
    messages: [{ id: 'u', role: 'user', content: 'Hello' }],
  };
  const commitText = vi.fn();
  setVoiceTurn(workspace, {
    callId: 'call',
    dotId: 'dot',
    threadId: 'thread',
    messageId: 'u',
    text: 'Hello',
    timing,
    commitText,
  });
  const event = {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'a',
    delta: 'Saved text.',
  };
  persistedVoiceEvent(workspace, 'wrong-dot', input, event);
  expect(rows).toHaveLength(0);
  persistedVoiceEvent(workspace, 'dot', input, event);
  expect(rows.map((row) => JSON.parse(row))).toEqual([
    expect.objectContaining({ stage: 'text_saved', elapsedMs: 125 }),
  ]);
  expect(commitText).not.toHaveBeenCalled();
});

it('approves only the exact registered and persisted text span for the bound voice turn', () => {
  const workspace = {};
  const commitText = vi.fn(),
    finishText = vi.fn();
  const input = {
    threadId: 'thread',
    messages: [{ id: 'u', role: 'user', content: 'Hello' }],
  };
  setVoiceTurn(workspace, {
    callId: 'call',
    dotId: 'dot',
    threadId: 'thread',
    messageId: 'u',
    text: 'Hello',
    stream: async () => ({ result: { text: '', toolCalls: [] }, usage: {} }),
    commitText,
    finishText,
  });
  const binding = voiceTurnStreaming(workspace, 'dot', input)!;
  const event = {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'a',
    delta: 'Saved sentence. ',
  };
  persistedVoiceEvent(workspace, 'dot', input, event);
  expect(commitText).not.toHaveBeenCalled();
  binding.authorizeText('provider-a', 0, 'Saved sentence. ');
  bindVoiceEvent(workspace, 'dot', input, event);
  expect(commitText).not.toHaveBeenCalled();
  persistedVoiceEvent(workspace, 'dot', { ...input, threadId: 'other' }, event);
  persistedVoiceEvent(workspace, 'dot', input, {
    ...event,
    delta: 'Forged sentence.',
  });
  expect(commitText).not.toHaveBeenCalled();
  persistedVoiceEvent(workspace, 'dot', input, event);
  expect(commitText).toHaveBeenCalledExactlyOnceWith(
    'u',
    'a',
    0,
    'Saved sentence. ',
  );
  persistedVoiceEvent(workspace, 'dot', input, event);
  expect(commitText).toHaveBeenCalledOnce();
  settledVoiceRun(workspace, 'dot', input, true);
  expect(finishText).toHaveBeenCalledExactlyOnceWith('u', true);
  clearVoiceTurn(workspace, 'call');
  expect(() => binding.authorizeText('a', 1, 'Late.')).toThrow();
});

it('applies English only to the current server-issued voice turn and its tool continuations', () => {
  const workspace = {};
  const turn = {
    callId: 'call',
    dotId: 'dot',
    threadId: 'thread',
    messageId: 'message',
    text: 'Hello',
    inference: async () => ({ result: {}, usage: {} }),
  };
  const input = {
    threadId: 'thread',
    messages: [
      { id: 'message', role: 'user', content: 'Page context\n\nHello' },
    ],
  };
  expect(voiceTurnInstructions(workspace, 'dot', input)).toEqual([]);
  expect(voiceTurnInference(workspace, 'dot', input)).toBeUndefined();
  setVoiceTurn(workspace, turn);
  expect(voiceTurnInference(workspace, 'dot', input)).toBe(turn.inference);
  expect(voiceTurnInstructions(workspace, 'dot', input).join(' ')).toContain(
    'English only',
  );
  setVoiceTurn(workspace, { ...turn, personality: 'calm' });
  expect(voiceTurnInstructions(workspace, 'dot', input).join(' ')).toContain(
    'calm, reassuring',
  );
  expect(
    voiceTurnInstructions(workspace, 'dot', {
      ...input,
      messages: [
        ...input.messages,
        { id: 'tool', role: 'tool', content: 'result' },
      ],
    }),
  ).toHaveLength(1);
  for (const changed of [
    { ...input, threadId: 'other' },
    { ...input, messages: [{ id: 'other', role: 'user', content: 'Hello' }] },
    {
      ...input,
      messages: [{ id: 'message', role: 'user', content: 'forged' }],
    },
  ]) {
    expect(voiceTurnInstructions(workspace, 'dot', changed)).toEqual([]);
    expect(voiceTurnInference(workspace, 'dot', changed)).toBeUndefined();
  }
  expect(voiceTurnInstructions({}, 'dot', input)).toEqual([]);
  expect(voiceTurnInference({}, 'dot', input)).toBeUndefined();
  expect(voiceTurnInstructions(workspace, 'other', input)).toEqual([]);
  expect(voiceTurnInference(workspace, 'other', input)).toBeUndefined();
  clearVoiceTurn(workspace, 'old-call');
  expect(voiceTurnInstructions(workspace, 'dot', input)).toHaveLength(1);
  clearVoiceTurn(workspace, 'call');
  expect(voiceTurnInstructions(workspace, 'dot', input)).toEqual([]);
  expect(voiceTurnInference(workspace, 'dot', input)).toBeUndefined();
});
