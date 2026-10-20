import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  canonicalVoiceAnswer,
  LiveVoiceCall,
  type VoiceWorkers,
} from '../src/server/local-voice/live';
import type { ConversationSnapshot } from '../src/server/local-conversations';
import type { LocalVoiceEvent } from '../src/shared/local-voice';
import { RecognitionInputError } from '../src/server/local-voice/worker';
const transcript = { messageId: 'voice-user', text: 'Hello Dot' };
function snapshot(messages: unknown[], status = 'finished') {
  return {
    messages,
    state: {},
    lastRun: { runId: 'run', status, input: { messages }, events: [] },
  } as unknown as ConversationSnapshot;
}
const user = { id: 'voice-user', role: 'user' as const, content: 'Hello Dot' };
const answer = { id: 'answer', role: 'assistant', content: 'Hello there.' };
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('ends the optional inference session when a call is cancelled during its warmup', async () => {
  let settle!: () => void;
  const inference = {
    warm: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    ),
    close: vi.fn(async () => {}),
  };
  const f = fixture(true, inference);
  const starting = f.call.start();
  const rejected = expect(starting).rejects.toThrow(/ended/i);
  await vi.waitFor(() => expect(inference.warm).toHaveBeenCalledOnce());
  await f.call.end();
  settle();
  await rejected;
  expect(inference.close).toHaveBeenCalledOnce();
  expect(f.port.receipt.mock.calls.some(([state]) => state === 'active')).toBe(
    false,
  );
});

it('closes inference and speech workers when inference warmup fails', async () => {
  const inference = {
    warm: vi.fn(async () => {
      throw new Error('Inference runtime unavailable');
    }),
    close: vi.fn(async () => {}),
  };
  const f = fixture(true, inference);
  await expect(f.call.start()).rejects.toThrow('Inference runtime unavailable');
  expect(f.call.ended).toBe(true);
  expect(inference.close).toHaveBeenCalledOnce();
  expect(f.recognition.close).toHaveBeenCalledOnce();
});

