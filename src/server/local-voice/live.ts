import { logDiagnostic, logError } from '../../shared/error-log.js';
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
import { isEndCallRequest } from './call-control.js';
import type {
  NativeTurnReply,
  NativeRoutingContext,
  NativeUnderstanding,
  NativeVoiceSession,
} from './native-contract.js';

// Input frames contain 512 samples at 16 kHz (32 ms each).
const interruptionSpeechFrames = Math.ceil(1500 / 32);
// Allow short word/phrase gaps, but never accumulate sparse detections forever.
const interruptionGapFrames = 8; // 256 ms; recorded speech pauses were 192 ms.
const interruptionWindowFrames = Math.ceil(2000 / 32);

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
  native?: NativeVoiceSession;
  inference?: WarmWorker;
  recognition?: WarmWorker & {
    transcribe(
      pcm: Buffer,
      language: 'en',
      signal: AbortSignal,
      context?: string,
    ): Promise<Transcript>;
  };
  synthesis?: WarmWorker & {
    synthesize(text: string, signal: AbortSignal): Promise<Buffer>;
  };
  vad: WarmWorker & {
    detect(pcm: Buffer, signal: AbortSignal): Promise<number>;
    reset(signal: AbortSignal): Promise<void>;
  };
}
export interface VoiceCallPort {
  nativeContext?(): Promise<NativeRoutingContext>;
  nativeTurn?(turn: {
    messageId: string;
    audio: Buffer;
    understanding: NativeUnderstanding;
    signal: AbortSignal;
  }): Promise<NativeTurnReply>;
  voiceTurn?(utterance?: {
    messageId: string;
    text: string;
    timing?: VoiceTurnTiming;
  }): void | Promise<void>;
  requireThread(): { dotId: string } | Promise<{ dotId: string }>;
  paused(): boolean | Promise<boolean>;
  foreground(signal: AbortSignal): Promise<() => void>;
  snapshot(): Promise<ConversationSnapshot>;
  stop(messageId: string): Promise<void>;
  receipt(
    status: 'active' | 'ended' | 'failed',
    transcript: string,
    error?: string,
  ): void | Promise<void>;
  delivery(rows: VoiceDelivery[]): void | Promise<void>;
  closed?(): void;
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
  private speechStartFrames = 3;
  private speechCandidateFrames = 0;
  private speechCandidateSilence = 0;
  private silence = 0;
  private speaking = false;
  private lastVoiceAt = performance.now();
  private recognizingTiming?: VoiceTurnTiming;
  private preRoll: Buffer[] = [];
  private frames: Buffer[] = [];
  private utterance?: Utterance;
  private nativeInputId?: string;
  private nativeApprovalInputId?: string;
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
  private seenUpdates = new Set<string>();
  private retainedUpdates = new Set<string>();
  private updates: {
    id: string;
    text: string;
    generation: number;
    authorization: Promise<() => Promise<boolean>>;
    retainUntilPlayed: boolean;
    deferred: boolean;
  }[] = [];
  constructor(
    readonly scope: {
      id: string;
      token: string;
      threadId: string;
      dotId: string;
      quality?: 'basic' | 'medium' | 'high';
    },
    private readonly port: VoiceCallPort,
    private readonly createWorkers: () => VoiceWorkers,
  ) {
    this.workers = createWorkers();
  }
  get ended() {
    return this.controller.signal.aborted;
  }
  get quality() {
    return this.scope.quality ?? 'medium';
  }
  private get speechOutput() {
    return this.quality !== 'basic';
  }
  private get nativeRestingPhase() {
    return this.nativeInputId &&
      this.nativeApprovalInputId === this.nativeInputId
      ? ('approval' as const)
      : ('listening' as const);
  }
  get endSignal(): AbortSignal {
    return this.controller.signal;
  }
  get connected() {
    return Boolean(this.listener);
  }
  private async check() {
    this.controller.signal.throwIfAborted();
    if (
      (await this.port.paused()) ||
      (await this.port.requireThread()).dotId !== this.scope.dotId
    )
      throw Error('Call scope is unavailable');
  }
  async touch() {
    await this.check();
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
      await this.check();
      const foreground = this.port
        .foreground(this.controller.signal)
        .then((release) => {
          if (this.ended) release();
          else this.release = release;
        });
      await waitForVoiceOperation(foreground, this.controller.signal);
      await this.check();
      await waitForVoiceOperation(
        Promise.all([
          this.workers.native
            ? this.workers.native.warm(this.controller.signal)
            : this.workers.recognition!.warm(this.controller.signal),
          ...(this.quality === 'medium'
            ? [this.workers.synthesis!.warm(this.controller.signal)]
            : []),
          this.workers.vad.warm(this.controller.signal),
          this.workers.inference?.warm(this.controller.signal),
        ]),
        this.controller.signal,
      );
      await this.check();
      this.ready = true;
      this.lastSeen = Date.now();
      await this.port.receipt('active', '');
      this.emit({ type: 'phase', phase: 'listening' });
      this.announceUpdate();
      this.timer = setInterval(async () => {
        try {
          await this.check();
          this.announceUpdate();
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
      logError('voice_start_failed', error, {
        callId: this.scope.id,
        threadId: this.scope.threadId,
      });
      await this.end(
        'The call could not start. Check the local speech and inference runtimes.',
      );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  async frame(sequence: number, pcm: Buffer) {
    await this.touch();
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
      if (!this.positives) {
        this.speechStartFrames = 3;
        this.speechCandidateFrames = 0;
        this.speechCandidateSilence = 0;
      }
      // Once speech overlaps a reply, keep confirming it even if playback ends.
      if (this.outputActive) this.speechStartFrames = interruptionSpeechFrames;
      const interruption = this.speechStartFrames === interruptionSpeechFrames;
      if (voiced) {
        this.positives++;
        this.speechCandidateSilence = 0;
      } else if (interruption && this.positives) {
        this.speechCandidateSilence++;
      } else {
        this.positives = 0;
      }
      if (this.positives) this.speechCandidateFrames++;
      if (
        interruption &&
        (this.speechCandidateSilence > interruptionGapFrames ||
          this.speechCandidateFrames > interruptionWindowFrames)
      ) {
        logDiagnostic('voice_interruption', {
          callId: this.scope.id,
          threadId: this.scope.threadId,
          status: 'rejected',
          code:
            this.speechCandidateSilence > interruptionGapFrames
              ? 'speech_gap'
              : 'sparse_speech',
        });
        this.positives = voiced ? 1 : 0;
        this.speechCandidateFrames = this.positives;
        this.speechCandidateSilence = 0;
      }
      this.preRoll.push(pcm);
      // Retain the whole confirmation window so interruption loses no words.
      while (this.preRoll.length > Math.max(8, this.speechCandidateFrames))
        this.preRoll.shift();
      if (this.positives < this.speechStartFrames) return;
      if (interruption)
        logDiagnostic('voice_interruption', {
          callId: this.scope.id,
          threadId: this.scope.threadId,
          status: 'confirmed',
        });
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
        { quality: this.quality },
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
        const native = this.workers.native
          ? await this.workers.native.interpret(
              audio,
              this.controller.signal,
              await this.port.nativeContext?.(),
            )
          : undefined;
        const result =
          native ?? (await this.recognize(audio, generation, timing));
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
        const text = native?.route === 'ignore' ? '' : result.text.trim();
        if (!text) {
          timing.mark('recognition_discarded');
          this.emit({ type: 'phase', phase: 'listening' });
          return;
        }
        if (text.length > 4000) throw Error('Transcript exceeds limit');
        if (isEndCallRequest(text)) {
          // Save the control in the terminal receipt, without admitting an agent
          // task or delaying device teardown on an active checkpoint write.
          this.appendTranscript(`You: ${text}`);
          logDiagnostic('voice_call_control', {
            callId: this.scope.id,
            threadId: this.scope.threadId,
            operation: 'end_call',
          });
          // High end() drains this recognition promise; awaiting it here would
          // deadlock. end() emits flush/ended synchronously and owns cleanup.
          void this.end().catch((error) =>
            logError('voice_call_end_failed', error, {
              callId: this.scope.id,
              threadId: this.scope.threadId,
              operation: 'spoken_hangup',
            }),
          );
          return;
        }
        if (this.committedTurns >= 100) throw Error('Call turn limit reached');
        this.committedTurns++;
        this.utterance = {
          messageId,
          text,
          timing,
          generation: this.generation,
        };
        if (native) {
          if (!this.port.nativeTurn)
            throw Error('Native conversation runtime is unavailable.');
          this.nativeInputId = messageId;
          this.nativeApprovalInputId = undefined;
          const utterance = this.utterance;
          // Preserve the recognized input before subscription reasoning. A
          // crash during intake must not erase the owner's spoken request.
          await this.checkpoint(`You: ${text}`);
          const reply = await this.port.nativeTurn({
            messageId,
            audio,
            understanding: native,
            signal: this.controller.signal,
          });
          if (this.ended || generation !== this.recognitionGeneration) return;
          utterance.answered = true;
          this.emit({
            type: 'native-transcript',
            messageId,
            text,
            generation: utterance.generation,
          });
          if (reply.reviewFolders) this.emit({ type: 'review-folders' });
          if (reply.awaitingReply) {
            timing.mark('run_requested');
            this.emit({
              type: 'phase',
              phase:
                this.nativeApprovalInputId === messageId
                  ? 'approval'
                  : 'thinking',
            });
            return;
          }
          await this.checkpoint(`Dot (generated): ${reply.text}`);
          this.emit({ type: 'caption', text: reply.text });
          if (this.speakerMuted)
            this.emit({ type: 'phase', phase: this.nativeRestingPhase });
          else {
            this.outputActive = true;
            void this.speak(
              reply.text,
              utterance,
              {
                assistantMessageId: reply.assistantMessageId,
                segmentSequence: 0,
              },
              reply.pcm,
            )
              .catch(() => {
                if (!this.ended && utterance.generation === this.generation)
                  void this.end(
                    'Speech playback failed. The response is saved in chat.',
                  );
              })
              .finally(() => {
                if (utterance.generation === this.generation) {
                  this.outputActive = false;
                  this.emit({ type: 'phase', phase: this.nativeRestingPhase });
                  this.announceUpdate();
                }
              });
          }
          return;
        }
        await this.port.voiceTurn?.(this.utterance);
        await this.checkpoint(`You: ${text}`);
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
          if (!this.ended) this.announceUpdate();
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
        const result = await this.workers.recognition!.transcribe(
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
        await this.workers.recognition!.close();
        if (this.ended) {
          timing.recognitionResult('superseded', diagnostics);
          return;
        }
        this.workers.recognition = this.createWorkers().recognition;
        await this.workers.recognition!.warm(signal);
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
  /** A durable host receipt has already been saved. Do not interrupt an utterance. */
  nativeUpdate(
    id: string,
    text: string,
    authorization: Promise<() => Promise<boolean>> | (() => Promise<boolean>),
    options: {
      retainUntilPlayed?: boolean;
      sourceMessageId?: string;
      approval?: boolean;
    } = {},
  ) {
    if (!this.workers.native || this.ended || this.seenUpdates.has(id)) return;
    this.seenUpdates.add(id);
    if (this.seenUpdates.size > 256)
      this.seenUpdates.delete(this.seenUpdates.values().next().value!);
    const authorized = Promise.resolve(authorization).catch(
      () => async () => false,
    );
    if (options.sourceMessageId && options.approval !== undefined) {
      // A waiting task must surface its review even while speech is muted or
      // synthesis is busy. The same durable receipt guard governs this hint.
      void (async () => {
        const validate = await waitForVoiceOperation(
          authorized,
          this.controller.signal,
        );
        await this.check();
        if (
          !(await waitForVoiceOperation(validate(), this.controller.signal)) ||
          this.ended
        )
          return;
        if (options.approval) this.emit({ type: 'review-folders' });
        if (options.sourceMessageId !== this.nativeInputId) return;
        this.nativeApprovalInputId = options.approval
          ? options.sourceMessageId
          : undefined;
        if (!this.speaking && !this.outputActive)
          this.emit({
            type: 'phase',
            phase: options.approval ? 'approval' : 'listening',
          });
      })().catch(() => {
        /* Stale receipts and ended calls cannot request a review. */
      });
    }
    if (this.updates.length >= 64) {
      const disposable = this.updates.findIndex(
        (update) => !update.retainUntilPlayed,
      );
      const [removed] = this.updates.splice(disposable < 0 ? 0 : disposable, 1);
      this.traceUpdate(removed.id, 'queue_full');
      this.retainedUpdates.delete(removed.id);
    }
    if (options.retainUntilPlayed) this.retainedUpdates.add(id);
    this.updates.push({
      id,
      text,
      generation: this.generation,
      authorization: authorized,
      retainUntilPlayed: options.retainUntilPlayed === true,
      deferred: this.speakerMuted && options.retainUntilPlayed === true,
    });
    this.traceUpdate(id, 'queued');
    this.announceUpdate();
  }
  private traceUpdate(
    id: string,
    status:
      | 'queued'
      | 'deferred'
      | 'playing'
      | 'played'
      | 'unavailable'
      | 'interrupted'
      | 'call_ended'
      | 'queue_full',
  ) {
    if (this.retainedUpdates.has(id))
      logDiagnostic('voice_task_speech', {
        callId: this.scope.id,
        requestId: id,
        status,
      });
  }
  private announceUpdate() {
    if (
      !this.updates.length ||
      !this.ready ||
      !this.workers.native ||
      this.ended ||
      this.recognizing ||
      this.speaking ||
      this.outputActive ||
      this.speakerMuted
    )
      return;
    const update = this.updates.shift()!;
    const generation = update.generation;
    const signal = AbortSignal.any([
      this.controller.signal,
      this.outputController.signal,
    ]);
    const authorized = async () => {
      if (this.ended || generation !== this.generation) return false;
      try {
        const validate = await waitForVoiceOperation(
          update.authorization,
          signal,
        );
        await this.check();
        const valid = await waitForVoiceOperation(validate(), signal);
        return valid && !this.ended && generation === this.generation;
      } catch {
        return false;
      }
    };
    const work = (async () => {
      if (!(await authorized())) return;
      this.emit({ type: 'saved', text: update.text });
      // ASR and TTS share a serial worker. Aborting its request permanently
      // closes that worker, so drain stale synthesis before the next recognition.
      // Call shutdown still owns cancellation; the generation gates playback.
      const reply = await waitForVoiceOperation(
        this.workers.native!.speak(
          update.deferred
            ? `An earlier task result: ${update.text}`
            : update.text,
          this.controller.signal,
        ),
        this.controller.signal,
      );
      if (!(await authorized())) return;
      await this.checkpoint(`Dot (generated): ${reply.text}`);
      if (!(await authorized())) return;
      const utterance: Utterance = {
        messageId: update.id,
        text: '',
        generation,
        answered: true,
        timing: new VoiceTurnTiming(
          this.scope.id,
          update.id,
          performance.now(),
          { quality: 'high' },
        ),
      };
      this.utterance = utterance;
      this.emit({ type: 'caption', text: reply.text });
      this.outputActive = true;
      // Also revoke audio already queued while playback awaits acknowledgements.
      let monitoring = true;
      let checking = false;
      const monitor = setInterval(() => {
        if (checking) return;
        checking = true;
        void authorized()
          .then((valid) => {
            if (
              monitoring &&
              !valid &&
              !this.ended &&
              generation === this.generation
            )
              void this.interrupt(false);
          })
          .finally(() => {
            checking = false;
          });
      }, 100);
      monitor.unref?.();
      try {
        await this.speak(
          reply.text,
          utterance,
          { assistantMessageId: update.id, segmentSequence: 0 },
          reply.pcm,
          authorized,
        );
      } finally {
        monitoring = false;
        clearInterval(monitor);
        if (generation === this.generation) this.outputActive = false;
      }
    })();
    this.recognizing = work;
    void work
      .catch(() => {
        if (!this.ended && generation === this.generation)
          void this.end(
            'Local voice stopped. The task update is saved in chat.',
          );
      })
      .finally(() => {
        if (this.recognizing === work) this.recognizing = undefined;
        // Barge-in stops speech, not the completed work it was announcing.
        // Retry only an outcome that has not begun software playback. Fresh
        // authorization is still required; never repeat the task's effects.
        if (
          !this.ended &&
          generation !== this.generation &&
          update.retainUntilPlayed &&
          !this.deliveries.some(
            (row) =>
              row.messageId === update.id && row.softwarePlayedSamples > 0,
          )
        ) {
          update.generation = this.generation;
          update.deferred = true;
          this.updates.unshift(update);
          this.traceUpdate(update.id, 'deferred');
        } else {
          const rows = this.deliveries.filter(
            (row) =>
              row.messageId === update.id && row.generation === generation,
          );
          this.traceUpdate(
            update.id,
            this.ended
              ? 'call_ended'
              : rows.some((row) => row.softwarePlayedSamples > 0)
                ? rows.every(
                    (row) =>
                      !row.interrupted &&
                      row.generatedSamples === row.softwarePlayedSamples,
                  )
                  ? 'played'
                  : 'interrupted'
                : 'unavailable',
          );
          this.retainedUpdates.delete(update.id);
        }
        if (!this.ended && generation === this.generation)
          this.emit({
            type: 'phase',
            phase: this.nativeRestingPhase,
          });
        if (!this.ended) this.announceUpdate();
      });
  }
  private resetInput() {
    this.frames = [];
    this.preRoll = [];
    this.speaking = false;
    this.positives = 0;
    this.speechStartFrames = 3;
    this.speechCandidateFrames = 0;
    this.speechCandidateSilence = 0;
    this.silence = 0;
  }
  private appendTranscript(line: string) {
    this.transcript =
      `${this.transcript}${this.transcript ? '\n' : ''}${line}`.slice(-20000);
  }
  private async checkpoint(line: string) {
    this.appendTranscript(line);
    await this.port.receipt('active', this.transcript);
  }
  async mute(value: boolean) {
    await this.touch();
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
    await this.touch();
    if (!this.speechOutput) return;
    this.speakerMuted = value;
    if (value) await this.interrupt(false, 'speaker_muted');
    else this.announceUpdate();
  }
  async interrupt(
    stopRun = true,
    reason: 'interrupted' | 'speaker_muted' = 'interrupted',
  ) {
    if (this.ended) return;
    if (!this.speaking) this.resetInput();
    const utterance = this.utterance;
    if (utterance && (!utterance.answered || this.outputActive))
      utterance.timing.mark(reason);
    if (stopRun) this.recognizingTiming?.mark('interrupted');
    if (utterance?.output) utterance.output.queue = [];
    this.generation++;
    this.updates = this.updates.filter(
      (update) => reason === 'speaker_muted' || update.retainUntilPlayed,
    );
    for (const update of this.updates) {
      update.generation = this.generation;
      if (update.retainUntilPlayed) update.deferred = true;
      this.traceUpdate(update.id, 'deferred');
    }
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
      this.quality === 'medium' &&
      this.outputActive &&
      !this.synthesisClosed &&
      !this.synthesisWarming;
    const closed = replace
      ? this.workers.synthesis!.close()
      : Promise.resolve();
    if (replace) this.synthesisClosed = true;
    this.outputActive = false;
    this.stopping = this.stopping.then(async () => {
      await closed;
      if (replace) this.startSynthesisRecovery(utterance?.timing);
      if (stopRun && utterance && this.quality !== 'high')
        await this.port.stop(utterance.messageId);
    });
    await this.stopping;
  }
  private startSynthesisRecovery(timing?: VoiceTurnTiming) {
    if (
      !this.speechOutput ||
      this.ended ||
      !this.synthesisClosed ||
      this.synthesisWarming
    )
      return;
    timing?.mark('synthesis_restarting');
    // Only the replacement synthesis worker is opened. Recognition and the
    // provider keep running; this promise is deliberately outside `stopping`.
    this.workers.synthesis = this.createWorkers().synthesis;
    this.synthesisClosed = false;
    const worker = this.workers.synthesis!;
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
  async commitText(
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
    await this.check();
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
    await this.checkpoint(`Dot (generated): ${text}`);
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
    if (
      this.speechOutput &&
      remaining &&
      spoken &&
      !this.speakerMuted &&
      !output.suppressed
    ) {
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
      if (!this.speechOutput) utterance.timing.mark('text_reply_complete');
      else this.markPlaybackFinished(utterance);
      if (
        this.speechOutput &&
        !this.deliveries.some((row) => row.messageId === utterance.messageId)
      )
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
    await this.touch();
    if (this.quality === 'high') return;
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
    await this.checkpoint(`Dot (generated): ${text}`);
    if (!this.speechOutput) {
      utterance.timing.mark('text_reply_complete');
      this.emit({ type: 'phase', phase: 'listening' });
      return;
    }
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
    preparedPCM?: Buffer,
    authorized?: () => Promise<boolean>,
  ) {
    if (!this.speechOutput) return;
    const signal = AbortSignal.any([
      this.controller.signal,
      this.outputController.signal,
    ]);
    await this.stopping;
    signal.throwIfAborted();
    const checkAuthorization = async () => {
      if (authorized && !(await authorized())) {
        if (!this.ended && utterance.generation === this.generation)
          await this.interrupt(false);
        throw new DOMException('Speech authorization changed', 'AbortError');
      }
      if (utterance.generation !== this.generation)
        throw new DOMException('Speech was interrupted', 'AbortError');
      signal.throwIfAborted();
    };
    await checkAuthorization();
    if (this.synthesisClosed) this.startSynthesisRecovery(utterance.timing);
    if (this.synthesisWarming) {
      utterance.timing.mark('synthesis_wait_started');
      await waitForVoiceOperation(this.synthesisWarming, signal);
      utterance.timing.mark('synthesis_wait_finished');
    }
    signal.throwIfAborted();
    const synthesis = this.workers.synthesis!;
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
      preparedPCM,
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
          await checkAuthorization();
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
    await this.port.delivery(this.deliveries);
    if (
      preparedPCM ||
      !span ||
      (utterance.output?.complete && !utterance.output.queue.length)
    )
      this.markPlaybackFinished(utterance);
    if (!span) this.emit({ type: 'phase', phase: 'listening' });
  }
  private markPlaybackFinished(utterance: Utterance) {
    const rows = this.deliveries.filter(
      (row) =>
        row.messageId === utterance.messageId &&
        row.generation === utterance.generation,
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
  async played(generation: number, sequence: number, samples: number) {
    await this.touch();
    if (generation !== this.generation) return;
    const item = this.pending.get(sequence);
    if (!item) return;
    if (item.generation !== generation || item.samples !== samples)
      throw Error('Invalid playback acknowledgement');
    if (
      !this.deliveries.some(
        (row) =>
          row.messageId === item.delivery.messageId &&
          row.softwarePlayedSamples > 0,
      )
    )
      this.traceUpdate(item.delivery.messageId, 'playing');
    item.delivery.softwarePlayedSamples += samples;
    item.timing.mark('first_playback_ack');
    clearTimeout(item.timer);
    this.pending.delete(sequence);
    item.resolve();
  }
  end(error?: string): Promise<void> {
    if (this.closing) return this.closing;
    for (const update of this.updates) {
      this.traceUpdate(update.id, 'call_ended');
      this.retainedUpdates.delete(update.id);
    }
    this.updates = [];
    if (error)
      logError('voice_call_failed', error, {
        callId: this.scope.id,
        threadId: this.scope.threadId,
      });
    const utterance = this.utterance;
    utterance?.timing.mark(error ? 'call_failed' : 'call_ended');
    this.recognizingTiming?.mark(error ? 'call_failed' : 'call_ended');
    this.port.voiceTurn?.();
    this.utterance = undefined;
    // Assign before emitting/aborting: either boundary can synchronously end again.
    this.closing = Promise.resolve().then(async () => {
      try {
        await Promise.allSettled([
          this.workers.recognition?.close(),
          this.workers.native?.close(),
          this.workers.vad.close(),
          this.workers.inference?.close(),
          ...(this.quality === 'medium' && !this.synthesisClosed
            ? [this.workers.synthesis!.close()]
            : []),
          this.stopping.then(() =>
            utterance ? this.port.stop(utterance.messageId) : undefined,
          ),
        ]);
        if (this.quality === 'high') await this.recognizing?.catch(() => {});
      } finally {
        try {
          await this.port.delivery(this.deliveries);
          await this.port.receipt(
            error ? 'failed' : 'ended',
            this.transcript,
            error,
          );
        } finally {
          this.port.closed?.();
        }
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
