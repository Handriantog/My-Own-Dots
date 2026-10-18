import { randomUUID } from 'node:crypto';
import type { RecognitionReason } from './recognition-diagnostics.js';

/** Server-internal feasibility interface; never expose this object to a renderer. */
export interface PrototypePlatform {
  workspace: { requireThread(id: string): { dotId: string } };
  memory?: {
    enterForeground(
      signal: AbortSignal,
      threadId?: string,
    ): Promise<() => void>;
  };
  turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string>;
}
export interface Transcript {
  text: string;
  language: string;
  segments: { startMs: number; endMs: number; text: string }[];
  fallbackReason?: RecognitionReason;
}
export interface SpeechEngine {
  warm(signal: AbortSignal): Promise<void>;
  transcribe(
    pcm: Buffer,
    language: 'en' | 'id' | 'auto',
    signal: AbortSignal,
    context?: string,
  ): Promise<Transcript>;
  synthesize(text: string, signal: AbortSignal): Promise<Buffer>;
  close(): Promise<void>;
}
export interface AudioFrame {
  callId: string;
  turnId: string;
  sequence: number;
  sampleOffset: number;
  sampleRate: 24000;
  channels: 1;
  format: 'pcm_s16le';
  textSpan: { start: number; end: number };
  pcm: Buffer;
}
export interface AudioSink {
  /** Resolve when accepted, not when physically heard. At most one write is pending. */
  write(frame: AudioFrame, signal: AbortSignal): Promise<void>;
  /** Discard queued/active audio; resolve only after software flush acknowledgement. */
  flush(callId: string): Promise<void>;
}
export interface CommittedAudio {
  utteranceId: string;
  pcm: Buffer;
  sampleRate: 16000;
  channels: 1;
  language: 'en' | 'id' | 'auto';
}

// Includes warmup and silence. No second call can acquire the same Platform.
const calls = new WeakSet<PrototypePlatform>();
export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
  });
}

export class LocalVoicePrototype {
  readonly callId = randomUUID();
  state:
    | 'idle'
    | 'connecting'
    | 'ready'
    | 'thinking'
    | 'speaking'
    | 'interrupted'
    | 'ended'
    | 'error' = 'idle';
  private readonly controller = new AbortController();
  private readonly committed = new Set<string>();
  private dotId?: string;
  private release?: () => void;
  private closing?: Promise<void>;
  private ownsCall = false;
  constructor(
    private readonly platform: PrototypePlatform,
    private readonly threadId: string,
    private readonly engine: SpeechEngine,
    private readonly sink: AudioSink,
  ) {}

  async start(): Promise<void> {
    if (this.state !== 'idle') throw new Error('Call already started');
    if (calls.has(this.platform))
      throw new Error('A voice call is already active');
    this.dotId = this.platform.workspace.requireThread(this.threadId).dotId;
    calls.add(this.platform);
    this.ownsCall = true;
    this.state = 'connecting';
    try {
      // Do not race reservation acquisition: even a late acquisition must be released.
      this.release = await this.platform.memory?.enterForeground(
        this.controller.signal,
        this.threadId,
      );
      if (this.controller.signal.aborted) {
        this.release?.();
        this.release = undefined;
      }
      this.controller.signal.throwIfAborted();
      await abortable(
        this.engine.warm(this.controller.signal),
        this.controller.signal,
      );
      this.controller.signal.throwIfAborted();
      this.state = 'ready';
    } catch (error) {
      await this.close('error').catch(() => {});
      throw error;
    }
  }