describe('canonical local voice answers', () => {
  it('speaks only the completed current user turn', () => {
    expect(canonicalVoiceAnswer(snapshot([user, answer]), transcript)).toEqual({
      state: 'ready',
      text: 'Hello there.',
    });
    expect(
      canonicalVoiceAnswer(snapshot([user, answer], 'running'), transcript)
        .state,
    ).toBe('waiting');
    expect(
      canonicalVoiceAnswer(
        snapshot([user, answer, { ...user, id: 'other' }]),
        transcript,
      ).state,
    ).toBe('stale');
    expect(
      canonicalVoiceAnswer(
        snapshot([{ ...user, content: 'forged' }, answer]),
        transcript,
      ).state,
    ).toBe('stale');
  });
  it('keeps approval/tool payloads out of speech', () => {
    const approval = {
      ...answer,
      content: '',
      toolCalls: [
        {
          id: 'approve',
          type: 'function',
          function: { name: 'review', arguments: '{"secret":"payload"}' },
        },
      ],
    };
    expect(
      canonicalVoiceAnswer(snapshot([user, approval]), transcript).state,
    ).toBe('approval');
    expect(
      canonicalVoiceAnswer(
        snapshot([user, { ...answer, content: '{"answer":"payload"}' }]),
        transcript,
      ).state,
    ).toBe('silent');
    expect(
      canonicalVoiceAnswer(snapshot([user, answer], 'failed'), transcript)
        .state,
    ).toBe('stale');
  });
  it('rejects a completed or running run for a different user message', () => {
    for (const status of ['finished', 'running']) {
      const saved = snapshot([user, answer], status);
      saved.lastRun!.input.messages = [{ ...user, id: 'other' }];
      expect(canonicalVoiceAnswer(saved, transcript).state).toBe('stale');
    }
  });
  it('does not replay an earlier assistant preamble after a completed tool result', () => {
    const toolCall = {
      ...answer,
      id: 'call',
      content: '',
      toolCalls: [
        {
          id: 'tool',
          type: 'function',
          function: { name: 'read', arguments: '{}' },
        },
      ],
    };
    expect(
      canonicalVoiceAnswer(
        snapshot([
          user,
          answer,
          toolCall,
          {
            id: 'result',
            role: 'tool',
            toolCallId: 'tool',
            content: 'private tool output',
          },
        ]),
        transcript,
      ).state,
    ).toBe('silent');
  });
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  listen = true,
  inference?: {
    warm(signal: AbortSignal): Promise<void>;
    close(): Promise<void>;
  },
) {
  const events: LocalVoiceEvent[] = [];
  let probability = 0;
  const recognition = {
    warm: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    transcribe: vi.fn(async () => ({
      text: 'Hello Dot',
      language: 'en',
      segments: [],
    })),
  };
  const vad = {
    warm: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    detect: vi.fn(async () => probability),
    reset: vi.fn(async () => {}),
  };
  const synthesis = {
    warm: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    synthesize: vi.fn(async () => Buffer.alloc(3840)),
  };
  const release = vi.fn();
  const port = {
    voiceTurn: vi.fn(),
    requireThread: vi.fn(() => ({ dotId: 'dot' })),
    paused: () => false,
    foreground: vi.fn(async (): Promise<() => void> => release),
    snapshot: vi.fn(async () => snapshot([])),
    stop: vi.fn(async () => {}),
    receipt: vi.fn(),
    delivery: vi.fn(),
  };
  const createWorkers = vi.fn((): VoiceWorkers => ({
    recognition,
    vad,
    synthesis,
    ...(inference ? { inference } : {}),
  }));
  const call = new LiveVoiceCall(
    { id: 'call', token: 'token', threadId: 'thread', dotId: 'dot' },
    port,
    createWorkers,
  );
  if (listen)
    call.listen(async (event) => {
      events.push(event);
    });
  let sequence = 0;
  return {
    call,
    port,
    events,
    recognition,
    createWorkers,
    vad,
    synthesis,
    release,
    frame: () => call.frame(sequence++, Buffer.alloc(1024)),
    speech: (value: number) => {
      probability = value;
    },
  };
}
async function capture(f: ReturnType<typeof fixture>) {
  f.speech(1);
  for (let i = 0; i < 6; i++) await f.frame();
  f.speech(0);
  for (let i = 0; i < 23; i++) await f.frame();
}
async function utterance(f: ReturnType<typeof fixture>) {
  const before = f.events.filter((event) => event.type === 'transcript').length;
  await capture(f);
  await vi.waitFor(() =>
    expect(
      f.events.filter((event) => event.type === 'transcript'),
    ).toHaveLength(before + 1),
  );
  const event = f.events.findLast((event) => event.type === 'transcript')!;
  if (event.type !== 'transcript') throw Error();
  f.port.snapshot.mockResolvedValue(
    snapshot([{ ...user, id: event.messageId }, answer]),
  );
  return event;
}
it('records recognition failure and recovery without a fabricated playback time or private error', async () => {
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const f = fixture();
  f.recognition.transcribe.mockRejectedValue(Error('PRIVATE worker error'));
  try {
    await f.call.start();
    await capture(f);
    await vi.waitFor(() => expect(f.call.ended).toBe(true));
    const rows = logs.mock.calls
      .filter(([name]) => name === '[voice-timing]')
      .map(([, row]) => JSON.parse(row));
    expect(rows.map((row) => row.stage)).toEqual(
      expect.arrayContaining([
        'speech_end_detected',
        'recognition_started',
        'recognition_restarting',
        'recognition_failed',
        'call_failed',
      ]),
    );
    expect(new Set(rows.map((row) => row.messageId)).size).toBe(1);
    expect(rows.some((row) => row.event === 'first_playback')).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
  } finally {
    await f.call.end();
  }
});

it('does not attribute stale playback acknowledgements to a new turn or treat cancellation as playback failure', async () => {
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const f = fixture();
  try {
    await f.call.start();
    const first = await utterance(f);
    await f.call.commitText(first.messageId, 'a', 0, 'Saved sentence.');
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.type === 'audio')).toBe(true),
    );
    const audio = f.events.find((event) => event.type === 'audio')!;
    if (audio.type !== 'audio') throw Error('Expected audio');
    await f.call.interrupt();
    const second = await utterance(f);
    await f.call.played(audio.generation, audio.sequence, 960);
    const rows = logs.mock.calls
      .filter(([name]) => name === '[voice-timing]')
      .map(([, row]) => JSON.parse(row));
    expect(rows.find((row) => row.stage === 'interrupted')?.messageId).toBe(
      first.messageId,
    );
    expect(
      rows.some(
        (row) =>
          row.messageId === second.messageId &&
          row.stage === 'transcript_ready',
      ),
    ).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.event === 'first_playback' || row.stage === 'playback_failed',
      ),
    ).toBe(false);
  } finally {
    await f.call.end();
  }
});

it('plays saved text spans before the answer completes and never repeats the final answer', async () => {
  const f = fixture();
  await f.call.start();
  try {
    const turn = await utterance(f);
    f.port.snapshot.mockResolvedValue(
      snapshot([{ ...user, id: turn.messageId }], 'running'),
    );
    await f.call.commitText(
      turn.messageId,
      'stream-answer',
      0,
      'First sentence. ',
    );
    await vi.waitFor(() =>
      expect(f.events.some((e) => e.type === 'audio')).toBe(true),
    );
    expect(f.synthesis.synthesize).toHaveBeenCalledTimes(1);
    await f.call.commitText(
      turn.messageId,
      'stream-answer',
      1,
      'Second sentence.',
    );
    await f.call.answer(turn.messageId);
    expect(f.synthesis.synthesize).toHaveBeenCalledTimes(1);
    for (const e of [...f.events])
      if (e.type === 'audio')
        await f.call.played(
          e.generation,
          e.sequence,
          Buffer.from(e.pcm, 'base64').length / 2,
        );
    await vi.waitFor(() =>
      expect(f.synthesis.synthesize).toHaveBeenCalledTimes(2),
    );
    f.call.finishText(turn.messageId);
    for (const e of [...f.events])
      if (e.type === 'audio')
        await f.call.played(
          e.generation,
          e.sequence,
          Buffer.from(e.pcm, 'base64').length / 2,
        );
    f.port.snapshot.mockResolvedValue(
      snapshot([
        { ...user, id: turn.messageId },
        { ...answer, content: 'First sentence. Second sentence.' },
      ]),
    );
    await f.call.answer(turn.messageId);
    expect(f.synthesis.synthesize).toHaveBeenCalledTimes(2);
  } finally {
    await f.call.end();
  }
});

