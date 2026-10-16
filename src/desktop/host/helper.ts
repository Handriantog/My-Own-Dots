import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ObservationStream } from '../core/observations.js';
import type { GeometrySnapshot, Point } from '../shared/contracts.js';

export type HelperProcess = ChildProcessWithoutNullStreams;
interface Callbacks {
  scene(snapshot: GeometrySnapshot): void;
  status(message: string): void;
  pointer(input: { point: Point; down: boolean }): void;
}
type Factory = (executable: string, args: string[]) => HelperProcess;
export class HelperSupervisor {
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
