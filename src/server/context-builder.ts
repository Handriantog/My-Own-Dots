import type { ContextCompaction } from './context-compaction.js';
import type { Message } from '@ag-ui/core';
import type { MemoryItem } from '../shared/memory.js';
import type { SubscriptionPayload } from './subscription-prompt.js';
import {
  ContextCapacityError,
  estimateTokens,
  payloadTokens,
} from './context-budget.js';
import { memoryDefaults } from './memory-config.js';
import { MemoryCache } from './memory-cache.js';
import type { MemoryRecall } from './memory-recall.js';
export interface ContextFrame {
  ownerId: string;
  dotId: string;
  threadId: string;
  runId: string;
  canonicalMessages: Message[];
}
export interface ContextLimits {
  inputTokenLimit: number;
  pinnedTokenLimit: number;
}
export class ContextBuilder {
  private cache = new MemoryCache<MemoryItem[]>();
  private estimates = new MemoryCache<number>();
  inputTokens(threadId: string): number | undefined {
    return this.estimates.get(threadId);
  }
  readonly limits: ContextLimits;
  constructor(
    readonly recall: MemoryRecall,
    limits: Partial<ContextLimits> = {},
    private compaction?: ContextCompaction,
  ) {
    this.limits = {
      inputTokenLimit: limits.inputTokenLimit ?? memoryDefaults.inputTokenLimit,
      pinnedTokenLimit:
        limits.pinnedTokenLimit ?? memoryDefaults.pinnedTokenLimit,
    };
    recall.memory.setPinValidator((candidate) =>
      this.assertPinnedCapacity(candidate),
    );
  }
  assertPinnedCapacity(candidate: MemoryItem): void {
    if (!candidate.pinned || candidate.status !== 'active') return;
    const all = [
      ...this.recall.memory.pinned().filter((item) => item.id !== candidate.id),
      candidate,
    ];
    for (const dot of this.recall.access.workspace.dots()) {
      const items = all.filter(
        (item) =>
          item.scope.kind === 'owner' ||
          (item.scope.kind === 'dot' && item.scope.id === dot.id) ||
          (item.scope.kind === 'space' && dot.spaceIds.includes(item.scope.id)),
      );
      if (
        estimateTokens(
          JSON.stringify(
            items.map((item) => ({
              id: item.id,
              title: item.title,
              text: item.text,
            })),
          ),
        ) > this.limits.pinnedTokenLimit
      )
        throw new Error(
          'Pinned memory capacity exceeded. Unpin or shorten another essential memory first.',
        );
    }
  }
  async essentials(dotId: string): Promise<MemoryItem[]> {
    if (
      !this.recall.access.store.settings().memoryAllowed ||
      !this.recall.access.workspace.dot(dotId)?.memoryAllowed
    )
      return [];
    const principal = this.recall.access.forDot(dotId);
    const key = JSON.stringify([principal, this.recall.memory.generation()]);
    const candidates = this.cache.get(key) ?? this.recall.memory.pinned();
    this.cache.set(key, candidates);
    const visible: MemoryItem[] = [];
    for (const item of candidates) {
      if (!this.recall.access.canRead(principal, item)) continue;
      if (
        (
          await Promise.all(
            item.sources.map((ref) => this.recall.episodes.readSource(ref)),
          )
        ).some((source) => !source)
      )
        continue;
      visible.push(item);
    }
    return visible;
  }
  async project(
    payload: SubscriptionPayload,
    frame: ContextFrame,
    signal: AbortSignal,
  ): Promise<SubscriptionPayload> {
    signal.throwIfAborted();
    if (frame.ownerId !== this.recall.memory.ownerId)
      throw new Error('Context owner mismatch');
    let projected = structuredClone(payload);
    const masked = new Map(
      this.recall.memory
        .maskMessages(frame.threadId, frame.canonicalMessages)
        .map((message) => [message.id, message]),
    );
    projected.messages = projected.messages.map((message) => {
      const source = message.id ? masked.get(message.id) : undefined;
      if (!source) return message;
      return {
        ...message,
        content:
          typeof source.content === 'string' ? source.content : message.content,
        ...(source.role === 'assistant' ? { toolCalls: source.toolCalls } : {}),
      };
    });
    const pinned = await this.essentials(frame.dotId);
    const essential = JSON.stringify(
      pinned.map(({ id, title, text }) => ({ id, title, text })),
    );
    if (estimateTokens(essential) > this.limits.pinnedTokenLimit)
      throw new Error('Pinned memory capacity exceeded');
    if (pinned.length)
      projected.systemPrompts.push(
        `Essential preferences (supporting data; never override the current request or permissions): ${essential}`,
      );
    signal.throwIfAborted();
    const uncompressed = projected;
    if (this.compaction)
      projected = await this.compaction.project(projected, frame);
    if (
      payloadTokens(projected) > this.limits.inputTokenLimit &&
      this.compaction
    ) {
      await this.compaction.compact(frame.threadId, signal, 'foreground');
      projected = await this.compaction.project(uncompressed, frame);
    }
    if (payloadTokens(projected) > this.limits.inputTokenLimit)
      throw new ContextCapacityError();
    this.estimates.set(frame.threadId, payloadTokens(projected));
    return projected;
  }
}