it('discards unplayed spans and late commits when inference fails or the caller interrupts', async () => {
  const f = fixture();
  await f.call.start();
  try {
    const turn = await utterance(f);
    await f.call.commitText(turn.messageId, 'a', 0, 'Saved sentence.');
    await vi.waitFor(() =>
      expect(f.events.some((e) => e.type === 'audio')).toBe(true),
    );
    await f.call.commitText(turn.messageId, 'a', 1, 'Queued sentence.');
    f.call.finishText(turn.messageId, true);
    await vi.waitFor(() =>
      expect(f.events.some((e) => e.type === 'notice')).toBe(true),
    );
    await f.call.commitText(turn.messageId, 'a', 2, 'Late sentence.');
    expect(f.synthesis.synthesize).toHaveBeenCalledTimes(1);
    expect(f.call.ended).toBe(false);
    await f.call.interrupt();
    await f.call.commitText(turn.messageId, 'a', 3, 'Stale sentence.');
    expect(f.synthesis.synthesize).toHaveBeenCalledTimes(1);
  } finally {
    await f.call.end();
  }
});

it('records a turn that starts with speaker mute without claiming playback completed', async () => {
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const f = fixture();
  try {
    await f.call.start();
    await f.call.speaker(true);
    const turn = await utterance(f);
    await f.call.commitText(turn.messageId, 'a', 0, 'Saved but muted.');
    f.call.finishText(turn.messageId);
    const rows = logs.mock.calls
      .filter(([name]) => name === '[voice-timing]')
      .map(([, row]) => JSON.parse(row));
    expect(rows.some((row) => row.stage === 'speaker_muted')).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.stage === 'playback_finished' || row.event === 'first_playback',
      ),
    ).toBe(false);
  } finally {
    await f.call.end();
  }
});

it('warms interrupted synthesis before the next answer and reuses that warmup across another interruption', async () => {
  const f = fixture();
  f.synthesis.synthesize.mockResolvedValue(Buffer.alloc(1920));
  const warming = deferred<void>();
  const replacement = {
    warm: vi.fn(() => warming.promise),
    close: vi.fn(async () => {}),
    synthesize: vi.fn(async () => Buffer.alloc(1920)),
  };
  f.createWorkers.mockReturnValue({
    recognition: f.recognition,
    vad: f.vad,
    synthesis: replacement,
  });
  try {
    await f.call.start();
    const first = await utterance(f);
    await f.call.commitText(first.messageId, 'first', 0, 'First response.');
    await vi.waitFor(() =>
      expect(f.events.filter((e) => e.type === 'audio')).toHaveLength(1),
    );
    await f.call.interrupt();
    await vi.waitFor(() => expect(replacement.warm).toHaveBeenCalledOnce());
    await f.call.speaker(true);
    await f.call.speaker(false);
    // Transcription and agent dispatch proceed while the replacement is still warming.
    const second = await utterance(f);
    await f.call.commitText(
      second.messageId,
      'second',
      0,
      'Now stale response.',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replacement.synthesize).not.toHaveBeenCalled();
    await f.call.interrupt();
    const third = await utterance(f);
    await f.call.commitText(third.messageId, 'third', 0, 'Current response.');
    expect(replacement.warm).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    warming.resolve();
    await vi.waitFor(() =>
      expect(f.events.filter((e) => e.type === 'audio')).toHaveLength(2),
    );
    expect(replacement.synthesize).toHaveBeenCalledExactlyOnceWith(
      'Current response.',
      expect.any(AbortSignal),
    );
    expect(f.synthesis.close).toHaveBeenCalledOnce();
  } finally {
    warming.resolve();
    await f.call.end();
  }
  expect(replacement.close).toHaveBeenCalledOnce();
});

