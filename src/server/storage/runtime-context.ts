import type {
  ContextBuilder,
  ContextFrame,
  ContextLimits,
} from '../context-builder.js';
import type { ContextCompaction } from '../context-compaction.js';
import type { SubscriptionPayload } from '../subscription-prompt.js';
import { projectMemoryContext } from '../context-projection.js';
import { payloadTokens } from '../context-budget.js';
import { MemoryCache } from '../memory-cache.js';
import { memoryDefaults } from '../memory-config.js';
import { measured } from '../memory-metrics.js';
import type { AsyncRepositories } from './repository-contract.js';
export type RuntimeContext = Pick<
  ContextBuilder,
  'essentials' | 'project' | 'inputTokens' | 'limits'
>;
export class WorkerContext implements RuntimeContext {
  readonly limits: ContextLimits;
  private estimates = new MemoryCache<number>();
  private prepared = false;
  constructor(
    private repositories: AsyncRepositories,
    limits: Partial<ContextLimits>,
    private compaction: ContextCompaction,
  ) {
    this.limits = {
      inputTokenLimit: limits.inputTokenLimit ?? memoryDefaults.inputTokenLimit,
      pinnedTokenLimit:
        limits.pinnedTokenLimit ?? memoryDefaults.pinnedTokenLimit,
    };
  }
  inputTokens(threadId: string) {
    return this.estimates.get(threadId);
  }
  essentials(dotId: string) {
    return this.repositories.context.essentials(dotId);
  }
  async project(
    payload: SubscriptionPayload,
    frame: ContextFrame,
    signal: AbortSignal,
  ) {
    const cold = !this.prepared;
    this.prepared = true;
    const projected = await measured(
      'context',
      () =>
        projectMemoryContext(payload, frame, signal, {
          ownerId: this.repositories.workspace.ownerId,
          limits: this.limits,
          compaction: this.compaction,
          maskMessages: (threadId, messages) =>
            this.repositories.workspace.memory.maskMessages(threadId, messages),
          essentials: (dotId) => this.essentials(dotId),
          validateEssentials: (dotId, items) =>
            this.repositories.context.validateEssentials(dotId, items),
        }),
      cold,
    );
    this.estimates.set(frame.threadId, payloadTokens(projected));
    return projected;
  }
}
