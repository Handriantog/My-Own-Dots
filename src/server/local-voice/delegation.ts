import type { RunLifecycle } from '../local-runner.js';
import type { AsyncRepositories } from '../storage/repository-contract.js';
import type {
  ConversationSnapshot,
  LocalConversationStore,
} from '../local-conversations.js';
import type {
  VoiceDelegation,
  VoiceDelegationOutcome,
  VoiceDelegationLease,
} from '../../shared/voice-delegation.js';
import { pageReviewTool } from '../../shared/page-review.js';
import { connectionActionTool } from '../../shared/connection-types.js';
import { folderApprovalTool } from '../../shared/folder-access.js';

export const delegatedApprovalTools = [
  pageReviewTool,
  connectionActionTool,
  folderApprovalTool,
];
export function delegatedOutcome(
  snapshot: ConversationSnapshot,
): VoiceDelegationOutcome {
  if (snapshot.lastRun?.status !== 'finished')
    return {
      status:
        snapshot.lastRun?.status === 'stopped'
          ? 'cancelled'
          : snapshot.lastRun?.status === 'failed'
            ? 'failed'
            : 'interrupted',
      error:
        'The task stopped. Review its conversation before starting it again.',
    };
  const answered = new Set(
    snapshot.messages.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : [])),
  );
  if (
    snapshot.messages.some(
      (m) =>
        m.role === 'assistant' &&
        m.toolCalls?.some(
          (t) =>
            delegatedApprovalTools.some(
              (tool) => tool.name === t.function.name,
            ) && !answered.has(t.id),
        ),
    )
  )
    return { status: 'approval' };
  // Tool results can follow the assistant's answer. Only this run's new
  // messages may supply its receipt; older approval prose is not a result.
  const inputIds = new Set(snapshot.lastRun.input.messages.map((m) => m.id));
  const last = snapshot.messages.findLast(
    (m) =>
      m.role === 'assistant' &&
      !inputIds.has(m.id) &&
      typeof m.content === 'string' &&
      !!m.content.trim(),
  );
  return {
    status: 'completed',
    result:
      last?.role === 'assistant' && typeof last.content === 'string'
        ? last.content.slice(0, 131072)
        : 'The task finished. Review its conversation for details.',
  };
}

/** Called by every runner entry, including UI approval continuations. No model can supply its scope. */
export class VoiceDelegationCoordinator implements RunLifecycle {
  private interrupted = new Map<string, VoiceDelegationLease>();
  private changed = new Set<(job: VoiceDelegation) => void>();
  constructor(
    readonly jobs: AsyncRepositories['voiceDelegations'],
    private conversations: LocalConversationStore,
    private options: { leaseMs?: number; heartbeatMs?: number } = {},
  ) {}
  listen(listener: (job: VoiceDelegation) => void) {
    this.changed.add(listener);
    return () => {
      this.changed.delete(listener);
    };
  }
  private notify(job: VoiceDelegation) {
    for (const listener of this.changed) {
      try {
        listener(job);
      } catch {
        /* Durable state remains authoritative. */
      }
    }
  }
  async recover() {
    const reconciled: (VoiceDelegationOutcome & {
      id: string;
      runId: string;
    })[] = [];
    for (const job of await this.jobs.list({ active: true })) {
      if (!job.runId || job.status !== 'running') continue;
      const snapshot = await this.conversations.getSnapshot(job.workerThreadId);
      if (
        snapshot.lastRun?.runId === job.runId &&
        snapshot.lastRun.status !== 'running'
      )
        reconciled.push({
          id: job.id,
          runId: job.runId,
          ...delegatedOutcome(snapshot),
        });
    }
    // Recovery never dispatches work or produces speech.
    return await this.jobs.recover({ reconciled });
  }
  async reconcile() {
    for (const [id, lease] of this.interrupted) {
      try {
        const job = await this.jobs.interrupt(lease);
        this.interrupted.delete(id);
        if (job) this.notify(job);
      } catch {
        /* Retry after a transient storage failure or a held thread lease. */
      }
    }
  }
  async begin(request: Parameters<RunLifecycle['begin']>[0]) {
    const job = await this.jobs.forThread(request.input.threadId);
    if (!job) return;
    if (job.dotId !== request.agentId)
      throw Error('Delegated task Dot mismatch.');
    if (!['queued', 'approval'].includes(job.status))
      throw Error('Delegated task is already running or completed.');
    if (job.runId === request.input.runId)
      throw Error('Delegated task run already exists.');
    const snapshot = await this.conversations.getSnapshot(job.workerThreadId);
    const ids = new Set(snapshot.messages.map((m) => m.id));
    const additions = request.input.messages.filter((m) => !ids.has(m.id));
    if (job.status === 'queued') {
      if (
        additions.length !== 1 ||
        additions[0].id !== `voice-task:${job.id}` ||
        additions[0].role !== 'user' ||
        additions[0].content !== job.request
      )
        throw Error('Delegated task request mismatch.');
    } else if (!additions.length || additions.some((m) => m.role !== 'tool')) {
      throw Error('Resume this task using its pending approval card.');
    }
    request.signal.throwIfAborted();
    const leaseMs = this.options.leaseMs ?? 30000;
    let lease = await this.jobs.claim(job.id, request.input.runId, leaseMs);
    if (!lease) throw Error('Delegated task could not be claimed.');
    let ended = false;
    let pending: Promise<void> = Promise.resolve();
    let renewalFailure: unknown;
    const renew = () => {
      if (ended) return;
      pending = pending.then(async () => {
        if (ended) return;
        try {
          lease = await this.jobs.renew(lease!, leaseMs);
        } catch (error) {
          renewalFailure = error;
          ended = true;
          clearInterval(timer);
          request.abort();
        }
      });
    };
    const timer = setInterval(renew, this.options.heartbeatMs ?? 10000);
    timer.unref?.();
    return {
      settle: async (
        outcome: Parameters<
          NonNullable<Awaited<ReturnType<RunLifecycle['begin']>>>['settle']
        >[0],
      ) => {
        ended = true;
        clearInterval(timer);
        await pending;
        const result: VoiceDelegationOutcome = outcome.stopped
          ? { status: 'cancelled' }
          : outcome.failed
            ? {
                status: 'failed',
                error:
                  'The task failed. Review its conversation before retrying.',
              }
            : outcome.snapshot
              ? delegatedOutcome(outcome.snapshot)
              : { status: 'interrupted' };
        try {
          if (renewalFailure) throw renewalFailure;
          this.notify(await this.jobs.settle(lease!, result));
        } catch {
          this.interrupted.set(job.id, lease!);
          await this.reconcile();
        }
      },
    };
  }
}