it('has the replacement ready before the next provider answer and records no remaining recovery wait', async () => {
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const f = fixture();
  const warming = deferred<void>();
  const replacement = {
    warm: vi.fn(() => warming.promise),
    close: vi.fn(async () => {}),
    synthesize: vi.fn(async () => Buffer.alloc(1920)),
  };
  f.createWorkers.mockReturnValue({
    recognition: f.recognition,
    vad: f.vad,
    synthesis: replacement,
  });
  const trace = () =>
    logs.mock.calls
      .filter(([name]) => name === '[voice-timing]')
      .map(([, row]) => JSON.parse(row));
  try {
    await f.call.start();
    const first = await utterance(f);
    await f.call.commitText(first.messageId, 'first', 0, 'Initial response.');
    await vi.waitFor(() =>
      expect(f.events.some((e) => e.type === 'audio')).toBe(true),
    );
    await f.call.interrupt();
    const next = await utterance(f);
    warming.resolve();
    await vi.waitFor(() =>
      expect(trace().some((row) => row.stage === 'synthesis_ready')).toBe(true),
    );
    await f.call.commitText(next.messageId, 'next', 0, 'Next response.');
    await vi.waitFor(() =>
      expect(replacement.synthesize).toHaveBeenCalledOnce(),
    );
    const rows = trace();
    const ready = rows.findIndex((row) => row.stage === 'synthesis_ready');
    const saved = rows.findIndex(
      (row) => row.messageId === next.messageId && row.stage === 'text_saved',
    );
    expect(ready).toBeGreaterThan(0);
    expect(saved).toBeGreaterThan(ready);
    expect(rows[ready].messageId).toBe(first.messageId);
    expect(
      rows.some(
        (row) =>
          row.messageId === next.messageId &&
          row.stage === 'synthesis_wait_started',
      ),
    ).toBe(false);
    expect(replacement.warm).toHaveBeenCalledOnce();
  } finally {
    warming.resolve();
    await f.call.end();
  }
});

it.each(['closing', 'warming'] as const)(
  'hangup during synthesis recovery %s never resurrects a worker or audio',
  async (phase) => {
    const f = fixture();
    const closing = deferred<void>();
    const warming = deferred<void>();
    const replacement = {
      warm: vi.fn(() => warming.promise),
      close: vi.fn(async () => {}),
      synthesize: vi.fn(async () => Buffer.alloc(1920)),
    };
    f.createWorkers.mockReturnValue({
      recognition: f.recognition,
      vad: f.vad,
      synthesis: replacement,
    });
    try {
      await f.call.start();
      const turn = await utterance(f);
      await f.call.commitText(turn.messageId, 'a', 0, 'Initial response.');
      await vi.waitFor(() =>
        expect(f.events.some((e) => e.type === 'audio')).toBe(true),
      );
      if (phase === 'closing')
        f.synthesis.close.mockImplementation(() => closing.promise);
      const stopping = f.call.interrupt();
      if (phase === 'warming')
        await vi.waitFor(() => expect(replacement.warm).toHaveBeenCalledOnce());
      const ended = f.call.end();
      closing.resolve();
      await Promise.all([stopping, ended]);
      if (phase === 'closing') expect(replacement.warm).not.toHaveBeenCalled();
      else expect(replacement.close).toHaveBeenCalledOnce();
      const count = f.events.filter((e) => e.type === 'audio').length;
      warming.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(replacement.synthesize).not.toHaveBeenCalled();
      expect(f.events.filter((e) => e.type === 'audio')).toHaveLength(count);
    } finally {
      closing.resolve();
      warming.resolve();
      await f.call.end();
    }
  },
);

it('handles early synthesis warmup failure once and closes the call without leaking worker errors', async () => {
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const f = fixture();
  const replacement = {
    warm: vi.fn(async () => {
      throw Error('PRIVATE warmup error');
    }),
    close: vi.fn(async () => {}),
    synthesize: vi.fn(async () => Buffer.alloc(1920)),
  };
  f.createWorkers.mockReturnValue({
    recognition: f.recognition,
    vad: f.vad,
    synthesis: replacement,
  });
  try {
    await f.call.start();
    const turn = await utterance(f);
    await f.call.commitText(turn.messageId, 'a', 0, 'First response.');
    await vi.waitFor(() =>
      expect(f.events.some((e) => e.type === 'audio')).toBe(true),
    );
    await f.call.interrupt();
    await vi.waitFor(() => expect(f.call.ended).toBe(true));
    await f.call.end();
    expect(replacement.warm).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(replacement.synthesize).not.toHaveBeenCalled();
    const rows = logs.mock.calls
      .filter(([name]) => name === '[voice-timing]')
      .map(([, row]) => JSON.parse(row));
    expect(rows.some((row) => row.stage === 'synthesis_recovery_failed')).toBe(
      true,
    );
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
    expect(JSON.stringify(f.events)).not.toContain('PRIVATE');
  } finally {
    await f.call.end();
  }
});

