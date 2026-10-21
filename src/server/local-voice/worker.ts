import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import type { SpeechEngine, Transcript } from './prototype.js';
import {
  recognitionReasons,
  type RecognitionReason,
} from './recognition-diagnostics.js';
import {
  voiceSettingsSchema,
  type VoiceSettings,
} from '../../shared/voice-settings.js';

const maxLine = 2_000_000;
/** The engine is healthy; discard only this utterance. */
export class RecognitionInputError extends Error {
  constructor(
    readonly reason: RecognitionReason = 'unknown',
    readonly fallbackReason?: RecognitionReason,
  ) {
    super('Speech could not be recognized. Please say it again.');
    this.name = 'RecognitionInputError';
  }
}
const transcriptSchema = z.object({
  text: z.string().max(4000),
  language: z.string().min(2).max(16),
  fallbackReason: z.enum(recognitionReasons).optional(),
  segments: z
    .array(
      z
        .object({
          startMs: z.number().finite().min(0).max(30000),
          endMs: z.number().finite().min(0).max(30000),
          text: z.string().max(4000),
        })
        .refine((s) => s.endMs >= s.startMs),
    )
    .max(300),
});
export class LocalSpeechWorker implements SpeechEngine {
  private child?: ChildProcessWithoutNullStreams;
  private exited?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private pending?: {
    id: number;
    resolve(value: unknown): void;
    reject(error: Error): void;
  };
  constructor(
    private readonly launch: {
      executable: string;
      args: string[];
      timeoutMs?: number;
      voiceSettings?: VoiceSettings;
    },
  ) {}

  private open(): void {
    if (this.child) return;
    const child = (this.child = spawn(
      this.launch.executable,
      this.launch.args,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Libraries may read these variables; absolute asset paths are still required.
        env: {
          ...process.env,
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
        },
      },
    ));
    this.exited = new Promise((resolve) =>
      child.once('close', () => {
        this.closed = true;
        this.fail(new Error('Local speech worker exited'));
        resolve();
      }),
    );
    child.on('error', () =>
      this.fail(new Error('Local speech worker could not start')),
    );
    child.stdin.on('error', () =>
      this.fail(new Error('Local speech worker input closed')),
    );
    child.stderr.resume(); // Drain diagnostics; do not leak input text/paths through logs.
    child.stdout.on('data', (data: Buffer) => {
      if (this.buffer.length + data.length > maxLine) {
        this.fail(new Error('Worker protocol line exceeds limit'));
        void this.close();
        return;
      }
      this.buffer = Buffer.concat([this.buffer, data]);
      let end: number;
      while ((end = this.buffer.indexOf(10)) !== -1) {
        const line = this.buffer.subarray(0, end).toString('utf8');
        this.buffer = this.buffer.subarray(end + 1);
        try {
          const response = z
            .object({
              id: z.number().int(),
              result: z.unknown().optional(),
              error: z.string().optional(),
              code: z.literal('recognition_input').optional(),
              reason: z.enum(recognitionReasons).optional(),
              fallbackReason: z.enum(recognitionReasons).optional(),
            })
            .strict()
            .parse(JSON.parse(line));
          const pending = this.pending;
          if (
            !pending ||
            response.id !== pending.id ||
            !('result' in response) === !('error' in response) ||
            (response.code && !response.error) ||
            ((response.reason || response.fallbackReason) && !response.code)
          )
            throw new Error('Unexpected worker protocol response');
          this.pending = undefined;
          if (response.error)
            pending.reject(
              response.code === 'recognition_input'
                ? new RecognitionInputError(
                    response.reason,
                    response.fallbackReason,
                  )
                : new Error(
                    `Local speech worker: ${response.error.slice(0, 160)}`,
                  ),
            );
          else pending.resolve(response.result);
        } catch {
          this.fail(new Error('Invalid worker protocol response'));
          void this.close();
        }
      }
    });
  }
  private fail(error: Error): void {
    this.pending?.reject(error);
    this.pending = undefined;
  }
  private async request(
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('Local speech worker is closed');
    if (this.pending) throw new Error('Local speech worker is busy');
    const id = ++this.sequence;
    const line = JSON.stringify({ id, method, ...payload }) + '\n';
    if (Buffer.byteLength(line) > maxLine)
      throw new Error('Worker request exceeds limit');
    this.open();
    const boundedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.launch.timeoutMs ?? 120000),
    ]);
    const abort = () => {
      this.fail(boundedSignal.reason);
      void this.close();
    };
    try {
      return await new Promise((resolve, reject) => {
        this.pending = { id, resolve, reject };
        boundedSignal.addEventListener('abort', abort, { once: true });
        if (boundedSignal.aborted) abort();
        else this.child!.stdin.write(line);
      });
    } finally {
      boundedSignal.removeEventListener('abort', abort);
    }
  }
  async warm(signal: AbortSignal): Promise<void> {
    z.object({ ready: z.literal(true) }).parse(
      await this.request('warm', {}, signal),
    );
  }
  async transcribe(
    pcm: Buffer,
    language: 'en' | 'id' | 'auto',
    signal: AbortSignal,
    context?: string,
  ): Promise<Transcript> {
    if (!pcm.length || pcm.length % 2 || pcm.length > 960000)
      throw new Error('Invalid input PCM');
    if (
      context !== undefined &&
      (typeof context !== 'string' ||
        context.length > 600 ||
        /[\p{Cc}\p{Cf}]/u.test(context) ||
        (language !== 'en' && context.length > 0))
    )
      throw new Error('Invalid recognition context');
    return transcriptSchema.parse(
      await this.request(
        'transcribe',
        {
          pcm: pcm.toString('base64'),
          language,
          ...(context !== undefined ? { context } : {}),
        },
        signal,
      ),
    );
  }
  async detect(pcm: Buffer, signal: AbortSignal): Promise<number> {
    if (pcm.length !== 1024) throw new Error('Invalid VAD PCM frame');
    const result = z
      .object({ probability: z.number().finite().min(0).max(1) })
      .strict()
      .parse(
        await this.request('vad', { pcm: pcm.toString('base64') }, signal),
      );
    return result.probability;
  }
  async reset(signal: AbortSignal): Promise<void> {
    z.object({ ready: z.literal(true) })
      .strict()
      .parse(await this.request('reset', {}, signal));
  }
  async synthesize(text: string, signal: AbortSignal): Promise<Buffer> {
    if (!text.trim() || text.length > 400)
      throw new Error('Invalid speech text');
    const settings = this.launch.voiceSettings
      ? voiceSettingsSchema.parse(this.launch.voiceSettings)
      : undefined;
    const result = z.object({ pcm: z.string().min(4).max(1920000) }).parse(
      await this.request(
        'synthesize',
        {
          text,
          ...(settings
            ? { voiceId: settings.voiceId, personality: settings.personality }
            : {}),
        },
        signal,
      ),
    );
    const pcm = Buffer.from(result.pcm, 'base64');
    if (
      pcm.toString('base64') !== result.pcm ||
      !pcm.length ||
      pcm.length % 2 ||
      pcm.length > 1440000
    )
      throw new Error('Invalid output PCM');
    return pcm;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.fail(new Error('Local speech worker is closed'));
    const child = this.child;
    this.closing = (async () => {
      if (!child) return;
      child.stdin.destroy();
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      try {
        await this.exited;
      } finally {
        clearTimeout(force);
        this.buffer = Buffer.alloc(0);
      }
    })();
    return this.closing;
  }
}
