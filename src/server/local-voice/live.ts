import { randomUUID } from 'node:crypto';
import type { ConversationSnapshot } from '../local-conversations.js';
import type {
  LocalVoiceEvent,
  VoiceDelivery,
} from '../../shared/local-voice.js';
import type { Transcript } from './prototype.js';
import { RecognitionInputError } from './worker.js';
import { playSpeechOutput } from './speech-output.js';
import { VoiceTurnTiming } from './timing.js';

type Utterance = {
  messageId: string;
  text: string;
  generation: number;
  timing: VoiceTurnTiming;
  answered?: boolean;
  output?: {
    assistantId: string;
    nextSequence: number;
    chars: number;
    caption: string;
    queue: { text: string; sequence: number }[];
    draining: boolean;
    complete: boolean;
    suppressed: boolean;
  };
};
/** Only canonical, completed assistant prose for this exact final transcript. */
export function canonicalVoiceAnswer(
  snapshot: ConversationSnapshot,
  utterance: { messageId: string; text: string },
): {
  state: 'waiting' | 'approval' | 'stale' | 'silent' | 'ready';
  text?: string;
} {
  const lastUser = snapshot.messages.findLast((m) => m.role === 'user');
  const runUser = snapshot.lastRun?.input.messages.findLast(
    (m) => m.role === 'user',
  );
  if (
    !lastUser ||
    lastUser.id !== utterance.messageId ||
    runUser?.id !== utterance.messageId ||
    runUser.content !== lastUser.content ||
    typeof lastUser.content !== 'string' ||
    !(
      lastUser.content === utterance.text ||
      lastUser.content.endsWith(`\n\n${utterance.text}`)
    )
  )
    return { state: 'stale' };
  if (snapshot.lastRun?.status === 'running') return { state: 'waiting' };
  if (snapshot.lastRun?.status !== 'finished') return { state: 'stale' };
  const messages = snapshot.messages.slice(
    snapshot.messages.indexOf(lastUser) + 1,
  );
  const answered = new Set(
    messages.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : [])),
  );
  if (
    messages.some(
      (m) =>
        m.role === 'assistant' && m.toolCalls?.some((t) => !answered.has(t.id)),
    )
  )
    return { state: 'approval' };
  const message = messages.at(-1);
  if (
    !message ||
    message.role !== 'assistant' ||
    message.toolCalls?.length ||
    typeof message.content !== 'string'
  )
    return { state: 'silent' };
  const raw = message.content.trim();
  // Never turn structured envelopes, code, or hidden reasoning into audio.
  if (!raw || /^[{[]/.test(raw) || /<(?:think|analysis|tool_call)\b/i.test(raw))
    return { state: 'silent' };
  const text = raw
    .replace(/```[\s\S]*?```/g, ' Code is available in the chat. ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>* -]+/gm, '')
    .replace(/[*_`]/g, '')
    .trim();
  return text ? { state: 'ready', text } : { state: 'silent' };
}

/** Cancellation must not wait for a database read or scheduler acquisition. */
export function waitForVoiceOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
interface WarmWorker {
  warm(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface VoiceWorkers {
  inference?: WarmWorker;
  recognition: WarmWorker & {
    transcribe(
      pcm: Buffer,
      language: 'en',
      signal: AbortSignal,
      context?: string,
    ): Promise<Transcript>;
  };
  synthesis: WarmWorker & {
    synthesize(text: string, signal: AbortSignal): Promise<Buffer>;
  };
  vad: WarmWorker & {
    detect(pcm: Buffer, signal: AbortSignal): Promise<number>;
    reset(signal: AbortSignal): Promise<void>;
  };
}
export interface VoiceCallPort {
  voiceTurn?(utterance?: {
    messageId: string;
    text: string;
    timing?: VoiceTurnTiming;
  }): void;
  requireThread(): { dotId: string };
  paused(): boolean;
  foreground(signal: AbortSignal): Promise<() => void>;
  snapshot(): Promise<ConversationSnapshot>;
  stop(messageId: string): Promise<void>;
  receipt(
    status: 'active' | 'ended' | 'failed',
    transcript: string,
    error?: string,
  ): void;
  delivery(rows: VoiceDelivery[]): void;
}
export class LiveVoiceCall {
  private readonly controller = new AbortController();
  private workers: VoiceWorkers;
  private release?: () => void;
  private closing?: Promise<void>;
  private starting?: Promise<void>;
  private listener?: (event: LocalVoiceEvent) => Promise<void>;
  private writes = 0;
  private ready = false;
  private inputSequence = 0;
  private inputBusy?: Promise<void>;
  private inputReset?: Promise<void>;
  private inputEpoch = 0;
  private muted = false;
  private speakerMuted = false;
  private generation = 0;
  private outputSequence = 0;
  private positives = 0;
  private silence = 0;
  private speaking = false;
  private lastVoiceAt = performance.now();
  private recognizingTiming?: VoiceTurnTiming;
  private preRoll: Buffer[] = [];
  private frames: Buffer[] = [];
  private utterance?: Utterance;
  private recognizing?: Promise<void>;
  private queuedRecognition = false;
  private recognitionGeneration = 0;
  private recognitionRestarts = 0;
  private committedTurns = 0;
  private stopping: Promise<void> = Promise.resolve();
  private synthesisClosed = false;
  private synthesisWarming?: Promise<void>;
  private outputActive = false;
  private outputController = new AbortController();
  private pending = new Map<
    number,
    {
      generation: number;
      samples: number;
      delivery: VoiceDelivery;
      timing: VoiceTurnTiming;
      resolve(): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private deliveries: VoiceDelivery[] = [];
  private transcript = '';
  private startedAt = Date.now();
  private lastSeen = Date.now();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly scope: {
      id: string;
      token: string;
      threadId: string;
      dotId: string;
    },
    private readonly port: VoiceCallPort,
    private readonly createWorkers: () => VoiceWorkers,
  ) {
    this.workers = createWorkers();
  }
  get ended() {
    return this.controller.signal.aborted;
  }
  get endSignal(): AbortSignal {
    return this.controller.signal;
  }
  get connected() {
    return Boolean(this.listener);
  }
  private check() {
    this.controller.signal.throwIfAborted();
    if (
      this.port.paused() ||
      this.port.requireThread().dotId !== this.scope.dotId
    )
      throw Error('Call scope is unavailable');
  }
  touch() {
    this.check();
    this.lastSeen = Date.now();
  }
  listen(listener: (event: LocalVoiceEvent) => Promise<void>) {
    if (this.listener) throw Error('Call already has a listener');
    this.listener = listener;
    if (this.ready) this.emit({ type: 'phase', phase: 'listening' });
    return () => {
      this.listener = undefined;
      void this.end('Call connection closed.');
    };
  }
  private emit(event: LocalVoiceEvent) {
    if (!this.listener) return;
    if (this.writes >= 24) {
      if (!this.ended) void this.end('Call connection fell behind.');
      return;
    }
    this.writes++;
    void this.listener(event)
      .catch(() => {
        void this.end('Call connection closed.');
      })
      .finally(() => {
        this.writes--;
      });
  }
  start(): Promise<void> {
    return (this.starting ??= this.begin());
  }
  private async begin() {
    const timeout = setTimeout(() => {
      void this.end('Local speech startup timed out.');
    }, 120000);
    timeout.unref?.();
    try {
      this.check();
      const foreground = this.port
        .foreground(this.controller.signal)
        .then((release) => {
          if (this.ended) release();
          else this.release = release;
        });
      await waitForVoiceOperation(foreground, this.controller.signal);
      this.check();
      await waitForVoiceOperation(
        Promise.all([
          this.workers.recognition.warm(this.controller.signal),
          this.workers.synthesis.warm(this.controller.signal),
          this.workers.vad.warm(this.controller.signal),
          this.workers.inference?.warm(this.controller.signal),
        ]),
        this.controller.signal,
      );
      this.check();
      this.ready = true;
      this.lastSeen = Date.now();
      this.port.receipt('active', '');
      this.emit({ type: 'phase', phase: 'listening' });
      this.timer = setInterval(() => {
        try {
          this.check();
          if (
            Date.now() - this.lastSeen > 10000 ||
            Date.now() - this.startedAt > 15 * 60_000
          )
            void this.end('Call expired.');
        } catch {
          void this.end('Call is no longer available.');
        }
      }, 2000);
      this.timer.unref?.();
    } catch (error) {
      await this.end(
        'The call could not start. Check the local speech and inference runtimes.',
      );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  async frame(sequence: number, pcm: Buffer) {
    this.touch();
    if (!this.ready || this.inputBusy || this.inputReset)
      throw Error('Audio input is busy');
    if (sequence !== this.inputSequence) throw Error('Invalid input sequence');
    if (pcm.length !== 1024)
      throw Error('Audio frame must contain 512 PCM16 samples');
    this.inputSequence++;
    const work = this.processFrame(pcm);
    this.inputBusy = work;
    try {
      await work;
    } finally {
      if (this.inputBusy === work) this.inputBusy = undefined;
    }
  }
  private async processFrame(pcm: Buffer) {
    if (this.muted) return;
    const inputEpoch = this.inputEpoch;
    const probability = await this.workers.vad.detect(
      pcm,
      this.controller.signal,
    );
    if (this.muted || this.ended || inputEpoch !== this.inputEpoch) return;
    const voiced = probability >= 0.5;
    if (voiced) this.lastVoiceAt = performance.now();
    if (!this.speaking) {
      this.preRoll.push(pcm);
      if (this.preRoll.length > 8) this.preRoll.shift();
      this.positives = voiced ? this.positives + 1 : 0;
      if (this.positives < 3) return;
      this.speaking = true;
      this.silence = 0;
      this.frames = this.preRoll;
      this.preRoll = [];
      void this.interrupt().catch(() => {
        void this.end('Could not stop the previous response.');
      });
      this.emit({ type: 'phase', phase: 'listening' });
      return;
    }
    this.frames.push(pcm);
    this.silence = voiced ? 0 : this.silence + 1;
    if (this.frames.length >= 937 || this.silence >= 22) {
      const messageId = randomUUID();
      const timing = new VoiceTurnTiming(
        this.scope.id,
        messageId,
        this.lastVoiceAt,
      );
      timing.mark('speech_end_detected');
      const audio = Buffer.concat(this.frames);
      this.resetInput();
      const generation = this.recognitionGeneration;
      const previous = this.recognizing;
      if (previous && this.queuedRecognition)
        throw Error('Recognition queue is busy');
      if (previous) this.queuedRecognition = true;
      let recognitionInProgress = false;
      const work = (async () => {
        try {
          await previous;
        } finally {
          if (previous) this.queuedRecognition = false;
        }
        await this.stopping;
        if (this.ended || generation !== this.recognitionGeneration) {
          timing.recognitionResult('superseded', {
            audioMs: audio.length / 32,
          });
          timing.mark('recognition_discarded');
          return;
        }
        this.recognizingTiming = timing;
        this.emit({ type: 'phase', phase: 'thinking' });
        timing.mark('recognition_started');
        recognitionInProgress = true;
        const result = await this.recognize(audio, generation, timing);
        recognitionInProgress = false;
        timing.mark('recognition_finished');
        if (
          this.ended ||
          generation !== this.recognitionGeneration ||
          !result
        ) {
          if (result)
            timing.recognitionResult('superseded', {
              audioMs: audio.length / 32,
            });
          timing.mark('recognition_discarded');
          return;
        }
        const text = result.text.trim();
        if (!text) {
          timing.mark('recognition_discarded');
          this.emit({ type: 'phase', phase: 'listening' });
          return;
        }
        if (text.length > 4000) throw Error('Transcript exceeds limit');
        if (this.committedTurns >= 100) throw Error('Call turn limit reached');
        this.committedTurns++;
        this.utterance = {
          messageId,
          text,
          timing,
          generation: this.generation,
        };
        this.port.voiceTurn?.(this.utterance);
        this.checkpoint(`You: ${text}`);
        timing.mark('transcript_ready');
        this.emit({
          type: 'transcript',
          messageId,
          text,
          generation: this.utterance.generation,
        });
      })();
      this.recognizing = work;
      void work
        .catch(() => {
          // Hangup cancels call-owned workers. A newer utterance only makes
          // old PCM stale; it must not hide a failed replacement worker.
          if (this.ended) {
            timing.recognitionResult('superseded', {
              audioMs: audio.length / 32,
            });
            timing.mark('recognition_discarded');
            return;
          }
          timing.recognitionResult(
            recognitionInProgress ? 'engine_failed' : 'pipeline_failed',
            {
              audioMs: audio.length / 32,
            },
          );
          timing.mark('recognition_failed');
          if (!this.ended)
            void this.end(
              'Speech recognition failed. Start a new call to retry.',
            );
        })
        .finally(() => {
          if (this.recognizingTiming === timing)
            this.recognizingTiming = undefined;
          if (this.recognizing === work) this.recognizing = undefined;
        });
    }
  }
  private async recognize(
    audio: Buffer,
    generation: number,
    timing: VoiceTurnTiming,
  ): Promise<Transcript | undefined> {
    const signal = this.controller.signal;
    // The pinned recognizer rejects more clips with conversation prose in its
    // prompt. Keep its fixed Dot-name hint; the agent still receives the full
    // canonical conversation when it interprets the resulting words.
    const context = '';
    if (generation !== this.recognitionGeneration) {
      timing.recognitionResult('superseded', { audioMs: audio.length / 32 });
      return;
    }
    const diagnostics = {
      audioMs: audio.length / 32,
      contextChars: context.length,
    };
    for (;;) {
      try {
        const result = await this.workers.recognition.transcribe(
          audio,
          'en',
          signal,
          context,
        );
        if (this.ended || generation !== this.recognitionGeneration) {
          timing.recognitionResult('superseded', diagnostics);
          return;
        }
        timing.recognitionResult(result.text.trim() ? 'decoded' : 'empty', {
          ...diagnostics,
          fallbackReason: result.fallbackReason,
        });
        return result;
      } catch (error) {
        if (this.ended || generation !== this.recognitionGeneration) {
          timing.recognitionResult('superseded', diagnostics);
          return;
        }
        if (error instanceof RecognitionInputError) {
          timing.recognitionResult('rejected', {
            ...diagnostics,
            reason: error.reason,
            fallbackReason: error.fallbackReason,
          });
          this.emit({ type: 'phase', phase: 'listening' });
          this.emit({
            type: 'notice',
            text: "I couldn't catch that. Please say it again.",
          });
          return;
        }
        // One supervised replacement per call; replay only uncommitted PCM.
        // A failed/stale decode can never duplicate a committed agent turn.
        if (this.recognitionRestarts >= 1) throw error;
        this.recognitionRestarts++;
        timing.mark('recognition_restarting');
        this.emit({
          type: 'notice',
          text: 'Reconnecting local speech recognition…',
        });
        await this.workers.recognition.close();
        if (this.ended) {
          timing.recognitionResult('superseded', diagnostics);
          return;
        }
        this.workers.recognition = this.createWorkers().recognition;
        await this.workers.recognition.warm(signal);
        if (this.ended) {
          timing.recognitionResult('superseded', diagnostics);
          return;
        }
        if (generation !== this.recognitionGeneration) {
          timing.recognitionResult('superseded', diagnostics);
          this.emit({ type: 'phase', phase: 'listening' });
          this.emit({
            type: 'notice',
            text: 'Speech recognition is ready. Please say that again.',
          });
          return;
        }
      }
    }
  }
  private resetInput() {
    this.frames = [];
    this.preRoll = [];
    this.speaking = false;
    this.positives = 0;
    this.silence = 0;
  }
  private checkpoint(line: string) {
    this.transcript =
      `${this.transcript}${this.transcript ? '\n' : ''}${line}`.slice(-20000);
    this.port.receipt('active', this.transcript);
  }
  async mute(value: boolean) {
    this.touch();
    this.muted = value;
    this.inputEpoch++;
    this.resetInput();
    const previous = this.inputReset;
    const work = (async () => {
      await previous;
      await this.inputBusy;
      if (!this.ended) await this.workers.vad.reset(this.controller.signal);
    })();
    this.inputReset = work;
    try {
      await work;
    } finally {
      if (this.inputReset === work) this.inputReset = undefined;
    }
  }
  async speaker(value: boolean) {
    this.touch();
    this.speakerMuted = value;
    if (value) await this.interrupt(false, 'speaker_muted');
  }
  async interrupt(
    stopRun = true,
    reason: 'interrupted' | 'speaker_muted' = 'interrupted',
  ) {
    if (this.ended) return;
    const utterance = this.utterance;
    if (utterance && (!utterance.answered || this.outputActive))
      utterance.timing.mark(reason);
    if (stopRun) this.recognizingTiming?.mark('interrupted');
    if (utterance?.output) utterance.output.queue = [];
    this.generation++;
    if (stopRun) this.port.voiceTurn?.();
    if (stopRun) this.recognitionGeneration++;
    this.utterance = stopRun
      ? undefined
      : utterance
        ? { ...utterance, generation: this.generation }
        : undefined;
    this.outputController.abort(new DOMException('Interrupted', 'AbortError'));
    this.outputController = new AbortController();
    for (const row of this.deliveries)
      if (row.softwarePlayedSamples < row.generatedSamples)
        row.interrupted = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.resolve();
    }
    this.pending.clear();
    this.emit({
      type: 'flush',
      generation: this.generation,
      ...(!stopRun ? { keepTranscript: true } : {}),
    });
    // Killing synthesis never reloads recognition or the detector.
    // A call-scoped warmup has no reply audio to cancel. Reuse it even when a
    // second reply is interrupted while waiting for the same replacement.
    const replace =
      this.outputActive && !this.synthesisClosed && !this.synthesisWarming;
    const closed = replace ? this.workers.synthesis.close() : Promise.resolve();
    if (replace) this.synthesisClosed = true;
    this.outputActive = false;
    this.stopping = this.stopping.then(async () => {
      await closed;
      if (replace) this.startSynthesisRecovery(utterance?.timing);
      if (stopRun && utterance) await this.port.stop(utterance.messageId);
    });
    await this.stopping;
  }
  private startSynthesisRecovery(timing?: VoiceTurnTiming) {
    if (this.ended || !this.synthesisClosed || this.synthesisWarming) return;
    timing?.mark('synthesis_restarting');
    // Only the replacement synthesis worker is opened. Recognition and the
    // provider keep running; this promise is deliberately outside `stopping`.
    this.workers.synthesis = this.createWorkers().synthesis;
    this.synthesisClosed = false;
    const worker = this.workers.synthesis;
    const signal = this.controller.signal;
    const warming = waitForVoiceOperation(
      Promise.resolve().then(() => worker.warm(signal)),
      signal,
    )
      .then(() => {
        signal.throwIfAborted();
        timing?.mark('synthesis_ready');
      })
      .catch((error: unknown) => {
        if (!this.ended) {
          timing?.mark('synthesis_recovery_failed');
          void this.end(
            'Local speech recovery failed. Start a new call to retry.',
          );
        }
        throw error;
      })
      .finally(() => {
        if (this.synthesisWarming === warming)
          this.synthesisWarming = undefined;
      });
    this.synthesisWarming = warming;
    // Early recovery can fail before any answer is waiting for it.
    void warming.catch(() => {});
  }
  /** Server-only: called after a validated text event has been durably saved. */
  commitText(
    messageId: string,
    assistantId: string,
    sequence: number,
    text: string,
  ) {
    const utterance = this.utterance;
    if (
      this.ended ||
      !utterance ||
      utterance.messageId !== messageId ||
      utterance.answered
    )
      return;
    this.check();
    if (!utterance.output) {
      if (sequence !== 0) throw Error('Invalid committed speech sequence');
      utterance.output = {
        assistantId,
        nextSequence: 0,
        chars: 0,
        caption: '',
        queue: [],
        draining: false,
        complete: false,
        suppressed: false,
      };
    }
    const output = utterance.output;
    if (output.complete) return;
    if (
      output.assistantId !== assistantId ||
      sequence !== output.nextSequence ||
      !Number.isSafeInteger(sequence) ||
      sequence >= 256 ||
      !text ||
      text.length > 400
    )
      throw Error('Invalid committed speech span');
    output.nextSequence++;
    utterance.timing.mark('text_saved');
    output.caption = (output.caption + text).slice(-6000);
    this.emit({ type: 'caption', text: output.caption });
    this.checkpoint(`Dot (generated): ${text}`);
    // A code fence may span records. Once one appears, leave the rest in chat.
    if (/```|<(?:think|analysis|tool_call)\b/i.test(text))
      output.suppressed = true;
    const spoken = /^[{[]/.test(text.trim())
      ? ''
      : text
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .replace(/^[#>* -]+/gm, '')
          .replace(/[*_`]/g, '')
          .trim();
    const remaining = Math.max(0, 6000 - output.chars);
    output.chars += spoken.length;
    if (remaining && spoken && !this.speakerMuted && !output.suppressed) {
      output.queue.push({ text: spoken.slice(0, remaining), sequence });
      this.drainText(utterance);
    }
  }
  finishText(messageId: string, failed = false) {
    const utterance = this.utterance;
    if (this.ended || !utterance || utterance.messageId !== messageId) return;
    if (!utterance.output) return;
    utterance.output.complete = true;
    utterance.answered = true;
    if (failed) {
      utterance.output.queue = [];
      void this.interrupt(false)
        .then(() => {
          if (this.ended || this.utterance?.messageId !== messageId) return;
          this.emit({
            type: 'notice',
            text: 'The response stopped. The saved part is in chat; please try again.',
          });
          this.emit({ type: 'phase', phase: 'listening' });
        })
        .catch(() => {
          void this.end('Could not stop speech playback.');
        });
    } else if (!utterance.output.draining) {
      this.markPlaybackFinished(utterance);
      if (!this.deliveries.some((row) => row.messageId === utterance.messageId))
        utterance.timing.mark(this.speakerMuted ? 'speaker_muted' : 'silent');
      this.emit({ type: 'phase', phase: 'listening' });
    }
  }
  private drainText(utterance: Utterance) {
    const output = utterance.output!;
    if (output.draining) return;
    output.draining = true;
    this.outputActive = true;
    void (async () => {
      while (
        output.queue.length &&
        !this.ended &&
        this.utterance === utterance &&
        utterance.generation === this.generation
      ) {
        const span = output.queue.shift()!;
        await this.speak(span.text, utterance, {
          assistantMessageId: output.assistantId,
          segmentSequence: span.sequence,
        });
      }
    })()
      .catch(() => {
        if (!this.ended && utterance.generation === this.generation) {
          utterance.timing.mark('playback_failed');
          void this.end(
            'Speech playback failed. The saved response is in chat.',
          );
        }
      })
      .finally(() => {
        output.draining = false;
        const current = this.utterance;
        if (this.ended || current?.output !== output) return;
        if (output.queue.length && !this.speakerMuted) {
          this.drainText(current);
          return;
        }
        if (utterance.generation !== this.generation) return;
        this.outputActive = false;
        if (output.complete) this.emit({ type: 'phase', phase: 'listening' });
        else this.emit({ type: 'phase', phase: 'thinking' });
      });
  }
  async answer(messageId: string) {
    this.touch();
    const utterance = this.utterance;
    if (!utterance || utterance.messageId !== messageId || utterance.answered)
      return;
    const result = canonicalVoiceAnswer(await this.port.snapshot(), utterance);
    if (this.utterance !== utterance || utterance.answered || this.ended)
      return;
    if (result.state === 'waiting') return;
    if (result.state === 'approval') {
      utterance.timing.mark('approval_wait');
      this.emit({ type: 'phase', phase: 'approval' });
      return;
    }
    if (result.state === 'stale') return;
    if (utterance.output) {
      this.finishText(messageId);
      return;
    }
    utterance.answered = true;
    if (result.state === 'silent') {
      utterance.timing.mark('silent');
      this.emit({ type: 'phase', phase: 'listening' });
      return;
    }
    const text =
      result.text!.length > 6000
        ? `${result.text!.slice(0, 5900)}. The rest is in the chat.`
        : result.text!;
    this.emit({ type: 'caption', text });
    utterance.timing.mark('canonical_answer_ready');
    this.checkpoint(`Dot (generated): ${text}`);
    if (this.speakerMuted) {
      utterance.timing.mark('speaker_muted');
      this.emit({ type: 'phase', phase: 'listening' });
      return;
    }
    this.outputActive = true;
    void this.speak(text, utterance)
      .finally(() => {
        if (utterance.generation === this.generation) this.outputActive = false;
      })
      .catch(() => {
        if (!this.ended && utterance.generation === this.generation) {
          utterance.timing.mark('playback_failed');
          void this.end(
            'Speech playback failed. The full response is saved in chat.',
          );
        }
      });
  }
  private async speak(
    text: string,
    utterance: Utterance,
    span?: { assistantMessageId: string; segmentSequence: number },
  ) {
    const signal = AbortSignal.any([
      this.controller.signal,
      this.outputController.signal,
    ]);
    await this.stopping;
    signal.throwIfAborted();
    if (this.synthesisClosed) this.startSynthesisRecovery(utterance.timing);
    if (this.synthesisWarming) {
      utterance.timing.mark('synthesis_wait_started');
      await waitForVoiceOperation(this.synthesisWarming, signal);
      utterance.timing.mark('synthesis_wait_finished');
    }
    signal.throwIfAborted();
    const synthesis = this.workers.synthesis;
    const delivery: VoiceDelivery = {
      messageId: utterance.messageId,
      generation: utterance.generation,
      generatedSamples: 0,
      queuedSamples: 0,
      softwarePlayedSamples: 0,
      interrupted: false,
      ...span,
    };
    this.deliveries.push(delivery);
    // Bound spoken output; the complete canonical answer remains in the transcript.
    const spoken =
      text.length > 6000
        ? `${text.slice(0, 5900)}. The rest is in the chat.`
        : text;
    await playSpeechOutput({
      text: spoken,
      signal,
      synthesize: (chunk, chunkSignal) => {
        utterance.timing.mark('synthesis_started');
        return synthesis.synthesize(chunk, chunkSignal);
      },
      generated: (samples) => {
        utterance.timing.mark('first_audio_generated');
        delivery.generatedSamples += samples;
        if (signal.aborted || utterance.generation !== this.generation)
          delivery.interrupted = true;
      },
      play: async (pcm, chunkSignal) => {
        this.emit({ type: 'phase', phase: 'speaking' });
        const inflight: Promise<void>[] = [];
        for (let offset = 0; offset < pcm.length; offset += 1920) {
          chunkSignal.throwIfAborted();
          if (inflight.length >= 4) await inflight.shift();
          chunkSignal.throwIfAborted();
          const frame = pcm.subarray(
            offset,
            Math.min(pcm.length, offset + 1920),
          );
          const sequence = this.outputSequence++;
          const ack = new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              utterance.timing.mark('playback_timeout');
              void this.end('Audio playback acknowledgement timed out.');
            }, 3000);
            this.pending.set(sequence, {
              generation: utterance.generation,
              samples: frame.length / 2,
              delivery,
              timing: utterance.timing,
              resolve,
              timer,
            });
          });
          inflight.push(ack);
          delivery.queuedSamples += frame.length / 2;
          utterance.timing.mark('first_audio_queued');
          this.emit({
            type: 'audio',
            generation: utterance.generation,
            sequence,
            pcm: frame.toString('base64'),
          });
        }
        await Promise.all(inflight);
        chunkSignal.throwIfAborted();
      },
    });
    this.port.delivery(this.deliveries);
    if (!span || (utterance.output?.complete && !utterance.output.queue.length))
      this.markPlaybackFinished(utterance);
    if (!span) this.emit({ type: 'phase', phase: 'listening' });
  }
  private markPlaybackFinished(utterance: Utterance) {
    const rows = this.deliveries.filter(
      (row) => row.messageId === utterance.messageId,
    );
    if (
      rows.length &&
      rows.every(
        (row) =>
          !row.interrupted &&
          row.generatedSamples > 0 &&
          row.generatedSamples === row.softwarePlayedSamples,
      )
    )
      utterance.timing.mark('playback_finished');
  }
  played(generation: number, sequence: number, samples: number) {
    this.touch();
    if (generation !== this.generation) return;
    const item = this.pending.get(sequence);
    if (!item) return;
    if (item.generation !== generation || item.samples !== samples)
      throw Error('Invalid playback acknowledgement');
    item.delivery.softwarePlayedSamples += samples;
    item.timing.mark('first_playback_ack');
    clearTimeout(item.timer);
    this.pending.delete(sequence);
    item.resolve();
  }
  end(error?: string): Promise<void> {
    if (this.closing) return this.closing;
    const utterance = this.utterance;
    utterance?.timing.mark(error ? 'call_failed' : 'call_ended');
    this.recognizingTiming?.mark(error ? 'call_failed' : 'call_ended');
    this.port.voiceTurn?.();
    this.utterance = undefined;
    // Assign before emitting/aborting: either boundary can synchronously end again.
    this.closing = Promise.resolve().then(async () => {
      try {
        await Promise.allSettled([
          this.workers.recognition.close(),
          this.workers.vad.close(),
          this.workers.inference?.close(),
          ...(this.synthesisClosed ? [] : [this.workers.synthesis.close()]),
          this.stopping.then(() =>
            utterance ? this.port.stop(utterance.messageId) : undefined,
          ),
        ]);
      } finally {
        this.port.delivery(this.deliveries);
        this.port.receipt(error ? 'failed' : 'ended', this.transcript, error);
      }
    });
    this.controller.abort(new DOMException('Call ended', 'AbortError'));
    this.release?.();
    this.release = undefined;
    clearInterval(this.timer);
    this.resetInput();
    this.generation++;
    this.emit({ type: 'flush', generation: this.generation });
    this.emit({ type: 'ended', ...(error ? { error } : {}) });
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.resolve();
    }
    this.pending.clear();
    for (const row of this.deliveries)
      if (row.softwarePlayedSamples < row.generatedSamples)
        row.interrupted = true;
    return this.closing;
  }
}