it('bounds committed speech, keeps code out of audio, and honors speaker mute', async () => {
  const f = fixture();
  await f.call.start();
  try {
    const turn = await utterance(f);
    await f.call.speaker(true);
    await f.call.commitText(turn.messageId, 'a', 0, 'Muted sentence.');
    expect(f.synthesis.synthesize).not.toHaveBeenCalled();
    await f.call.speaker(false);
    await f.call.commitText('other-user', 'a', 1, 'Wrong turn.');
    await expect(
      (async () =>
        await f.call.commitText(turn.messageId, 'a', 2, 'Skipped sequence.'))(),
    ).rejects.toThrow();
    await f.call.commitText(turn.messageId, 'a', 1, '```javascript');
    await f.call.commitText(turn.messageId, 'a', 2, 'private code');
    f.call.finishText(turn.messageId);
    expect(f.synthesis.synthesize).not.toHaveBeenCalled();
  } finally {
    await f.call.end();
  }
});
it('selects English explicitly and keeps listening after an unreadable utterance', async () => {
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const f = fixture();
  f.recognition.transcribe.mockRejectedValueOnce(
    new RecognitionInputError('invalid_timestamp', 'invalid_timestamp'),
  );
  await f.call.start();
  try {
    await capture(f);
    await vi.waitFor(() =>
      expect(f.events.some((e) => e.type === 'notice')).toBe(true),
    );
    expect(f.call.ended).toBe(false);
    expect(f.recognition.close).not.toHaveBeenCalled();
    expect(f.events.some((e) => e.type === 'transcript')).toBe(false);
    const rows = logs.mock.calls
      .filter(([name]) => name === '[voice-timing]')
      .map(([, row]) => JSON.parse(row));
    expect(
      rows.find((row) => row.event === 'recognition_result'),
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'invalid_timestamp',
      fallbackReason: 'invalid_timestamp',
      audioMs: 896,
    });
    await utterance(f);
    expect(f.recognition.transcribe).toHaveBeenLastCalledWith(
      expect.any(Buffer),
      'en',
      expect.any(AbortSignal),
      expect.any(String),
    );
  } finally {
    await f.call.end();
  }
});

it('distinguishes empty recognition from recovered decoding without logging words', async () => {
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const f = fixture();
  f.recognition.transcribe.mockResolvedValueOnce({
    text: '',
    language: 'en',
    segments: [],
  });
  f.recognition.transcribe.mockImplementationOnce(async () => ({
    text: 'PRIVATE decoded words',
    language: 'en',
    segments: [],
    fallbackReason: 'invalid_timestamp' as const,
  }));
  try {
    await f.call.start();
    await capture(f);
    await vi.waitFor(() =>
      expect(
        logs.mock.calls.some(([, row]) =>
          String(row).includes('"outcome":"empty"'),
        ),
      ).toBe(true),
    );
    expect(
      f.events.some(
        (event) => event.type === 'notice' || event.type === 'transcript',
      ),
    ).toBe(false);
    await utterance(f);
    const rows = logs.mock.calls
      .filter(([name]) => name === '[voice-timing]')
      .map(([, row]) => JSON.parse(row));
    expect(rows.find((row) => row.outcome === 'decoded')).toMatchObject({
      fallbackReason: 'invalid_timestamp',
    });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
    expect(f.events.find((event) => event.type === 'transcript')).toMatchObject(
      { text: 'PRIVATE decoded words' },
    );
  } finally {
    await f.call.end();
  }
});
it('keeps conversation prose out of the live decoder and preserves its recognized words', async () => {
  const f = fixture();
  f.port.snapshot.mockResolvedValue(
    snapshot([
      {
        id: 'prior',
        role: 'user',
        content: 'Where are the best mountain views in Sapa?',
      },
      {
        id: 'answer',
        role: 'assistant',
        content: 'Try Fansipan for the views.',
      },
    ]),
  );
  f.recognition.transcribe.mockResolvedValue({
    text: 'Best fuel.',
    language: 'en',
    segments: [],
  });
  await f.call.start();
  try {
    await capture(f);
    await vi.waitFor(() =>
      expect(f.events.some((e) => e.type === 'transcript')).toBe(true),
    );
    expect(f.recognition.transcribe).toHaveBeenCalledWith(
      expect.any(Buffer),
      'en',
      expect.any(AbortSignal),
      '',
    );
    expect(f.events.find((e) => e.type === 'transcript')).toMatchObject({
      text: 'Best fuel.',
    });
  } finally {
    await f.call.end();
  }
});
it('does not wait for conversation storage before recognition', async () => {
  const f = fixture();
  f.port.snapshot.mockImplementation(() => new Promise(() => {}));
  await f.call.start();
  try {
    await capture(f);
    await vi.waitFor(() =>
      expect(f.events.some((e) => e.type === 'transcript')).toBe(true),
    );
    expect(f.recognition.transcribe).toHaveBeenCalledWith(
      expect.any(Buffer),
      'en',
      expect.any(AbortSignal),
      '',
    );
    expect(f.port.snapshot).not.toHaveBeenCalled();
    expect(f.recognition.transcribe).toHaveBeenCalledTimes(1);
  } finally {
    await f.call.end();
  }
});
it.each(['interrupt', 'end'] as const)(
  'owns replacement recognition through %s during recovery warmup',
  async (action) => {
    vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const f = fixture();
    const warming = deferred<void>();
    const replacement = {
      ...f.recognition,
      warm: vi.fn(() => warming.promise),
      close: vi.fn(async () => {}),
      transcribe: vi.fn(async () => ({
        text: 'Hello Dot',
        language: 'en',
        segments: [],
      })),
    };
    f.createWorkers.mockReturnValue({
      recognition: replacement,
      vad: f.vad,
      synthesis: f.synthesis,
    });
    f.recognition.transcribe.mockRejectedValueOnce(Error('worker exited'));
    await f.call.start();
    try {
      await capture(f);
      await vi.waitFor(() => expect(replacement.warm).toHaveBeenCalledTimes(1));
      await f.call[action]();
      warming.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(replacement.transcribe).not.toHaveBeenCalled();
      expect(f.events.some((e) => e.type === 'transcript')).toBe(false);
      const rows = logs.mock.calls
        .filter(([name]) => name === '[voice-timing]')
        .map(([, row]) => JSON.parse(row));
      expect(rows.some((row) => row.outcome === 'superseded')).toBe(true);
      expect(rows.some((row) => row.outcome === 'engine_failed')).toBe(false);
      if (action === 'end') expect(replacement.close).toHaveBeenCalledTimes(1);
      else {
        expect(f.call.ended).toBe(false);
        expect(f.events.findLast((e) => e.type === 'phase')).toMatchObject({
          phase: 'listening',
        });
        expect(f.events.findLast((e) => e.type === 'notice')).toMatchObject({
          text: expect.stringContaining('ready'),
        });
        await utterance(f);
      }
    } finally {
      warming.resolve();
      await f.call.end();
    }
  },
);

