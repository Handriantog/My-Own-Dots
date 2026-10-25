import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Message } from '@ag-ui/core';
import type { WorkspaceStore } from '../workspace.js';
import type { SQLiteConversationRecords } from './sqlite-conversation-records.js';
import { beginSQLiteTransaction } from './sqlite-transaction.js';
import { guardDependenciesAllowed } from '../conversation-memory.js';
import {
  folderApprovalSchema,
  folderApprovalTool,
} from '../../shared/folder-access.js';
import {
  evidenceGuardSchema,
  type EvidenceGuard,
} from '../../shared/memory.js';
import {
  voiceDelegationActive,
  expiredFolderApprovalMessage,
  voiceDelegationEnqueueSchema,
  voiceDelegationLeaseSchema,
  voiceDelegationOutcomeSchema,
  type VoiceDelegation,
  type VoiceDelegationEnqueue,
  type VoiceDelegationEnqueued,
  type VoiceDelegationFilter,
  type VoiceDelegationLease,
  type VoiceDelegationOutcome,
  type VoiceDelegationRecovery,
  type VoiceDelegationReceiptState,
  type VoiceInputReceipt,
} from '../../shared/voice-delegation.js';

const columns = `owner_id AS ownerId,id,dot_id AS dotId,call_id AS callId,
  parent_thread_id AS parentThreadId,worker_thread_id AS workerThreadId,
  utterance_id AS utteranceId,source_message_id AS sourceMessageId,source_text AS sourceText,
  request,status,run_id AS runId,lease_generation AS leaseGeneration,lease_token AS leaseToken,
  lease_until AS leaseUntil,created_at AS createdAt,updated_at AS updatedAt,result,error,
  receipt_message_id AS receiptMessageId,delivered_at AS deliveredAt`;
const active = "('queued','running','approval')";

