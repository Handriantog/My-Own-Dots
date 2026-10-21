import { afterEach, expect, it, vi } from 'vitest';
import { VoiceTurnTiming } from '../src/server/local-voice/timing.js';

afterEach(() => vi.unstubAllEnvs());

it('identifies Basic turns and reports text completion without a playback measurement', () => {
  const rows: string[] = [];
  let now = 100;
  const trace = new VoiceTurnTiming('call', 'message', 100, {
    enabled: true,
    quality: 'basic',
    now: () => now,
    write: (row) => rows.push(row),
  });
  trace.mark('recognition_started');
  now = 300;
  trace.mark('recognition_finished');
  now = 1200;
  trace.mark('text_reply_complete');
  trace.mark('text_reply_complete');
  const decoded = rows.map((row) => JSON.parse(row));
  expect(decoded.every((row) => row.quality === 'basic')).toBe(true);
  expect(decoded.filter((row) => row.event === 'text_reply')).toEqual([
    expect.objectContaining({
      elapsedMs: 1100,
      durations: { recognitionMs: 200 },
    }),
  ]);
  expect(decoded.some((row) => row.event === 'first_playback')).toBe(false);
});

it('records distinct recognition outcomes with bounded content-free diagnostics', () => {
  const rows: string[] = [];
  const trace = new VoiceTurnTiming('call', 'message', 0, {
    enabled: true,
    now: () => 20,
    write: (row) => rows.push(row),
  });
  trace.recognitionResult('rejected', {
    audioMs: 832,
    contextChars: 600,
    reason: 'invalid_timestamp',
    fallbackReason: 'invalid_timestamp',
    text: 'PRIVATE',
    pcm: 'PRIVATE',
  });
  trace.recognitionResult('decoded', {
    audioMs: 3000,
    fallbackReason: 'invalid_timestamp',
  });
  trace.recognitionResult('empty', {
    audioMs: Infinity,
    contextChars: -1,
    reason: 'PRIVATE',
  });
  const decoded = rows.map((row) => JSON.parse(row));
  expect(decoded[0]).toMatchObject({
    event: 'recognition_result',
    outcome: 'rejected',
    audioMs: 832,
    contextChars: 600,
    reason: 'invalid_timestamp',
    fallbackReason: 'invalid_timestamp',
  });
  expect(decoded[1]).toMatchObject({
    outcome: 'decoded',
    fallbackReason: 'invalid_timestamp',
  });
  expect(decoded[2]).toMatchObject({ outcome: 'empty' });
  expect(decoded[2]).not.toHaveProperty('audioMs');
  expect(decoded[2]).not.toHaveProperty('contextChars');
  expect(rows.join('')).not.toContain('PRIVATE');
});

it('reports monotonic first-playback intervals without counting overlapping provider completion twice', () => {
  let now = 100;
  const rows: string[] = [];
  const trace = new VoiceTurnTiming('call', 'message', 100, {
    enabled: true,
    now: () => now,
    write: (row) => rows.push(row),
  });
  const mark = (
    at: number,
    stage: Parameters<typeof trace.mark>[0],
    step = 0,
  ) => {
    now = at;
    trace.mark(stage, step);
  };
  mark(800, 'speech_end_detected');
  mark(900, 'recognition_started');
  mark(1200, 'recognition_finished');
  mark(1210, 'transcript_ready');
  mark(1300, 'run_requested');
  mark(1350, 'agent_started');
  mark(1360, 'context_started', 1);
  mark(1380, 'context_ready', 1);
  mark(1380, 'provider_queued', 1);
  mark(1400, 'provider_started', 1);
  mark(6400, 'first_validated_text', 1);
  mark(6410, 'text_saved');
  mark(6420, 'synthesis_started');
  mark(6620, 'first_audio_generated');
  mark(6630, 'first_audio_queued');
  mark(6700, 'first_playback_ack');
  mark(6800, 'first_playback_ack'); // Later audio must not change first-playback timing.
  mark(7000, 'provider_finished', 1);
  const summaries = rows
    .map((row) => JSON.parse(row))
    .filter((row) => row.event === 'first_playback');
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({
    callId: 'call',
    messageId: 'message',
    elapsedMs: 6600,
    durations: {
      endDetectionMs: 700,
      recognitionQueueMs: 100,
      recognitionMs: 300,
      transcriptToRunMs: 90,
      runnerWaitMs: 50,
      agentSetupMs: 10,
      firstContextMs: 20,
      firstSchedulerWaitMs: 20,
      providerToFirstTextMs: 5000,
      textPersistenceMs: 10,
      speechQueueMs: 10,
      firstSynthesisMs: 200,
      audioDispatchMs: 10,
      playbackAckMs: 70,
    },
  });
});

it('logs partial failures, bounds repeated steps and filters provider metadata', () => {
  const rows: string[] = [];
  const trace = new VoiceTurnTiming('call', 'message', 0, {
    enabled: true,
    now: () => 10,
    write: (row) => rows.push(row),
  });
  trace.providerResult(
    {
      timings: {
        startupMs: 3,
        firstTextMs: 6,
        totalMs: 9,
        reusedProvider: false,
        delivery: 'incremental',
        prompt: 'PRIVATE',
        phases: {
          lockWaitMs: 2,
          preparationMs: 1,
          accountReadMs: 0.1,
          threadCreateMs: 0.2,
          firstDeltaMs: 3,
          firstValidatedTextMs: null,
          cleanupMs: -1,
          totalMs: NaN,
          textCallbackMs: 'PRIVATE',
          secret: 'PRIVATE',
        },
      },
      result: { text: 'PRIVATE' },
      usage: { inputTokens: 42, outputTokens: 7, secret: 'PRIVATE' },
    },
    1,
  );
  trace.mark('recognition_failed');
  for (let step = 1; step < 1000; step++) trace.mark('context_started', step);
  const decoded = rows.map((row) => JSON.parse(row));
  expect(decoded.find((row) => row.event === 'provider_result')).toMatchObject({
    step: 1,
    timings: {
      startupMs: 3,
      firstTextMs: 6,
      totalMs: 9,
      reusedProvider: false,
      delivery: 'incremental',
      phases: {
        lockWaitMs: 2,
        preparationMs: 1,
        accountReadMs: 0.1,
        threadCreateMs: 0.2,
        firstDeltaMs: 3,
        firstValidatedTextMs: null,
      },
    },
    usage: { inputTokens: 42, outputTokens: 7 },
  });
  expect(decoded.some((row) => row.stage === 'recognition_failed')).toBe(true);
  expect(decoded.some((row) => row.event === 'first_playback')).toBe(false);
  expect(rows.join('')).not.toContain('PRIVATE');
  expect(rows.length).toBeLessThanOrEqual(256);
});

it('is opt-in and logging failure cannot break a call', () => {
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '0');
  const write = vi.fn();
  new VoiceTurnTiming('call', 'message', 0, { write }).mark(
    'speech_end_detected',
  );
  expect(write).not.toHaveBeenCalled();
  const broken = new VoiceTurnTiming('call', 'message', 0, {
    enabled: true,
    write: () => {
      throw Error('disk unavailable');
    },
  });
  expect(() => broken.mark('speech_end_detected')).not.toThrow();
});