it('does not report an engine failure when hangup aborts recognition recovery', async () => {
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const f = fixture();
  const replacement = {
    ...f.recognition,
    warm: vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    ),
  };
  f.createWorkers.mockReturnValue({
    recognition: replacement,
    vad: f.vad,
    synthesis: f.synthesis,
  });
  f.recognition.transcribe.mockRejectedValueOnce(Error('worker exited'));
  try {
    await f.call.start();
    await capture(f);
    await vi.waitFor(() => expect(replacement.warm).toHaveBeenCalledOnce());
    await f.call.end();
    await vi.waitFor(() =>
      expect(
        logs.mock.calls.some(([, row]) =>
          String(row).includes('"outcome":"superseded"'),
        ),
      ).toBe(true),
    );
    const rows = logs.mock.calls
      .filter(([name]) => name === '[voice-timing]')
      .map(([, row]) => JSON.parse(row));
    expect(
      rows.some(
        (row) =>
          row.outcome === 'engine_failed' || row.stage === 'recognition_failed',
      ),
    ).toBe(false);
  } finally {
    await f.call.end();
  }
});

it('still fails the active call if replacement warmup fails after an interruption', async () => {
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const f = fixture();
  let failWarm!: (error: Error) => void;
  const replacement = {
    ...f.recognition,
    warm: vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          failWarm = reject;
        }),
    ),
  };
  f.createWorkers.mockReturnValue({
    recognition: replacement,
    vad: f.vad,
    synthesis: f.synthesis,
  });
  f.recognition.transcribe.mockRejectedValueOnce(Error('worker exited'));
  try {
    await f.call.start();
    await capture(f);
    await vi.waitFor(() => expect(replacement.warm).toHaveBeenCalledOnce());
    await f.call.interrupt();
    failWarm(Error('PRIVATE real startup failure'));
    await vi.waitFor(() => expect(f.call.ended).toBe(true));
    const rows = logs.mock.calls
      .filter(([name]) => name === '[voice-timing]')
      .map(([, row]) => JSON.parse(row));
    expect(rows.some((row) => row.outcome === 'engine_failed')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
  } finally {
    await f.call.end();
  }
});

