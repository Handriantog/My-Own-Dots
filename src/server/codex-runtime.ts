type Entry = {
  runId: string;
  threadId?: string;
  signal: AbortSignal;
  work: () => Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cancel(): void;
};

/** One executing task per Dot across text/voice and cloned agent instances. */
export class CodexExecutionCoordinator {
  private dots = new Map<
    string,
    { active?: Entry; queue: Entry[]; seen: Set<string> }
  >();
  status(dotId: string) {
    const state = this.dots.get(dotId);
    return {
      activeRunId: state?.active?.runId,
      activeThreadId: state?.active?.threadId,
      queued: state?.queue.length ?? 0,
    };
  }
  run<T>(
    dotId: string,
    runId: string,
    signal: AbortSignal,
    work: () => Promise<T>,
    threadId?: string,
  ): Promise<T> {
    const state = this.dots.get(dotId) ?? {
      queue: [],
      seen: new Set<string>(),
    };
    this.dots.set(dotId, state);
    if (signal.aborted) return Promise.reject(signal.reason);
    if (state.seen.has(runId))
      return Promise.reject(
        new Error(
          'This execution run was already admitted. Inspect its outcome before starting another run.',
        ),
      );
    state.seen.add(runId);
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        runId,
        threadId,
        signal,
        work,
        resolve: (value) => resolve(value as T),
        reject,
        cancel: () => {
          if (state.active !== entry) {
            state.queue = state.queue.filter((item) => item !== entry);
            signal.removeEventListener('abort', entry.cancel);
            reject(signal.reason);
          }
        },
      };
      signal.addEventListener('abort', entry.cancel, { once: true });
      state.queue.push(entry);
      this.pump(state);
    });
  }
  /** Hold the same FIFO execution slot while a host resumes an approval. */
  acquire(
    dotId: string,
    runId: string,
    signal: AbortSignal,
    threadId?: string,
  ): Promise<() => Promise<void>> {
    return new Promise((resolve, reject) => {
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      const completion = this.run(
        dotId,
        runId,
        signal,
        async () => {
          resolve(async () => {
            release();
            await completion;
          });
          await held;
        },
        threadId,
      );
      void completion.catch(reject);
    });
  }
  private pump(state: { active?: Entry; queue: Entry[] }) {
    if (state.active) return;
    const entry = state.queue.shift();
    if (!entry) return;
    state.active = entry;
    void Promise.resolve()
      .then(() => {
        entry.signal.throwIfAborted();
        return entry.work();
      })
      .then(entry.resolve, entry.reject)
      .finally(() => {
        entry.signal.removeEventListener('abort', entry.cancel);
        state.active = undefined;
        this.pump(state);
      });
  }
}

const coordinators = new WeakMap<object, CodexExecutionCoordinator>();
export function codexCoordinator(workspace: object) {
  let coordinator = coordinators.get(workspace);
  if (!coordinator) {
    coordinator = new CodexExecutionCoordinator();
    coordinators.set(workspace, coordinator);
  }
  return coordinator;
}
