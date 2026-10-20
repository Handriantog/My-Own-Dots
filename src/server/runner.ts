import type { StoreRepository } from './storage/runtime-repositories.js';
import type { MaintenanceGate } from './storage/maintenance.js';
import { DEFAULT_WORKER_LEASE_MS } from './store.js';
import type { Result, Memory } from '../shared/types.js';
import type { Claim } from './store.js';
import { research, type Config } from './research.js';
import { DEFAULT_AGENT_RUN_TIMEOUT_MS } from './platform-config.js';
export class Runner {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, AbortController>();
  private readonly shutdown = new AbortController();
  private ticking?: Promise<void>;
  constructor(
    private store: StoreRepository,
    private config: Config,
    private execute?: (
      claim: Claim,
      memories: Memory[],
      signal: AbortSignal,
      progress: (text: string) => void | Promise<void>,
    ) => Promise<Result>,
    private runTimeoutMs = DEFAULT_AGENT_RUN_TIMEOUT_MS,
    private maintenance?: MaintenanceGate,
  ) {}
  start() {
    if (!this.timer && !this.shutdown.signal.aborted) {
      this.timer = setInterval(() => void this.tick(), 1000);
      void this.tick();
    }
  }
  async stop() {
    this.shutdown.abort(new Error('Background runner stopped.'));
    clearInterval(this.timer);
    this.timer = undefined;
    this.abortAll();
    for (const task of await this.store.tasks()) {
      if (this.active.has(task.id) && task.lease)
        await this.store.interrupt(
          { ...task, lease: task.lease },
          'Server stopped during this run. Review completed effects before retrying.',
        );
    }
    await this.ticking;
  }
  abort(id: string) {
    this.active.get(id)?.abort(new Error('Run stopped.'));
  }
  abortAll() {
    for (const controller of this.active.values())
      controller.abort(new Error('Run stopped because settings changed.'));
  }
  tick(): Promise<void> {
    if (this.shutdown.signal.aborted) return Promise.resolve();
    return (this.ticking ??= this.executeTick().finally(() => {
      this.ticking = undefined;
    }));
  }
  private async executeTick() {
    try {
      if (this.maintenance)
        await this.maintenance.runWrite(
          this.shutdown.signal,
          () => this.runTick(),
          { background: true },
        );
      else await this.runTick();
    } catch {
      if (this.shutdown.signal.aborted) return;
      // StoreRepository errors must not become unhandled interval promise rejections.
      // Do not log task content, provider responses, or database details.
      console.error(
        'Background runner tick failed; will retry on the next tick.',
      );
    }
  }
  private async runTick() {
    if (this.active.size) return;
    // Leave time to persist the outcome after the configured run timeout.
    const claim = await this.store.claim(
      Date.now(),
      Math.max(DEFAULT_WORKER_LEASE_MS, this.runTimeoutMs * 2),
    );
    if (!claim) return;
    if (this.shutdown.signal.aborted) {
      await this.store.interrupt(
        claim,
        'Server stopped before this task started.',
      );
      return;
    }
    const controller = new AbortController();
    this.active.set(claim.id, controller);
    const ownershipCheck = setInterval(async () => {
      try {
        if (!(await this.store.owns(claim)))
          controller.abort(new Error('Run permission or lease was revoked.'));
      } catch {
        controller.abort(new Error('Run ownership check failed.'));
      }
    }, 100);
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Research exceeded the ${this.runTimeoutMs / 1000} second time limit.`,
          ),
        ),
      this.runTimeoutMs,
    );
    let release: (() => void) | undefined;
    let progressWrites = Promise.resolve();
    try {
      // A claimed task is active foreground work even when a timer admitted it.
      // This keeps manual backup from waiting on a nested HTTP turn indefinitely.
      release = await this.maintenance?.enterWrite(this.shutdown.signal);
      const settings = await this.store.settings();
      const memories = settings.memoryAllowed
        ? await this.store.memories()
        : [];
      const progress = (text: string) => {
        const write = progressWrites.then(async () => {
          if (!(await this.store.owns(claim)))
            controller.abort(new Error('Run permission or lease was revoked.'));
          controller.signal.throwIfAborted();
          await this.store.event(claim.id, claim.lease, text);
        });
        progressWrites = write;
        void write.catch(() =>
          controller.abort(new Error('Task progress could not be saved.')),
        );
        return write;
      };
      const result = this.execute
        ? await this.execute(claim, memories, controller.signal, progress)
        : await research(
            claim.prompt,
            memories,
            this.config,
            controller.signal,
            progress,
          );
      await progressWrites;
      controller.signal.throwIfAborted();
      await this.store.finish(claim, result);
    } catch (error) {
      await progressWrites.catch(() => {});
      await this.store.fail(
        claim,
        error instanceof Error ? error.message : 'Unexpected research failure.',
      );
    } finally {
      clearInterval(ownershipCheck);
      clearTimeout(timeout);
      this.active.delete(claim.id);
      release?.();
    }
  }
}
