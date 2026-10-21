import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import type {
  NativeReplyContext,
  NativeRoutingContext,
  NativeSpeech,
  NativeUnderstanding,
  NativeVoiceSession,
} from './native-contract.js';

const maxLine = 2_000_000;
// Tokenizer delimiters must not turn captions/history into synthetic roles.
const plain = (text: string) => !/[\p{Cc}\p{Cf}]|<\||\|>/u.test(text);
const textSchema = z
  .string()
  .min(1)
  .max(4000)
  .refine((text) => !!text.trim() && plain(text));
const understandingSchema = z
  .object({
    text: z.string().max(4000).refine(plain),
    route: z.enum(['chat', 'clarify', 'delegate', 'clock', 'status', 'ignore']),
  })
  .strict()
  .refine((value) =>
    value.route === 'ignore' ? value.text === '' : !!value.text.trim(),
  );
const historySchema = z
  .array(
    z
      .object({
        role: z.enum(['user', 'assistant']),
        text: textSchema,
      })
      .strict(),
  )
  .max(8)
  .refine((rows) => rows.reduce((n, row) => n + row.text.length, 0) <= 8000);
const routingContextSchema = z
  .object({
    history: historySchema,
    taskStatus: z.enum([
      'none',
      'queued',
      'running',
      'approval',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ]),
  })
  .strict();
const contextSchema = z
  .object({
    caption: textSchema,
    instructions: textSchema.refine((text) => text.length <= 2400),
    history: historySchema,
  })
  .strict()
  .refine(
    (context) =>
      context.instructions.length +
        context.history.reduce((n, row) => n + row.text.length, 0) <=
      8000,
  );

function inputAudio(pcm: Buffer): string {
  if (!pcm.length || pcm.length % 2 || pcm.length > 960000)
    throw Error('Invalid native voice input');
  return pcm.toString('base64');
}
function speech(value: unknown): NativeSpeech {
  const parsed = z
    .object({
      text: textSchema,
      pcm: z.string().min(4).max(1_920_000),
    })
    .strict()
    .parse(value);
  const pcm = Buffer.from(parsed.pcm, 'base64');
  if (
    !pcm.length ||
    pcm.length % 2 ||
    pcm.length > 1_440_000 ||
    pcm.toString('base64') !== parsed.pcm
  )
    throw Error('Invalid native voice audio');
  return { text: parsed.text, pcm };
}

/**
 * Bounded, serial RPC to the offline native runtime. The launch wrapper supplies
 * the OS sandbox; this transport additionally withholds inherited credentials.
 * No task/provider execution exists in this process.
 */
export class NativeVoiceWorker implements NativeVoiceSession {
  private child?: ChildProcessWithoutNullStreams;
  private exited?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private pending?: {
    id: number;
    accept(value: unknown): unknown;
    resolve(value: unknown): void;
    reject(error: Error): void;
  };
  constructor(
    private readonly launch: {
      executable: string;
      args: string[];
      timeoutMs?: number;
    },
  ) {}

  private open() {
    if (this.child) return;
    const child = (this.child = spawn(
      this.launch.executable,
      this.launch.args,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUNBUFFERED: '1',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          TOKENIZERS_PARALLELISM: 'false',
        },
      },
    ));
    this.exited = new Promise((resolve) =>
      child.once('close', () => {
        this.closed = true;
        this.fail(new Error('Native voice worker exited'));
        resolve();
      }),
    );
    child.on('error', () =>
      this.fail(new Error('Native voice worker could not start')),
    );
    child.stdin.on('error', () => {
      this.fail(new Error('Native voice input closed'));
      void this.close();
    });
    child.stderr.resume(); // Never surface model text, local paths or library diagnostics.
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.buffer.length + chunk.length > maxLine) {
        this.fail(new Error('Native voice response exceeds limit'));
        void this.close();
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end: number;
      while ((end = this.buffer.indexOf(10)) !== -1) {
        const line = this.buffer.subarray(0, end).toString('utf8');
        this.buffer = this.buffer.subarray(end + 1);
        try {
          const response = z
            .object({
              id: z.number().int().positive(),
              result: z.unknown(),
            })
            .strict()
            .parse(JSON.parse(line));
          const pending = this.pending;
          if (!pending || response.id !== pending.id || !('result' in response))
            throw Error();
          const value = pending.accept(response.result);
          this.pending = undefined;
          pending.resolve(value);
        } catch {
          this.fail(new Error('Invalid native voice response'));
          void this.close();
          return;
        }
      }
    });
  }
  private fail(error: Error) {
    this.pending?.reject(error);
    this.pending = undefined;
  }
  private async request<T>(
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    accept: (value: unknown) => T,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.closed) throw Error('Native voice worker is closed');
    if (this.pending) throw Error('Native voice worker is busy');
    const id = ++this.sequence;
    const line = JSON.stringify({ id, method, ...payload }) + '\n';
    if (Buffer.byteLength(line) > maxLine)
      throw Error('Native voice request exceeds limit');
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.launch.timeoutMs ?? 120000),
    ]);
    this.open();
    const abort = () => {
      this.fail(bounded.reason);
      void this.close();
    };
    try {
      return (await new Promise<unknown>((resolve, reject) => {
        this.pending = { id, accept, resolve, reject };
        bounded.addEventListener('abort', abort, { once: true });
        if (bounded.aborted) abort();
        else this.child!.stdin.write(line);
      })) as T;
    } finally {
      bounded.removeEventListener('abort', abort);
    }
  }
  async warm(signal: AbortSignal): Promise<void> {
    await this.request('warm', {}, signal, (value) =>
      z
        .object({ ready: z.literal(true) })
        .strict()
        .parse(value),
    );
  }
  async interpret(
    pcm: Buffer,
    signal: AbortSignal,
    context: NativeRoutingContext = { history: [], taskStatus: 'none' },
  ): Promise<NativeUnderstanding> {
    if (!routingContextSchema.safeParse(context).success)
      throw Error('Invalid native voice routing context');
    return await this.request(
      'interpret',
      { pcm: inputAudio(pcm), ...context },
      signal,
      (value) => {
        const parsed = understandingSchema.parse(value);
        return {
          ...parsed,
          ...(parsed.route === 'delegate'
            ? {
                tool: {
                  name: 'delegate_task' as const,
                  arguments: { request: parsed.text },
                },
              }
            : {}),
        };
      },
    );
  }
  async respond(
    pcm: Buffer,
    context: NativeReplyContext,
    signal: AbortSignal,
  ): Promise<NativeSpeech> {
    if (!contextSchema.safeParse(context).success)
      throw Error('Invalid native voice context');
    return await this.request(
      'respond',
      { pcm: inputAudio(pcm), ...context },
      signal,
      speech,
    );
  }
  async speak(text: string, signal: AbortSignal): Promise<NativeSpeech> {
    if (!textSchema.safeParse(text).success || text.length > 400)
      throw Error('Invalid native voice text');
    return await this.request('speak', { text }, signal, (value) => {
      const parsed = speech(value);
      if (parsed.text !== text) throw Error('Invalid native voice text');
      return parsed;
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.fail(new Error('Native voice worker is closed'));
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