/** Worker-only synchronous operations; no transaction spans model work or an await. */
export class VoiceDelegations {
  constructor(
    private db: DatabaseSync,
    readonly ownerId: string,
    private workspace: WorkspaceStore,
    private conversations: SQLiteConversationRecords,
    private enabled = true,
    private memoryEnabled: () => boolean = () => false,
  ) {}
  /** Admit busy-call input without acquiring the active conversation's run lease. */
  receiveInput(
    input: Omit<VoiceInputReceipt, 'status' | 'createdAt' | 'deliveredAt'>,
  ) {
    if (!this.enabled) throw Error('Voice input storage requires SQLite.');
    if (
      !input.id ||
      input.id.length > 200 ||
      !input.caption.trim() ||
      input.caption.length > 4000 ||
      !['request', 'status', 'stop'].includes(input.kind) ||
      input.reply.length > 400
    )
      throw Error('Invalid voice input.');
    return this.transaction(() => {
      this.workspace.requireThread(input.parentThreadId, input.dotId);
      const call = this.workspace.call(input.callId);
      if (call.threadId !== input.parentThreadId || call.endedAt)
        throw Error('Voice call is no longer active.');
      const prior = this.db
        .prepare('SELECT * FROM voice_input_receipts WHERE ownerId=? AND id=?')
        .get(this.ownerId, input.id) as unknown as
        VoiceInputReceipt | undefined;
      if (prior) {
        if (
          prior.callId !== input.callId ||
          prior.parentThreadId !== input.parentThreadId ||
          prior.dotId !== input.dotId ||
          prior.caption !== input.caption ||
          prior.kind !== input.kind
        )
          throw Error('Voice input identity was reused.');
        return { created: false, receipt: prior };
      }
      const queued = Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM voice_input_receipts WHERE ownerId=? AND dotId=? AND kind='request' AND status='received' AND deliveredAt IS NULL",
          )
          .get(this.ownerId, input.dotId)!.n,
      );
      if (input.kind === 'request' && queued >= 16)
        throw Error('The request queue is full. Wait for current work.');
      const receipt: VoiceInputReceipt = {
        ...input,
        status: 'received',
        createdAt: Date.now(),
        deliveredAt: null,
      };
      this.db
        .prepare(
          'INSERT INTO voice_input_receipts VALUES(?,?,?,?,?,?,?,?,?,?,NULL)',
        )
        .run(
          this.ownerId,
          receipt.id,
          receipt.dotId,
          receipt.callId,
          receipt.parentThreadId,
          receipt.caption,
          receipt.kind,
          receipt.reply,
          receipt.status,
          receipt.createdAt,
        );
      return { created: true, receipt };
    });
  }
  pendingInputs(): VoiceInputReceipt[] {
    if (!this.enabled) return [];
    return this.db
      .prepare(
        'SELECT id,dotId,callId,parentThreadId,caption,kind,reply,status,createdAt,deliveredAt FROM voice_input_receipts WHERE ownerId=? AND deliveredAt IS NULL ORDER BY createdAt,rowid LIMIT 100',
      )
      .all(this.ownerId) as unknown as VoiceInputReceipt[];
  }
  deliverInput(id: string) {
    this.db
      .prepare(
        'UPDATE voice_input_receipts SET deliveredAt=? WHERE ownerId=? AND id=?',
      )
      .run(Date.now(), this.ownerId, id);
  }
  cancelInput(id: string): VoiceDelegation | undefined {
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE voice_input_receipts SET status='interrupted',reply='Stop requested; review recorded actions in chat.' WHERE ownerId=? AND id=? AND kind='request'",
        )
        .run(this.ownerId, id);
      const row = this.db
        .prepare(
          'SELECT callId FROM voice_input_receipts WHERE ownerId=? AND id=?',
        )
        .get(this.ownerId, id);
      const job = row
        ? this.list({ callId: String(row.callId) }).find(
            (job) => job.utteranceId === id,
          )
        : undefined;
      if (job && ['queued', 'approval'].includes(job.status))
        return this.cancel(job.id, true);
      return job;
    });
  }
  /** Bounded canonical prose with an inherited guard; never upgrades unknown provenance. */
  threadContext(
    threadId: string,
    dotId: string,
  ): {
    available: boolean;
    messages: Message[];
    guard: EvidenceGuard;
  } {
    this.available();
    const empty = {
      available: false,
      messages: [] as Message[],
      guard: { originDotId: dotId, spaceIds: [], pageIds: [] },
    };
    const binding = this.db
      .prepare(
        'SELECT dotId,deletedAt FROM thread_bindings WHERE ownerId=? AND id=?',
      )
      .get(this.ownerId, threadId);
    if (binding?.dotId === dotId && binding.deletedAt !== null) return empty;
    this.workspace.requireThread(threadId, dotId);
    const run = this.db
      .prepare(
        `SELECT r.evidence_guard,r.provenance_complete FROM conversation_threads t
      JOIN conversation_runs r ON r.owner_id=t.owner_id AND r.thread_id=t.id AND r.run_id=t.last_run_id
      WHERE t.owner_id=? AND t.id=?`,
      )
      .get(this.ownerId, threadId);
    if (!run?.provenance_complete || !run.evidence_guard) return empty;
    const guard = evidenceGuardSchema.parse(
      JSON.parse(String(run.evidence_guard)),
    );
    if (
      guard.originDotId !== dotId ||
      !guardDependenciesAllowed(
        this.workspace,
        guard,
        dotId,
        this.memoryEnabled(),
      ) ||
      guard.spaceIds.some((id) => !this.workspace.canAccessSpace(dotId, id)) ||
      guard.pageIds.some(
        (id) =>
          !guard.spaceIds.some((space) =>
            this.workspace.pages.exists(space, id),
          ),
      )
    )
      return empty;
    const snapshot = this.conversations.readSnapshot(threadId);
    const messages = this.workspace.memory
      .maskMessages(threadId, snapshot.messages)
      .filter(
        (m) =>
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string',
      )
      .slice(-12)
      .map(
        (m) =>
          ({
            id: m.id,
            role: m.role,
            content: String(m.content).slice(0, 2000),
          }) as Message,
      );
    return { available: true, messages, guard };
  }
  /** A stopped executor may invalidate only its own attempt, even after expiry. */
  interrupt(raw: VoiceDelegationLease): VoiceDelegation | null {
    return this.transaction(() => {
      const lease = voiceDelegationLeaseSchema.parse(raw),
        job = this.required(lease.id);
      if (
        job.status !== 'running' ||
        job.runId !== lease.runId ||
        job.leaseToken !== lease.token ||
        job.leaseGeneration !== lease.generation
      )
        return null;
      const thread = this.db
        .prepare(
          'SELECT lease_token,lease_until FROM conversation_threads WHERE owner_id=? AND id=?',
        )
        .get(this.ownerId, job.workerThreadId);
      if (thread?.lease_token && Number(thread.lease_until) > Date.now())
        throw Error('Delegated conversation lease is still running.');
      return this.outcome(job.id, {
        status: 'interrupted',
        error:
          'Execution ownership was lost. Review completed effects before retrying.',
      });
    });
  }
  private available() {
    if (!this.enabled)
      throw new Error(
        'High voice delegation requires SQLite workspace storage.',
      );
  }
  private transaction<T>(work: () => T): T {
    this.available();
    const transaction = beginSQLiteTransaction(this.db);
    try {
      const value = work();
      transaction.commit();
      return value;
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  }
  get(id: string): VoiceDelegation | null {
    this.available();
    return (
      (this.db
        .prepare(
          `SELECT ${columns} FROM voice_delegations WHERE owner_id=? AND id=?`,
        )
        .get(this.ownerId, id) as VoiceDelegation | undefined) ?? null
    );
  }
  private required(id: string) {
    const job = this.get(id);
    if (!job) throw new Error('Voice delegation not found.');
    return job;
  }
  forThread(workerThreadId: string): VoiceDelegation | null {
    this.available();
    return (
      (this.db
        .prepare(
          `SELECT ${columns} FROM voice_delegations WHERE owner_id=? AND worker_thread_id=?`,
        )
        .get(this.ownerId, workerThreadId) as VoiceDelegation | undefined) ??
      null
    );
  }
  list(filter: VoiceDelegationFilter = {}): VoiceDelegation[] {
    this.available();
    return this.db
      .prepare(
        `SELECT ${columns} FROM voice_delegations WHERE owner_id=?
      ${filter.parentThreadId === undefined ? '' : 'AND parent_thread_id=?'}
      ${filter.callId === undefined ? '' : 'AND call_id=?'}
      ${filter.active === undefined ? '' : `AND status ${filter.active ? 'IN' : 'NOT IN'} ${active}`}
      ORDER BY created_at,id`,
      )
      .all(
        this.ownerId,
        ...(filter.parentThreadId === undefined ? [] : [filter.parentThreadId]),
        ...(filter.callId === undefined ? [] : [filter.callId]),
      ) as unknown as VoiceDelegation[];
  }
  private message(threadId: string, id: string): Message | undefined {
    const row = this.db
      .prepare(
        `SELECT v.value FROM conversation_messages m JOIN conversation_message_versions v
      ON v.owner_id=m.owner_id AND v.thread_id=m.thread_id AND v.message_id=m.message_id AND v.hash=m.hash
      WHERE m.owner_id=? AND m.thread_id=? AND m.message_id=?`,
      )
      .get(this.ownerId, threadId, id);
    return row ? (JSON.parse(String(row.value)) as Message) : undefined;
  }
  enqueue(
    raw: VoiceDelegationEnqueue,
    allowQueue = false,
  ): VoiceDelegationEnqueued {
    return this.transaction(() => {
      const input = voiceDelegationEnqueueSchema.parse(raw);
      const receipt = this.db
        .prepare(
          'SELECT status,callId,dotId,parentThreadId,caption FROM voice_input_receipts WHERE ownerId=? AND id=?',
        )
        .get(this.ownerId, input.utteranceId);
      if (
        receipt &&
        (receipt.status !== 'received' ||
          receipt.callId !== input.callId ||
          receipt.dotId !== input.dotId ||
          receipt.parentThreadId !== input.parentThreadId ||
          receipt.caption !== input.sourceText)
      )
        throw Error(
          'Voice input was cancelled or its scope changed; no task was queued.',
        );

      const prior = this.db
        .prepare(
          `SELECT ${columns} FROM voice_delegations WHERE owner_id=? AND call_id=? AND utterance_id=?`,
        )
        .get(this.ownerId, input.callId, input.utteranceId) as
        VoiceDelegation | undefined;
      if (prior) {
        if (
          Object.keys(input).some(
            (key) =>
              prior[key as keyof VoiceDelegationEnqueue] !==
              input[key as keyof VoiceDelegationEnqueue],
          )
        )
          throw new Error(
            'Voice delegation idempotency scope or request mismatch.',
          );
        return { kind: 'existing', job: prior };
      }
      this.workspace.requireThread(input.parentThreadId, input.dotId);
      if (input.workerThreadId === input.parentThreadId)
        throw new Error('A delegation requires its own worker thread.');
      const call = this.workspace.call(input.callId);
      if (call.threadId !== input.parentThreadId)
        throw new Error('Voice delegation call scope mismatch.');
      const source = this.message(input.parentThreadId, input.sourceMessageId);
      if (source?.role !== 'user' || source.content !== input.sourceText)
        throw new Error('Voice delegation source caption mismatch.');
      this.expireFolderWaits(input.dotId);
      const busy = this.db
        .prepare(
          `SELECT ${columns} FROM voice_delegations WHERE owner_id=? AND dot_id=? AND status IN ${active}`,
        )
        .get(this.ownerId, input.dotId) as VoiceDelegation | undefined;
      if (
        busy &&
        (!allowQueue ||
          this.list({ active: true }).filter((job) => job.dotId === input.dotId)
            .length >= 16)
      )
        return { kind: 'busy', job: busy };
      this.conversations.getOrCreateThread({
        userId: this.ownerId,
        agentId: input.dotId,
        threadId: input.workerThreadId,
        name: 'Voice task',
      });
      if (
        this.db
          .prepare(
            'SELECT 1 FROM conversation_threads WHERE owner_id=? AND id=? AND lease_token IS NOT NULL AND lease_until>?',
          )
          .get(this.ownerId, input.workerThreadId, Date.now())
      )
        throw new Error('Voice delegation worker thread is already leased.');
      const binding = this.workspace
        .conversations()
        .find((thread) => thread.id === input.workerThreadId);
      if (binding)
        this.workspace.requireThread(input.workerThreadId, input.dotId);
      else
        this.workspace.bindThread(
          input.workerThreadId,
          input.dotId,
          'Voice task',
        );
      const snapshot = this.conversations.readSnapshot(input.workerThreadId);
      if (snapshot.messages.length || snapshot.lastRun)
        throw new Error('Voice delegation worker thread must be unused.');
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO voice_delegations(owner_id,id,dot_id,call_id,parent_thread_id,worker_thread_id,utterance_id,source_message_id,source_text,request,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?)`,
        )
        .run(
          this.ownerId,
          input.id,
          input.dotId,
          input.callId,
          input.parentThreadId,
          input.workerThreadId,
          input.utteranceId,
          input.sourceMessageId,
          input.sourceText,
          input.request,
          now,
          now,
        );
      return { kind: 'created', job: this.required(input.id) };
    });
  }
  private duration(value: number) {
    if (!Number.isSafeInteger(value) || value < 25 || value > 60_000)
      throw new Error('Invalid voice delegation lease duration.');
  }
  private owned(raw: VoiceDelegationLease) {
    const lease = voiceDelegationLeaseSchema.parse(raw);
    const job = this.required(lease.id);
    if (
      job.status !== 'running' ||
      job.runId !== lease.runId ||
      job.leaseToken !== lease.token ||
      job.leaseGeneration !== lease.generation ||
      !job.leaseUntil ||
      job.leaseUntil <= Date.now()
    )
      throw new Error('Voice delegation lease lost or expired.');
    return job;
  }
  claim(
    id: string,
    runId: string,
    duration: number,
  ): VoiceDelegationLease | null {
    return this.transaction(() => {
      this.duration(duration);
      const job = this.required(id);
      if (job.status !== 'queued' && job.status !== 'approval') return null;
      if (
        !runId ||
        runId.length > 256 ||
        job.runId === runId ||
        this.db
          .prepare(
            'SELECT 1 FROM conversation_runs WHERE owner_id=? AND thread_id=? AND run_id=?',
          )
          .get(this.ownerId, job.workerThreadId, runId)
      )
        throw new Error('A delegation attempt requires a fresh run identity.');
      const lease = {
        id,
        runId,
        token: randomUUID(),
        generation: job.leaseGeneration + 1,
        expiresAt: Date.now() + duration,
      };
      this.db
        .prepare(
          "UPDATE voice_delegations SET status='running',run_id=?,lease_token=?,lease_generation=?,lease_until=?,updated_at=?,error=NULL,result=NULL,receipt_message_id=NULL,delivered_at=NULL WHERE owner_id=? AND id=?",
        )
        .run(
          runId,
          lease.token,
          lease.generation,
          lease.expiresAt,
          Date.now(),
          this.ownerId,
          id,
        );
      return lease;
    });
  }
  renew(lease: VoiceDelegationLease, duration: number): VoiceDelegationLease {
    return this.transaction(() => {
      this.duration(duration);
      this.owned(lease);
      const expiresAt = Date.now() + duration;
      this.db
        .prepare(
          'UPDATE voice_delegations SET lease_until=?,updated_at=? WHERE owner_id=? AND id=?',
        )
        .run(expiresAt, Date.now(), this.ownerId, lease.id);
      return { ...lease, expiresAt };
    });
  }
  private outcome(id: string, raw: VoiceDelegationOutcome) {
    const outcome = voiceDelegationOutcomeSchema.parse(raw);
    this.db
      .prepare(
        'UPDATE voice_delegations SET status=?,result=?,error=?,lease_token=NULL,lease_until=NULL,receipt_message_id=NULL,delivered_at=NULL,updated_at=? WHERE owner_id=? AND id=?',
      )
      .run(
        outcome.status,
        outcome.result ?? null,
        outcome.error ?? null,
        Date.now(),
        this.ownerId,
        id,
      );
    return this.required(id);
  }
  settle(
    lease: VoiceDelegationLease,
    outcome: VoiceDelegationOutcome,
  ): VoiceDelegation {
    return this.transaction(() => {
      this.owned(lease);
      return this.outcome(lease.id, outcome);
    });
  }
  cancel(id: string, idleOnly = false): VoiceDelegation {
    return this.transaction(() => {
      const job = this.required(id);
      if (idleOnly && !['queued', 'approval'].includes(job.status)) return job;
      return voiceDelegationActive(job.status)
        ? this.outcome(id, { status: 'cancelled' })
        : job;
    });
  }
  /** Retire only canonical, undecided folder waits whose approval deadlines passed. */
  expireApprovals(): VoiceDelegation[] {
    return this.transaction(() => this.expireFolderWaits());
  }
  private expireFolderWaits(dotId?: string): VoiceDelegation[] {
    const expired: VoiceDelegation[] = [];
    for (const job of this.list({ active: true })) {
      if (job.status !== 'approval' || (dotId && job.dotId !== dotId)) continue;
      const leased = this.db
        .prepare(
          'SELECT 1 FROM conversation_threads WHERE owner_id=? AND id=? AND lease_token IS NOT NULL AND lease_until>?',
        )
        .get(this.ownerId, job.workerThreadId, Date.now());
      if (leased) continue;
      const snapshot = this.conversations.readSnapshot(job.workerThreadId);
      if (
        snapshot.lastRun?.status !== 'finished' ||
        snapshot.lastRun.runId !== job.runId
      )
        continue;
      const answered = new Set(
        snapshot.messages.flatMap((m) =>
          m.role === 'tool' ? [m.toolCallId] : [],
        ),
      );
      const waiting = snapshot.messages
        .flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []))
        .filter((call) => !answered.has(call.id));
      const allExpired =
        waiting.length > 0 &&
        waiting.every((call) => {
          if (call.function.name !== folderApprovalTool.name) return false;
          try {
            const { requestId } = folderApprovalSchema.parse(
              JSON.parse(call.function.arguments),
            );
            const detail = this.workspace.folders.getRequest(
              job.workerThreadId,
              requestId,
            );
            return (
              detail.request.dotId === job.dotId &&
              detail.request.status === 'pending' &&
              !detail.decision &&
              detail.request.expiresAt <= Date.now()
            );
          } catch {
            return false;
          }
        });
      if (allExpired)
        expired.push(
          this.outcome(job.id, {
            status: 'interrupted',
            error: expiredFolderApprovalMessage,
          }),
        );
    }
    return expired;
  }
  /** Startup reconciliation only. Never claims a job or retries an interrupted action. */
  recover(input: VoiceDelegationRecovery = {}): VoiceDelegation[] {
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE voice_input_receipts SET status='interrupted',reply='Interrupted by restart; review chat before asking again.' WHERE ownerId=? AND deliveredAt IS NULL AND status='received'",
        )
        .run(this.ownerId);
      const supplied = new Map(
        (input.reconciled ?? []).map((item) => [item.id, item]),
      );
      const recovered: VoiceDelegation[] = [];
      for (const job of this.list({ active: true })) {
        if (job.status === 'approval') continue;
        const value = supplied.get(job.id);
        let outcome: VoiceDelegationOutcome = {
          status: 'interrupted',
          error:
            'Interrupted before delegation outcome was saved; review effects before retrying.',
        };
        if (value) {
          if (value.runId !== job.runId)
            throw new Error('Voice delegation recovery run mismatch.');
          const run = this.db
            .prepare(
              'SELECT status FROM conversation_runs WHERE owner_id=? AND thread_id=? AND run_id=?',
            )
            .get(this.ownerId, job.workerThreadId, value.runId);
          if (!run || run.status === 'running')
            throw new Error(
              'Voice delegation recovery requires a settled canonical run.',
            );
          outcome = voiceDelegationOutcomeSchema.parse({
            status: value.status,
            result: value.result,
            error: value.error,
          });
          if (
            (outcome.status === 'completed' || outcome.status === 'approval') &&
            run.status !== 'finished'
          )
            throw new Error(
              'Voice delegation recovery outcome does not match its run.',
            );
          supplied.delete(job.id);
        }
        recovered.push(this.outcome(job.id, outcome));
      }
      if (supplied.size)
        throw new Error(
          'Voice delegation recovery contains an unknown or settled job.',
        );
      return [...recovered, ...this.expireFolderWaits()];
    });
  }
  markDelivered(
    id: string,
    receiptMessageId: string,
    expected: VoiceDelegationReceiptState,
  ): VoiceDelegation {
    return this.transaction(() => {
      const job = this.required(id);
      if (job.status === 'queued' || job.status === 'running')
        throw new Error('Voice delegation has no settled receipt.');
      if (
        expected.status !== job.status ||
        expected.generation !== job.leaseGeneration
      )
        throw new Error('Voice delegation receipt state changed.');
      if (job.receiptMessageId) {
        if (job.receiptMessageId !== receiptMessageId)
          throw new Error('Voice delegation receipt mismatch.');
        return job;
      }
      if (
        this.message(job.parentThreadId, receiptMessageId)?.role !== 'assistant'
      )
        throw new Error(
          'Voice delegation receipt must be persisted in its parent conversation.',
        );
      this.db
        .prepare(
          'UPDATE voice_delegations SET receipt_message_id=?,delivered_at=?,updated_at=? WHERE owner_id=? AND id=?',
        )
        .run(receiptMessageId, Date.now(), Date.now(), this.ownerId, id);
      return this.required(id);
    });
  }
}
