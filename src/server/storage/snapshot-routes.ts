import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ArchiveManifest } from '../../shared/storage-archive.js';
import type { SnapshotSource } from './legacy-snapshot.js';
import { MaintenanceBusyError } from './maintenance.js';

type Status = {
  id: string;
  phase: 'capturing' | 'ready' | 'failed' | 'cancelled';
  manifest?: ArchiveManifest;
  directory?: string;
  error?: string;
};
type Operation = {
  status: Status;
  controller: AbortController;
  done: Promise<void>;
  directory: string;
  ownsDirectory: boolean;
  touched: number;
};
const MAX_IDLE_MS = 15 * 60 * 1000;
/** Root and source are configured by the backend, never by HTTP input. */
export class SnapshotOperations {
  private operations = new Map<string, Operation>();
  private starting = false;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private source: SnapshotSource,
    private root: string,
  ) {
    this.timer = setInterval(() => {
      for (const [id, operation] of this.operations)
        if (Date.now() - operation.touched > MAX_IDLE_MS)
          void this.release(id).catch(() => {});
    }, 30000);
    this.timer.unref();
  }
  async create(origin: 'manual' | 'automatic'): Promise<Status> {
    if (this.closed) throw new Error('Snapshot service is closing');
    if (this.starting || this.operations.size)
      throw new Error('A snapshot operation is already active');
    this.starting = true;
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if (!(await lstat(this.root)).isDirectory())
        throw new Error('Snapshot staging is not a private directory');
      if (this.closed) throw new Error('Snapshot service is closing');
      const id = randomUUID();
      const operation: Operation = {
        status: { id, phase: 'capturing' },
        controller: new AbortController(),
        done: Promise.resolve(),
        directory: join(this.root, id),
        ownsDirectory: false,
        touched: Date.now(),
      };
      this.operations.set(id, operation);
      operation.done = this.source
        .capture(operation.directory, operation.controller.signal, origin)
        .then(async (manifest) => {
          operation.ownsDirectory = true;
          if (operation.controller.signal.aborted) {
            await rm(operation.directory, { recursive: true, force: true });
            operation.ownsDirectory = false;
            operation.status = { id, phase: 'cancelled' };
          } else
            operation.status = {
              id,
              phase: 'ready',
              manifest,
              directory: operation.directory,
            };
        })
        .catch((error: unknown) => {
          operation.status = {
            id,
            phase: operation.controller.signal.aborted ? 'cancelled' : 'failed',
            error:
              error instanceof MaintenanceBusyError
                ? error.message
                : 'Snapshot could not be completed. Check workspace storage and try again.',
          };
        });
      return { ...operation.status };
    } finally {
      this.starting = false;
    }
  }
  async activity() {
    if (this.closed || !this.source.activity)
      throw new Error('Storage activity is unavailable');
    return this.source.activity();
  }
  status(id: string): Status | undefined {
    const operation = this.operations.get(id);
    if (!operation) return;
    operation.touched = Date.now();
    return structuredClone(operation.status);
  }
  async cancel(id: string): Promise<Status | undefined> {
    const operation = this.operations.get(id);
    if (!operation) return;
    operation.controller.abort(new Error('Snapshot cancelled'));
    await operation.done;
    if (operation.ownsDirectory) {
      await rm(operation.directory, { recursive: true, force: true });
      operation.ownsDirectory = false;
    }
    operation.status = { id, phase: 'cancelled' };
    return this.status(id);
  }
  async release(id: string): Promise<void> {
    await this.cancel(id);
    this.operations.delete(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all(
      [...this.operations.keys()].map((id) => this.release(id)),
    );
  }
}
export function snapshotRoutes(operations: SnapshotOperations) {
  const app = new Hono();
  app.get('/storage/status', async (c) => {
    try {
      return c.json(await operations.activity());
    } catch {
      return c.json({ error: 'Storage activity is unavailable.' }, 503);
    }
  });
  app.post('/storage/snapshots', async (c) => {
    const parsed = z
      .object({ origin: z.enum(['manual', 'automatic']).default('manual') })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Only snapshot origin may be supplied.' }, 400);
    try {
      return c.json(await operations.create(parsed.data.origin), 202);
    } catch {
      return c.json({ error: 'Snapshot service is busy or unavailable.' }, 409);
    }
  });
  app.get('/storage/snapshots/:id', (c) => {
    const status = operations.status(c.req.param('id'));
    return status
      ? c.json(status)
      : c.json({ error: 'Snapshot not found.' }, 404);
  });
  app.post('/storage/snapshots/:id/cancel', async (c) => {
    const status = await operations.cancel(c.req.param('id'));
    return status
      ? c.json(status)
      : c.json({ error: 'Snapshot not found.' }, 404);
  });
  app.post('/storage/snapshots/:id/release', async (c) => {
    await operations.release(c.req.param('id'));
    return c.json({ ok: true });
  });
  return app;
}
