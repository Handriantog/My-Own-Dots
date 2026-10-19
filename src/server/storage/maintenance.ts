import { AsyncLocalStorage } from 'node:async_hooks';

type WriteOptions = { background?: boolean };
type Snapshot = {
  origin: 'manual' | 'automatic';
  controller: AbortController;
  held: boolean;
};
export class MaintenanceBusyError extends Error {
  constructor() {
    super(
      'Workspace is busy. Finish the active chat or voice call and try again.',
    );
  }
}

/** Admission covers complete operations, including final receipts and cleanup.
 * Aborting a snapshot asks its reader to stop; only release admits new writers.
 */
export class MaintenanceGate {
  private writes = 0;
  private foreground = 0;
  private snapshot?: Snapshot;
  private closed = new AbortController();
  private changed = new Set<() => void>();
  private context = new AsyncLocalStorage<{ active: boolean }>();

  status(): { held: boolean; activeWrites: number } {
    return { held: this.snapshot?.held ?? false, activeWrites: this.writes };
  }

  async enterWrite(
    signal: AbortSignal,
    options: WriteOptions = {},
  ): Promise<() => void> {
    const nested = this.context.getStore()?.active === true;
    signal.throwIfAborted();
    if (!nested) {
      this.closed.signal.throwIfAborted();
      while (this.snapshot) {
        if (!options.background && this.snapshot.origin === 'automatic') {
          this.snapshot.controller.abort(
            new Error('Automatic snapshot yielded to foreground activity.'),
          );
        }
        // abort listeners may finish cleanup and release synchronously. Do not
        // subscribe after that notification and wait for a release that happened.
        if (!this.snapshot) continue;
        await this.wait(AbortSignal.any([signal, this.closed.signal]));
      }
      signal.throwIfAborted();
      this.closed.signal.throwIfAborted();
    }
    this.writes++;
    if (!options.background) this.foreground++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.writes--;
      if (!options.background) this.foreground--;
      this.notify();
    };
  }

  /** Nested tool writes can drain while acquisition is pending. A detached task
   * whose enclosing operation has ended must acquire its own admission again.
   */
  async runWrite<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
    options: WriteOptions = {},
  ): Promise<T> {
    const release = await this.enterWrite(signal, options);
    const context = { active: true };
    try {
      return await this.context.run(context, work);
    } finally {
      context.active = false;
      release();
    }
  }

  async acquire({
    origin,
    signal,
  }: {
    origin: 'manual' | 'automatic';
    signal: AbortSignal;
  }): Promise<{ signal: AbortSignal; release(): void }> {
    signal.throwIfAborted();
    this.closed.signal.throwIfAborted();
    if (this.snapshot || (origin === 'manual' && this.foreground > 0))
      throw new MaintenanceBusyError();
    const snapshot: Snapshot = {
      origin,
      controller: new AbortController(),
      held: false,
    };
    this.snapshot = snapshot;
    const combined = AbortSignal.any([
      signal,
      this.closed.signal,
      snapshot.controller.signal,
    ]);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (this.snapshot === snapshot) this.snapshot = undefined;
      this.notify();
    };
    try {
      while (this.writes > 0) await this.wait(combined);
      combined.throwIfAborted();
      snapshot.held = true;
      return { signal: combined, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  close(): void {
    this.closed.abort(new Error('Workspace admission is closed.'));
    this.notify();
  }

  async drain(): Promise<void> {
    const signal = new AbortController().signal;
    while (this.writes > 0 || this.snapshot) await this.wait(signal);
  }

  private notify(): void {
    for (const wake of [...this.changed]) wake();
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.changed.delete(wake);
        signal.removeEventListener('abort', abort);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      this.changed.add(wake);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