it('identifies a post-decoding persistence failure separately from a recognizer failure', async () => {
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const f = fixture();
  try {
    await f.call.start();
    f.port.voiceTurn.mockImplementation((turn?: unknown) => {
      if (turn) throw Error('PRIVATE persistence detail');
    });
    await capture(f);
    await vi.waitFor(() => expect(f.call.ended).toBe(true));
    const rows = logs.mock.calls
      .filter(([name]) => name === '[voice-timing]')
      .map(([, row]) => JSON.parse(row));
    expect(rows.some((row) => row.outcome === 'decoded')).toBe(true);
    expect(rows.some((row) => row.outcome === 'pipeline_failed')).toBe(true);
    expect(rows.some((row) => row.outcome === 'engine_failed')).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
  } finally {
    await f.call.end();
  }
});
it('replaces only a failed recognizer once, retries the same utterance once, and bounds recovery', async () => {
  const f = fixture();
  const replacement = {
    ...f.recognition,
    warm: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    transcribe: vi.fn(async () => ({
      text: 'Hello Dot',
      language: 'en',
      segments: [],
    })),
  };
  f.createWorkers.mockReturnValue({
    recognition: replacement,
    vad: f.vad,
    synthesis: f.synthesis,
  });
  f.recognition.transcribe.mockRejectedValueOnce(Error('worker exited'));
  await f.call.start();
  try {
    await utterance(f);
    expect(f.call.ended).toBe(false);
    expect(f.recognition.close).toHaveBeenCalledTimes(1);
    expect(replacement.warm).toHaveBeenCalledTimes(1);
    expect(replacement.transcribe.mock.calls.at(0)?.at(0)).toBe(
      f.recognition.transcribe.mock.calls.at(0)?.at(0),
    );
    expect(f.vad.close).not.toHaveBeenCalled();
    expect(f.synthesis.close).not.toHaveBeenCalled();
    replacement.transcribe.mockRejectedValueOnce(Error('worker exited again'));
    await capture(f);
    await vi.waitFor(() => expect(f.call.ended).toBe(true));
    expect(f.createWorkers).toHaveBeenCalledTimes(2);
  } finally {
    await f.call.end();
  }
});
describe('local call supervision', () => {
  it('records unused prefetched speech on barge-in without counting stale playback acknowledgements', async () => {
    const f = fixture();
    await f.call.start();
    try {
      const event = await utterance(f);
      f.port.snapshot.mockResolvedValue(
        snapshot([
          { ...user, id: event.messageId },
          { ...answer, content: 'First sentence. Second sentence.' },
        ]),
      );
      await f.call.answer(event.messageId);
      await vi.waitFor(() =>
        expect(f.synthesis.synthesize).toHaveBeenCalledTimes(2),
      );
      const audio = f.events.filter((event) => event.type === 'audio');
      expect(audio).toHaveLength(2);
      await f.call.played(audio[0].generation, audio[0].sequence, 960);

      f.speech(1);
      for (let i = 0; i < 3; i++) await f.frame();
      await vi.waitFor(() =>
        expect(f.synthesis.close).toHaveBeenCalledTimes(1),
      );
      await f.call.played(audio[1].generation, audio[1].sequence, 960);
      expect(f.events.filter((event) => event.type === 'audio')).toHaveLength(
        2,
      );
      expect(f.recognition.close).not.toHaveBeenCalled();
      expect(f.vad.close).not.toHaveBeenCalled();
      await f.call.end();
      expect(f.port.delivery).toHaveBeenLastCalledWith([
        {
          messageId: event.messageId,
          generation: audio[0].generation,
          generatedSamples: 3840,
          queuedSamples: 1920,
          softwarePlayedSamples: 960,
          interrupted: true,
        },
      ]);
    } finally {
      await f.call.end();
    }
  });
  it('holds foreground through silence, bounds sequences, and cleans up exactly once', async () => {
    const f = fixture();
    await f.call.start();
    await f.frame();
    expect(f.release).not.toHaveBeenCalled();
    await expect(f.call.frame(0, Buffer.alloc(1024))).rejects.toThrow(
      /sequence/i,
    );
    await Promise.all([f.call.end(), f.call.end()]);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.recognition.close).toHaveBeenCalledTimes(1);
    expect(f.vad.close).toHaveBeenCalledTimes(1);
  });
  it('commits final speech once and rejects replayed answer notifications', async () => {
    const f = fixture();
    await f.call.start();
    f.speech(1);
    for (let i = 0; i < 6; i++) await f.frame();
    f.speech(0);
    for (let i = 0; i < 23; i++) await f.frame();
    await vi.waitFor(() =>
      expect(f.events.some((e) => e.type === 'transcript')).toBe(true),
    );
    const event = f.events.find((e) => e.type === 'transcript')!;
    if (event.type !== 'transcript') throw Error();
    expect(f.recognition.transcribe).toHaveBeenCalledTimes(1);
    f.port.snapshot.mockResolvedValue(
      snapshot([{ ...user, id: event.messageId }, answer]),
    );
    await f.call.answer(event.messageId);
    await f.call.answer(event.messageId);
    await vi.waitFor(() =>
      expect(f.events.some((e) => e.type === 'audio')).toBe(true),
    );
    expect(f.synthesis.synthesize).toHaveBeenCalledTimes(1);
    await f.call.interrupt();
    expect(f.port.stop).toHaveBeenCalledWith(event.messageId);
    expect(f.events.some((e) => e.type === 'flush')).toBe(true);
    await f.call.end();
  });
  it('discards muted microphone frames and never turns provisional speech into a message', async () => {
    const f = fixture();
    await f.call.start();
    f.speech(1);
    await f.frame();
    await f.frame();
    await f.call.mute(true);
    for (let i = 0; i < 30; i++) await f.frame();
    expect(f.recognition.transcribe).not.toHaveBeenCalled();
    await f.call.end();
  });
  it('deduplicates overlapping answer polls after their snapshot reads complete', async () => {
    const f = fixture();
    await f.call.start();
    const event = await utterance(f);
    const read = deferred<ConversationSnapshot>();
    f.port.snapshot.mockReturnValue(read.promise);
    const polls = [
      f.call.answer(event.messageId),
      f.call.answer(event.messageId),
    ];
    read.resolve(snapshot([{ ...user, id: event.messageId }, answer]));
    await Promise.all(polls);
    expect(f.events.filter((event) => event.type === 'caption')).toHaveLength(
      1,
    );
    await f.call.end();
  });
  it('preserves an unsubmitted transcript across speaker mute and checkpoints it', async () => {
    const f = fixture();
    await f.call.start();
    const event = await utterance(f);
    expect(f.port.receipt).toHaveBeenLastCalledWith('active', 'You: Hello Dot');
    await f.call.speaker(true);
    expect(f.events.findLast((event) => event.type === 'flush')).toMatchObject({
      keepTranscript: true,
    });
    await f.call.answer(event.messageId);
    expect(f.events.filter((event) => event.type === 'caption')).toHaveLength(
      1,
    );
    expect(f.synthesis.synthesize).not.toHaveBeenCalled();
    expect(f.port.stop).not.toHaveBeenCalled();
    await f.call.end();
  });
  it('bounds startup and releases a foreground reservation that arrives after timeout', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const foreground = deferred<() => void>();
    f.port.foreground.mockReturnValue(foreground.promise);
    const start = expect(f.call.start()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120001);
    expect(f.call.ended).toBe(true);
    await start;
    foreground.resolve(f.release);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.recognition.warm).not.toHaveBeenCalled();
    await f.call.end();
  });
  it('ends once when a slow event reader exceeds the write bound', async () => {
    const f = fixture(false);
    const blocked = deferred<void>();
    f.call.listen(() => blocked.promise);
    await f.call.start();
    for (let i = 0; i < 26 && !f.call.ended; i++) await f.call.interrupt(false);
    expect(f.call.ended).toBe(true);
    blocked.resolve();
    await f.call.end();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(
      f.port.receipt.mock.calls.filter(([state]) => state === 'failed'),
    ).toHaveLength(1);
  });
  it('releases foreground immediately even while a worker is still reaping', async () => {
    const f = fixture();
    await f.call.start();
    const closed = deferred<void>();
    f.recognition.close.mockReturnValue(closed.promise);
    const ending = f.call.end();
    expect(f.release).toHaveBeenCalledTimes(1);
    closed.resolve();
    await ending;
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('bounds recognition to one decode plus one queued utterance', async () => {
    const f = fixture();
    await f.call.start();
    const decode = deferred<{
      text: string;
      language: string;
      segments: never[];
    }>();
    f.recognition.transcribe.mockReturnValue(decode.promise);
    await capture(f);
    await capture(f);
    await expect(capture(f)).rejects.toThrow(/queue|busy/i);
    expect(f.recognition.transcribe).toHaveBeenCalledTimes(1);
    await f.call.end();
    decode.resolve({ text: 'late', language: 'en', segments: [] });
  });
  it('bounds committed turns even when speaker mute creates no deliveries', async () => {
    const f = fixture();
    await f.call.start();
    await f.call.speaker(true);
    for (let i = 0; i < 100; i++) await utterance(f);
    await capture(f);
    await vi.waitFor(() => expect(f.call.ended).toBe(true));
    expect(
      f.events.filter((event) => event.type === 'transcript'),
    ).toHaveLength(100);
    await f.call.end();
  });
  it('discards a pre-mute detector result and serializes overlapping resets', async () => {
    const f = fixture();
    await f.call.start();
    f.speech(1);
    await f.frame();
    await f.frame();
    const detected = deferred<number>();
    const reset = deferred<void>();
    f.vad.detect.mockReturnValueOnce(detected.promise);
    f.vad.reset.mockReturnValueOnce(reset.promise);
    const frame = f.frame();
    const mute = f.call.mute(true);
    const unmute = f.call.mute(false);
    detected.resolve(1);
    await frame;
    await Promise.resolve();
    await Promise.resolve();
    expect(f.vad.reset).toHaveBeenCalledTimes(1);
    reset.resolve();
    await Promise.all([mute, unmute]);
    const flushes = f.events.filter((event) => event.type === 'flush').length;
    await f.frame();
    await f.frame();
    expect(f.events.filter((event) => event.type === 'flush')).toHaveLength(
      flushes,
    );
    await f.call.end();
  });
  it('preserves an in-flight transcription when only the speaker is muted', async () => {
    const f = fixture();
    await f.call.start();
    const decode = deferred<{
      text: string;
      language: string;
      segments: never[];
    }>();
    f.recognition.transcribe.mockReturnValue(decode.promise);
    await capture(f);
    await f.call.speaker(true);
    decode.resolve({
      text: 'Keep this transcript',
      language: 'en',
      segments: [],
    });
    await vi.waitFor(() =>
      expect(
        f.events.some(
          (event) =>
            event.type === 'transcript' &&
            event.text === 'Keep this transcript',
        ),
      ).toBe(true),
    );
    await f.call.end();
  });
  it('bounds caption events while leaving the full canonical response intact', async () => {
    const f = fixture();
    await f.call.start();
    const event = await utterance(f);
    const saved = snapshot([
      { ...user, id: event.messageId },
      { ...answer, content: 'Very long answer. '.repeat(10000) },
    ]);
    f.port.snapshot.mockResolvedValue(saved);
    await f.call.answer(event.messageId);
    const caption = f.events.find((event) => event.type === 'caption');
    expect(caption?.type).toBe('caption');
    expect(Buffer.byteLength(JSON.stringify(caption))).toBeLessThan(64000);
    if (caption?.type === 'caption')
      expect(caption.text).toContain('The rest is in the chat.');
    expect(saved.messages.at(-1)?.content).toHaveLength(180000);
    await f.call.end();
  });
});
