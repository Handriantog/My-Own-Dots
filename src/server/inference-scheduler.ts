export type InferencePriority = 'foreground' | 'manual' | 'compact' | 'dream';
const rank: Record<InferencePriority, number> = {
  foreground: 0,
  manual: 1,
  compact: 2,
  dream: 3,
};
interface Entry {
  priority: InferencePriority;
  signal: AbortSignal;
  work: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cancel: () => void;
}
export class InferenceScheduler {
  private queue: Entry[] = [];
  private foreground = 0;
  private closed = false;
  private active?: {
    entry: Entry;
    controller: AbortController;
    done: Promise<void>;
  };
  get busy(): boolean {
    return this.foreground > 0;
  }
  async enterForeground(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('Inference scheduler is closed');
    this.foreground++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.foreground--;
      signal.removeEventListener('abort', release);
      this.pump();
    };
    signal.addEventListener('abort', release, { once: true });
    const active = this.active;
    if (active && active.entry.priority !== 'foreground') {
      active.controller.abort(
        new Error('Background inference yielded to chat'),
      );
      await active.done;
    }
    if (signal.aborted) {
      release();
      signal.throwIfAborted();
    }
    return release;
  }
  run<T>(
    priority: InferencePriority,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error('Inference scheduler is closed'));
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        priority,
        signal,
        work,
        resolve: (value) => resolve(value as T),
        reject,
        cancel: () => {},
      };
      entry.cancel = () => {
        if (this.active?.entry === entry)
          this.active.controller.abort(signal.reason);
        else {
          this.queue = this.queue.filter((item) => item !== entry);
          reject(signal.reason);
        }
      };
      signal.addEventListener('abort', entry.cancel, { once: true });
      this.queue.push(entry);
      this.queue.sort((a, b) => rank[a.priority] - rank[b.priority]);
      this.pump();
    });
  }
  private pump(): void {
    if (this.closed || this.active) return;
    const index = this.queue.findIndex(
      (entry) => !this.foreground || entry.priority === 'foreground',
    );
    if (index < 0) return;
    const entry = this.queue.splice(index, 1)[0],
      controller = new AbortController();
    const active = { entry, controller, done: Promise.resolve() };
    this.active = active;
    active.done = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return entry.work(controller.signal);
      })
      .then((value) => {
        controller.signal.throwIfAborted();
        entry.resolve(value);
      })
      .catch(entry.reject)
      .finally(() => {
        entry.signal.removeEventListener('abort', entry.cancel);
        if (this.active === active) this.active = undefined;
        this.pump();
      });
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      entry.signal.removeEventListener('abort', entry.cancel);
      entry.reject(new Error('Inference scheduler is closed'));
    }
    const active = this.active;
    active?.controller.abort(new Error('Inference scheduler is closed'));
    await active?.done;
  }
}
