/** Node-only local diagnostics shared by the desktop, backend and workers. */
import {
  constants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';

const contextKeys = new Set([
  'requestId',
  'threadId',
  'callId',
  'messageId',
  'runId',
  'dotId',
  'quality',
  'stage',
  'operation',
  'route',
  'method',
  'status',
  'code',
  'signal',
  'worker',
  'python',
  'pythonVersion',
  'pythonTrace',
  'exceptionType',
  'origin',
]);
const numericContextKeys = new Set(['step', 'elapsedMs']);
export type ErrorContext = Record<
  string,
  string | number | boolean | undefined | null
>;

function redact(value: string): string {
  let result = value.slice(0, 65536);
  for (const [key, secret] of Object.entries(process.env)) {
    if (
      /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i.test(key) &&
      secret &&
      secret.length >= 4
    )
      result = result.split(secret).join('[redacted]');
  }
  return result
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [redacted]')
    .replace(
      /\b([\w-]*(?:token|secret|password|api[_-]?key)[\w-]*)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      '$1=[redacted]',
    )
    .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[redacted URL]';
      }
    });
}

function describe(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error))
    return {
      name: 'Error',
      message:
        typeof error === 'string'
          ? redact(error).slice(0, 1000)
          : 'Unspecified failure',
    };
  const name = error.name.slice(0, 80);
  const message =
    name === 'ZodError'
      ? 'Input validation failed'
      : redact(error.message).slice(0, 1000);
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 10);
  return {
    name,
    message,
    stack: [
      `${name}: ${message}`,
      ...frames.map((line) => redact(line).slice(0, 240)),
    ].join('\n'),
    ...(error.cause && depth < 1
      ? { cause: describe(error.cause, depth + 1) }
      : {}),
  };
}

export class DailyErrorLog {
  private cappedDay = '';
  constructor(
    readonly directory: string,
    private source: string,
    private now = () => new Date(),
    private limit = 20 * 1024 * 1024,
  ) {}
  record(event: string, error: unknown, context: ErrorContext = {}): boolean {
    let fd: number | undefined;
    try {
      const now = this.now();
      const day = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('-');
      if (this.cappedDay === day) return false;
      const safeContext = Object.fromEntries(
        Object.entries(context)
          .filter(
            ([key, value]) =>
              (contextKeys.has(key) &&
                ['string', 'number', 'boolean'].includes(typeof value)) ||
              (numericContextKeys.has(key) &&
                typeof value === 'number' &&
                Number.isFinite(value) &&
                value >= 0),
          )
          .map(([key, value]) => [
            key,
            typeof value === 'string' ? redact(value).slice(0, 320) : value,
          ]),
      );
      const row = {
        at: now.toISOString(),
        source: this.source,
        pid: process.pid,
        event: event.slice(0, 100),
        ...(error === undefined ? {} : { error: describe(error) }),
        context: safeContext,
      };
      let line = JSON.stringify(row) + '\n';
      if (Buffer.byteLength(line) > 8000)
        line =
          JSON.stringify({
            ...row,
            error: {
              name: 'Error',
              message: 'Error details exceeded the record limit',
            },
            context: { truncated: true },
          }) + '\n';
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fd = openSync(
        join(this.directory, `errors-${day}.jsonl`),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          constants.O_NOFOLLOW,
        0o600,
      );
      const info = fstatSync(fd);
      if (!info.isFile()) return false;
      if (info.size + Buffer.byteLength(line) > this.limit) {
        this.cappedDay = day;
        // One explicit marker per process; no silent unbounded error storm.
        if (info.size < this.limit + 2048)
          writeSync(
            fd,
            JSON.stringify({
              at: now.toISOString(),
              source: this.source,
              pid: process.pid,
              event: 'daily_log_limit_reached',
              limitBytes: this.limit,
            }) + '\n',
          );
        return false;
      }
      writeSync(fd, line);
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* Preserve the original error. */
        }
      }
    }
  }
}

let current: DailyErrorLog | undefined;
export function logError(
  event: string,
  error: unknown,
  context: ErrorContext = {},
): void {
  const directory = process.env.DOTS_ERROR_LOG_DIR;
  if (!directory || !isAbsolute(directory)) return;
  if (!current || current.directory !== directory)
    current = new DailyErrorLog(directory, 'backend');
  current.record(event, error, context);
}

/** Fixed event names and allowlisted metadata only; never conversation text. */
export function logDiagnostic(event: string, context: ErrorContext): void {
  logError(event, undefined, context);
}

/** Monitor observes Node's normal fatal handling; it does not swallow the crash. */
export function installErrorLogging(
  directory: string,
  source: string,
): () => void {
  process.env.DOTS_ERROR_LOG_DIR = directory;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    /* Logging never blocks startup. */
  }
  const logger = new DailyErrorLog(directory, source);
  current = logger;
  const listener = (error: Error, origin: string) =>
    logger.record('uncaught_exception', error, { origin });
  process.on('uncaughtExceptionMonitor', listener);
  return () => process.off('uncaughtExceptionMonitor', listener);
}
