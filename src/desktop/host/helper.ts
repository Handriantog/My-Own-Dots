import { z } from 'zod';
import type {
  ActivityPointerTransport,
  PhysicalPointer,
} from './activity-driver.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ObservationStream } from '../core/observations.js';
import type { GeometrySnapshot, Point } from '../shared/contracts.js';

export type HelperProcess = ChildProcessWithoutNullStreams;
const physicalSchema = z.strictObject({
  point: z.strictObject({
    x: z.number().finite().min(-100000).max(100000),
    y: z.number().finite().min(-100000).max(100000),
  }),
  down: z.boolean(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sampledAtMs: z.number().finite().nonnegative(),
  idleMs: z.number().finite().nonnegative(),
});
interface Callbacks {
  physical?(sample: PhysicalPointer): void;
  scene(snapshot: GeometrySnapshot): void;
  status(message: string): void;
  pointer(input: { point: Point; down: boolean }): void;
}
type Factory = (executable: string, args: string[]) => HelperProcess;
export class HelperSupervisor implements ActivityPointerTransport {
  private activityGeneration: number | null = null;
  private requestId = 0;
  private pending: {
    id: number;
    generation: number;
    session: string;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  async begin(generation: number): Promise<PhysicalPointer> {
    this.activityGeneration = generation;
    const value = await this.requestActivity('begin', generation);
    const sample = physicalSchema.safeParse(value.physical);
    if (value.ok !== true || !sample.success) {
      this.end(generation);
      throw Error('Native pointer setup unavailable.');
    }
    return sample.data;
  }
  async move(
    generation: number,
    point: Point,
    sample: PhysicalPointer,
  ): Promise<boolean> {
    if (this.activityGeneration !== generation)
      throw Error('Pointer session inactive.');
    if (
      !physicalSchema.safeParse(sample).success ||
      !Number.isFinite(point.x + point.y) ||
      Math.abs(point.x) > 100000 ||
      Math.abs(point.y) > 100000
    )
      throw Error('Invalid pointer target.');
    const value = await this.requestActivity('move', generation, {
      x: point.x,
      y: point.y,
      revision: sample.revision,
      sampledAtMs: sample.sampledAtMs,
    });
    return value.ok === true;
  }
  end(generation: number): void {
    if (this.activityGeneration === generation) this.activityGeneration = null;
    if (this.pending?.generation === generation)
      this.rejectPending('Activity stopped.');
    const session = this.current(performance.now())?.helperSession;
    if (session && this.child?.stdin.writable)
      this.child.stdin.write(
        JSON.stringify({
          kind: 'activity',
          op: 'end',
          generation,
          requestId: ++this.requestId,
          helperSession: session,
        }) + '\n',
      );
  }
  private requestActivity(
    op: 'begin' | 'move',
    generation: number,
    fields: Record<string, number> = {},
  ): Promise<Record<string, unknown>> {
    if (this.pending)
      return Promise.reject(Error('Native pointer request pending.'));
    const session = this.current(performance.now())?.helperSession;
    if (!session || !this.child?.stdin.writable)
      return Promise.reject(Error('Native pointer helper lost.'));
    const id = ++this.requestId,
      child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending('Native pointer timeout.');
        child.kill();
        this.failed(child);
      }, 250);
      this.pending = { id, generation, session, resolve, reject, timer };
      child.stdin.write(
        JSON.stringify({
          kind: 'activity',
          op,
          generation,
          requestId: id,
          helperSession: session,
          ...fields,
        }) + '\n',
      );
    });
  }
  private rejectPending(message: string): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(Error(message));
    }
  }
  private activityMessage(value: unknown): boolean {
    if (
      !value ||
      typeof value !== 'object' ||
      !('kind' in value) ||
      (value.kind !== 'activity-ack' && value.kind !== 'activity-input')
    )
      return false;
    const message = value as Record<string, unknown>;
    if (
      message.helperSession !== this.current(performance.now())?.helperSession
    )
      return true;
    if (message.kind === 'activity-input') {
      const sample = physicalSchema.safeParse(message.physical);
      if (message.generation === this.activityGeneration && sample.success)
        this.callbacks.physical?.(sample.data);
    } else {
      const pending = this.pending;
      if (
        pending &&
        message.requestId === pending.id &&
        message.generation === pending.generation &&
        message.helperSession === pending.session &&
        typeof message.ok === 'boolean'
      ) {
        this.pending = null;
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    }
    return true;
  }

  private child: HelperProcess | null = null;
  private observations = new ObservationStream();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = true;
  private mode: 'active' | 'idle' = 'active';
  constructor(
    private executable: string,
    private callbacks: Callbacks,
    private factory: Factory = (executable, args) =>
      spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] }),
  ) {}
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    this.launch();
  }
  restart(): void {
    this.stop();
    this.start();
  }
  current(nowMs: number): GeometrySnapshot | null {
    return this.observations.current(nowMs);
  }
  command(
    command: 'active' | 'idle' | 'refresh' | 'capture' | 'release',
  ): void {
    if (command === 'active' || command === 'idle') this.mode = command;
    if (this.child?.stdin.writable) this.child.stdin.write(`${command}\n`);
  }
  stop(): void {
    this.activityGeneration = null;
    this.rejectPending('Native pointer helper lost.');
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const child = this.child;
    this.child = null;
    this.observations.resetSession();
    child?.kill();
  }
  private launch(): void {
    if (this.stopped) return;
    this.observations.resetSession();
    let child: HelperProcess;
    try {
      child = this.factory(this.executable, [
        '--exclude-pid',
        String(process.pid),
      ]);
    } catch {
      this.failed(null);
      return;
    }
    this.child = child;
    let buffer = '';
    this.command(this.mode);
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // Drain diagnostics; do not retain unbounded output.
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child || this.stopped) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > 1_048_576) {
        child.kill();
        this.failed(child);
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (this.activityMessage(value)) continue;
        if (
          typeof value === 'object' &&
          value &&
          'kind' in value &&
          value.kind === 'pointer'
        ) {
          const p = value as Record<string, unknown>,
            point = p.point as Point | undefined;
          if (
            p.helperSession ===
              this.current(performance.now())?.helperSession &&
            typeof p.down === 'boolean' &&
            point &&
            Number.isFinite(point.x) &&
            Number.isFinite(point.y) &&
            Math.abs(point.x) < 100000 &&
            Math.abs(point.y) < 100000
          )
            this.callbacks.pointer({ point, down: p.down });
          continue;
        }
        const snapshot = this.observations.accept(value, performance.now());
        if (snapshot) this.callbacks.scene(snapshot);
      }
    });
    child.once('error', () => this.failed(child));
    child.once('exit', () => this.failed(child));
  }
  private failed(child: HelperProcess | null): void {
    if (this.stopped || (child && this.child !== child)) return;
    this.child = null;
    this.activityGeneration = null;
    this.rejectPending('Native pointer helper lost.');
    this.observations.resetSession();
    if (this.attempts >= 5) {
      this.callbacks.status(
        'Window tracking unavailable — Retry from the menu',
      );
      return;
    }
    const delay = 500 * 2 ** this.attempts++;
    this.callbacks.status('Window tracking unavailable — reconnecting');
    this.retry = setTimeout(() => {
      this.retry = null;
      this.launch();
    }, delay);
  }
}
