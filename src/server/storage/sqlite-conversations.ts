import type { BaseEvent } from '@ag-ui/core';
import { EventType } from '@ag-ui/core';
import { finalizeRunEvents } from '@copilotkit/runtime/v2';
import {
  replayRun,
  type ConversationSnapshot,
  type ConversationRepository,
  type ThreadInput,
  type ThreadLease,
} from '../local-conversations.js';
import type { StorageClient } from './storage-client.js';
/** Async API; the worker owns SQL/leases and replay stays outside database transactions. */
export class SQLiteConversations implements ConversationRepository {
  readonly ownerId: string;
  private leases = new Set<ThreadLease>();
  private initialization?: Promise<void>;
  private closed = false;
  constructor(
    private client: StorageClient,
    private options: { leaseMs?: number } = {},
  ) {
    this.ownerId = client.ownerId;
  }
  initialize(): Promise<void> {
    this.initialization ??= this.client
      .call('conversations.interruptedThreads', [])
      .then(async (threads) => {
        for (const thread of threads) await this.getSnapshot(thread);
      })
      .catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    return this.initialization;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.leases].map((lease) => lease.release()));
  }
  createThread(input: ThreadInput) {
    return this.client.call('conversations.createThread', [input]);
  }
  getOrCreateThread(input: ThreadInput) {
    return this.client.call('conversations.getOrCreateThread', [input]);
  }
  listThreads(agentId?: string) {
    return this.client.call('conversations.listThreads', [agentId]);
  }
  getEvents(threadId: string): Promise<BaseEvent[]> {
    return this.client.call('conversations.getEvents', [threadId]);
  }
  async getThreadMessages({
    threadId,
    userId,
  }: {
    threadId: string;
    userId: string;
  }) {
    if (userId !== this.ownerId)
      throw new Error('Conversation owner does not match.');
    return { messages: (await this.getSnapshot(threadId)).messages };
  }
  async getState(threadId: string) {
    return (await this.getSnapshot(threadId)).state;
  }
  private async replay(
    snapshot: ConversationSnapshot,
  ): Promise<ConversationSnapshot> {
    return snapshot.lastRun
      ? {
          ...snapshot,
          ...(await replayRun(snapshot.lastRun.input, snapshot.lastRun.events)),
        }
      : snapshot;
  }
  async getSnapshot(threadId: string) {
    const snapshot = await this.client.call('conversations.readSnapshot', [
      threadId,
    ]);
    if (snapshot.lastRun?.status !== 'running') return this.replay(snapshot);
    const lease = await this.acquireThread(threadId);
    if (!lease) return this.replay(snapshot);
    try {
      await this.recoverInterrupted(lease);
      return await lease.read();
    } finally {
      await lease.release();
    }
  }
  async isRunning(threadId: string) {
    const lease = await this.acquireThread(threadId);
    if (!lease) return true;
    await lease.release();
    return false;
  }
  async acquireThread(threadId: string): Promise<ThreadLease | null> {
    if (this.closed) throw new Error('Conversation storage is closed');
    const duration = this.options.leaseMs ?? 30_000;
    const key = await this.client.call('conversations.acquire', [
      threadId,
      duration,
    ]);
    if (!key) return null;
    const controller = new AbortController();
    const lost = () =>
      controller.abort(new Error('Conversation storage connection was lost.'));
    this.client.signal.addEventListener('abort', lost, { once: true });
    if (this.client.signal.aborted) lost();
    let released = false;
    let releasePromise: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    const operation = <T>(fn: () => Promise<T>): Promise<T> => {
      if (released)
        return Promise.reject(new Error('Conversation lock was released.'));
      if (controller.signal.aborted)
        return Promise.reject(controller.signal.reason);
      const promise = fn().catch((error) => {
        controller.abort(error);
        throw error;
      });
      pending.add(promise);
      void promise
        .finally(() => pending.delete(promise))
        .catch(() => undefined);
      return promise;
    };
    let renewing = false;
    const heartbeat = setInterval(
      () => {
        if (renewing || released || controller.signal.aborted) return;
        renewing = true;
        void operation(() =>
          this.client.call('conversations.renew', [key, duration]),
        )
          .catch(() => undefined)
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(10, Math.floor(duration / 3)),
    );
    heartbeat.unref();
    const lease: ThreadLease = {
      signal: controller.signal,
      read: () =>
        operation(async () =>
          this.replay(
            await this.client.call('conversations.readLeased', [key]),
          ),
        ),
      beginRun: (input, guard) =>
        operation(() =>
          this.client.call('conversations.beginRun', [key, input, guard]),
        ),
      addEvidenceGuard: (guard) =>
        operation(() =>
          this.client.call('conversations.addEvidenceGuard', [key, guard]),
        ),
      appendEvent: (event) =>
        operation(() =>
          this.client.call('conversations.appendEvent', [key, event]),
        ),
      finishRun: (messages, state, status, terminal) =>
        operation(() =>
          this.client.call('conversations.finishRun', [
            key,
            messages,
            state,
            status,
            terminal,
          ]),
        ),
      release: () => {
        releasePromise ??= (async () => {
          released = true;
          clearInterval(heartbeat);
          this.client.signal.removeEventListener('abort', lost);
          await Promise.allSettled([...pending]);
          try {
            await this.client.call('conversations.release', [key]);
          } finally {
            this.leases.delete(lease);
          }
        })();
        return releasePromise;
      },
    };
    this.leases.add(lease);
    return lease;
  }
  async recoverInterrupted(lease: ThreadLease) {
    const snapshot = await lease.read();
    const run = snapshot.lastRun;
    if (run?.status !== 'running') return;
    const events = structuredClone(run.events);
    const terminal = events.at(-1)?.type;
    for (const event of finalizeRunEvents(events, {
      interruptionMessage:
        'Server stopped during this run. Review completed effects before retrying.',
    }))
      await lease.appendEvent(event);
    const recovered = await replayRun(run.input, events);
    await lease.finishRun(
      recovered.messages,
      recovered.state,
      terminal === EventType.RUN_FINISHED
        ? 'finished'
        : terminal === EventType.RUN_ERROR
          ? 'failed'
          : 'interrupted',
    );
  }
}