  async commit(input: CommittedAudio) {
    if (this.committed.has(input.utteranceId))
      throw new Error('Utterance already committed');
    if (this.state !== 'ready') throw new Error('Call is busy or unavailable');
    if (
      this.platform.workspace.requireThread(this.threadId).dotId !== this.dotId
    )
      throw new Error('Thread scope changed');
    if (input.sampleRate !== 16000 || input.channels !== 1)
      throw new Error(
        'Input must be PCM16 mono at 16 kHz; resample explicitly',
      );
    if (
      !Buffer.isBuffer(input.pcm) ||
      !input.pcm.length ||
      input.pcm.length % 2 ||
      input.pcm.length > 960000
    )
      throw new Error('Input must contain at most 30 seconds of aligned PCM16');
    if (
      !/^[\w-]{1,100}$/.test(input.utteranceId) ||
      !['en', 'id', 'auto'].includes(input.language)
    )
      throw new Error('Invalid utterance identity or language');
    if (this.committed.size >= 100)
      throw new Error('Prototype call turn limit reached');
    this.committed.add(input.utteranceId);
    this.state = 'thinking';
    const signal = this.controller.signal;
    const turnId = randomUUID();
    const timings: Record<string, number> = { fileEnd: performance.now() };
    try {
      const transcript = await abortable(
        this.engine.transcribe(input.pcm, input.language, signal),
        signal,
      );
      signal.throwIfAborted();
      if (!transcript.text.trim() || transcript.text.length > 4000)
        throw new Error('Recognition returned empty or oversized text');
      timings.transcriptCommitted = performance.now();
      if (
        this.platform.workspace.requireThread(this.threadId).dotId !==
        this.dotId
      )
        throw new Error('Thread scope changed');
      timings.modelStart = performance.now();
      const text = await abortable(
        this.platform.turn(this.threadId, transcript.text, signal, {
          opendotsSource: 'local_voice_prototype',
          callId: this.callId,
          turnId,
          utteranceId: input.utteranceId,
          language: transcript.language,
        }),
        signal,
      );
      signal.throwIfAborted();
      timings.firstValidText = performance.now();
      // A feasibility bound, not silent truncation of canonical assistant history.
      if (typeof text !== 'string' || !text.trim() || text.length > 400)
        throw new Error(
          'Prototype speech supports 1–400 characters; full answer remains in chat',
        );
      const pcm = await abortable(this.engine.synthesize(text, signal), signal);
      signal.throwIfAborted();
      if (
        !Buffer.isBuffer(pcm) ||
        !pcm.length ||
        pcm.length % 2 ||
        pcm.length > 1440000
      )
        throw new Error('Invalid or oversized output PCM');
      timings.firstPcm = performance.now();
      this.state = 'speaking';
      let acceptedSamples = 0;
      for (
        let offset = 0, sequence = 0;
        offset < pcm.length;
        offset += 1920, sequence++
      ) {
        signal.throwIfAborted();
        const chunk = pcm.subarray(offset, Math.min(offset + 1920, pcm.length));
        await abortable(
          this.sink.write(
            {
              callId: this.callId,
              turnId,
              sequence,
              sampleOffset: offset / 2,
              sampleRate: 24000,
              channels: 1,
              format: 'pcm_s16le',
              textSpan: { start: 0, end: text.length },
              pcm: chunk,
            },
            signal,
          ),
          signal,
        );
        signal.throwIfAborted();
        acceptedSamples += chunk.length / 2;
      }
      timings.outputAccepted = performance.now();
      this.state = 'ready';
      return {
        callId: this.callId,
        turnId,
        transcript,
        text,
        timings,
        delivery: {
          generatedSamples: pcm.length / 2,
          acceptedSamples,
          playedSamples: null,
        },
      };
    } catch (error) {
      await this.close('error').catch(() => {});
      throw error;
    }
  }

  interrupt(): Promise<void> {
    return this.close('interrupted');
  }
  end(): Promise<void> {
    return this.close('ended');
  }
  private close(state: 'interrupted' | 'ended' | 'error'): Promise<void> {
    if (this.closing) return this.closing;
    this.state = state;
    this.controller.abort(
      new DOMException(`Voice call ${state}`, 'AbortError'),
    );
    this.closing = (async () => {
      try {
        const results = await Promise.allSettled([
          this.engine.close(),
          this.sink.flush(this.callId),
        ]);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } finally {
        this.release?.();
        this.release = undefined;
        if (this.ownsCall) calls.delete(this.platform);
        this.ownsCall = false;
      }
    })();
    return this.closing;
  }
}
