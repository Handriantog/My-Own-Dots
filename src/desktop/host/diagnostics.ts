import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Local, bounded health events. Callers supply only Dot's own state, never
 * other applications' titles, contents, environment variables or credentials. */
export class DesktopDiagnostics {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private directory: string,
    private limit = 256 * 1024,
  ) {}

  captureException(error: Error): void {
    // A fatal exception can exit before promise-based I/O gets a turn. Keep
    // this separate from queued events so it persists before returning.
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(this.directory, 'last-exception.json'),
        JSON.stringify({
          at: new Date().toISOString(),
          message: error.message.slice(0, 2000),
          stack: error.stack?.slice(0, 4000),
        }),
        { mode: 0o600 },
      );
    } catch {
      /* A diagnostic failure must not replace the original error. */
    }
  }

  record(event: string, details: Record<string, unknown>): Promise<void> {
    this.pending = this.pending
      .then(async () => {
        const at = new Date().toISOString();
        let line = JSON.stringify({ at, event, details }) + '\n';
        if (Buffer.byteLength(line) > this.limit)
          line =
            JSON.stringify({ at, event, details: { truncated: true } }) + '\n';
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file = path.join(this.directory, 'desktop.log');
        const size = await stat(file)
          .then((s) => s.size)
          .catch(() => 0);
        if (size + Buffer.byteLength(line) > this.limit)
          await rename(file, path.join(this.directory, 'desktop.previous.log'));
        await appendFile(file, line, { mode: 0o600 });
      })
      .catch(() => {
        // Diagnostics must never take down, stall, or hide the companion.
      });
    return this.pending;
  }
}
