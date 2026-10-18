/** Content-free diagnostics. All durations use the server's monotonic clock. */
import { recognitionReasons } from './recognition-diagnostics.js';

const stages = [
  'speech_end_detected',
  'recognition_started',
  'recognition_finished',
  'recognition_restarting',
  'recognition_failed',
  'recognition_discarded',
  'transcript_ready',
  'run_requested',
  'agent_started',
  'context_started',
  'context_ready',
  'provider_queued',
  'provider_started',
  'first_validated_text',
  'provider_finished',
  'provider_failed',
  'provider_cancelled',
  'adapter_failed',
  'adapter_cancelled',
  'text_saved',
  'canonical_answer_ready',
  'synthesis_started',
  'synthesis_restarting',
  'synthesis_ready',
  'synthesis_recovery_failed',
  'synthesis_wait_started',
  'synthesis_wait_finished',
  'first_audio_generated',
  'first_audio_queued',
  'first_playback_ack',
  'playback_finished',
  'playback_failed',
  'playback_timeout',
  'run_finished',
  'run_failed',
  'approval_wait',
  'silent',
  'speaker_muted',
  'interrupted',
  'call_ended',
  'call_failed',
] as const;
type Stage = (typeof stages)[number];
const intervals: [string, Stage | undefined, Stage][] = [
  ['endDetectionMs', undefined, 'speech_end_detected'],
  ['recognitionQueueMs', 'speech_end_detected', 'recognition_started'],
  ['recognitionMs', 'recognition_started', 'recognition_finished'],
  ['transcriptToRunMs', 'transcript_ready', 'run_requested'],
  ['runnerWaitMs', 'run_requested', 'agent_started'],
  ['agentSetupMs', 'agent_started', 'context_started'],
  ['firstContextMs', 'context_started', 'context_ready'],
  ['firstSchedulerWaitMs', 'provider_queued', 'provider_started'],
  ['providerToFirstTextMs', 'provider_started', 'first_validated_text'],
  ['textPersistenceMs', 'first_validated_text', 'text_saved'],
  ['speechQueueMs', 'text_saved', 'synthesis_started'],
  ['recoveryWaitMs', 'synthesis_wait_started', 'synthesis_wait_finished'],
  ['firstSynthesisMs', 'synthesis_started', 'first_audio_generated'],
  ['audioDispatchMs', 'first_audio_generated', 'first_audio_queued'],
  ['playbackAckMs', 'first_audio_queued', 'first_playback_ack'],
];
const round = (value: number) => Math.round(value * 1000) / 1000;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

export class VoiceTurnTiming {
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly write: (row: string) => void;
  private readonly seen = new Set<string>();
  private readonly first = new Map<Stage, number>();
  private rows = 0;
  private steps = 0;
  constructor(
    private readonly callId: string,
    private readonly messageId: string,
    private readonly origin = performance.now(),
    options: {
      enabled?: boolean;
      now?: () => number;
      write?: (row: string) => void;
    } = {},
  ) {
    this.enabled =
      options.enabled ?? process.env.LOCAL_VOICE_TIMING_LOG === '1';
    this.now = options.now ?? (() => performance.now());
    this.write =
      options.write ?? ((row) => console.info('[voice-timing]', row));
  }
  nextStep() {
    return ++this.steps;
  }
  recognitionResult(
    outcome:
      | 'decoded'
      | 'empty'
      | 'rejected'
      | 'superseded'
      | 'engine_failed'
      | 'pipeline_failed',
    details: unknown,
  ) {
    if (
      !this.enabled ||
      this.rows >= 256 ||
      ![
        'decoded',
        'empty',
        'rejected',
        'superseded',
        'engine_failed',
        'pipeline_failed',
      ].includes(outcome)
    )
      return;
    const key = `recognition:${outcome}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const input = object(details);
    const fields: Record<string, string | number> = {};
    for (const [name, max] of [
      ['audioMs', 30000],
      ['contextChars', 600],
    ] as const) {
      const value = input[name];
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= max
      )
        fields[name] = round(value);
    }
    for (const name of ['reason', 'fallbackReason']) {
      const value = input[name];
      if (recognitionReasons.some((reason) => reason === value))
        fields[name] = String(value);
    }
    this.emit({
      event: 'recognition_result',
      outcome,
      elapsedMs: round(Math.max(0, this.now() - this.origin)),
      ...fields,
    });
  }
  mark(stage: Stage, step = 0) {
    if (
      !this.enabled ||
      !stages.includes(stage) ||
      !Number.isSafeInteger(step) ||
      step < 0 ||
      this.rows >= 256
    )
      return;
    const key = `${step}:${stage}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const elapsedMs = Math.max(0, this.now() - this.origin);
    if (!this.first.has(stage)) this.first.set(stage, elapsedMs);
    this.emit({ event: 'stage', stage, step, elapsedMs: round(elapsedMs) });
    if (stage === 'first_playback_ack') {
      const durations: Record<string, number> = {};
      for (const [name, from, to] of intervals) {
        const start = from ? this.first.get(from) : 0;
        const end = this.first.get(to);
        if (start !== undefined && end !== undefined && end >= start)
          durations[name] = round(end - start);
      }
      this.emit({
        event: 'first_playback',
        elapsedMs: round(elapsedMs),
        durations,
      });
    }
  }
  providerResult(response: unknown, step: number) {
    if (!this.enabled || this.rows >= 256) return;
    const source = object(response);
    const timings: Record<
      string,
      number | boolean | string | Record<string, number | null>
    > = {};
    const input = object(source.timings);
    for (const key of ['startupMs', 'inferenceMs', 'totalMs', 'firstTextMs']) {
      const value = input[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
        timings[key] = round(value);
    }
    for (const key of ['reusedRuntime', 'reusedProvider'])
      if (typeof input[key] === 'boolean') timings[key] = input[key];
    if (input.delivery === 'incremental' || input.delivery === 'buffered')
      timings.delivery = input.delivery;
    const phaseInput = object(input.phases);
    const phases: Record<string, number | null> = {};
    for (const key of [
      'lockWaitMs',
      'preparationMs',
      'accountReadMs',
      'requirementsReadMs',
      'configReadMs',
      'threadConfigReadMs',
      'threadCreateMs',
      'turnStartAckMs',
      'firstDeltaMs',
      'firstValidatedTextMs',
      'turnCompletedMs',
      'textCallbackMs',
      'cleanupMs',
      'totalMs',
    ]) {
      const value = phaseInput[key];
      if (
        (value === null &&
          (key === 'firstDeltaMs' || key === 'firstValidatedTextMs')) ||
        (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      )
        phases[key] = value;
    }
    if (Object.keys(phases).length) timings.phases = phases;
    const usage: Record<string, number> = {};
    const counts = object(source.usage);
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'reasoningOutputTokens',
      'totalTokens',
      'input_tokens',
      'output_tokens',
      'cached_input_tokens',
      'reasoning_output_tokens',
      'total_tokens',
    ]) {
      const value = counts[key];
      if (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        usage[key] = value;
    }
    this.emit({
      event: 'provider_result',
      step,
      elapsedMs: round(Math.max(0, this.now() - this.origin)),
      timings,
      usage,
    });
  }
  private emit(data: Record<string, unknown>) {
    if (this.rows++ >= 256) return;
    try {
      this.write(
        JSON.stringify({
          version: 1,
          at: new Date().toISOString(),
          callId: this.callId,
          messageId: this.messageId,
          ...data,
        }),
      );
    } catch {
      /* Diagnostics must never terminate or delay a call on sink failure. */
    }
  }
}
