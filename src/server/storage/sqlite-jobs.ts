import {
  assertPublicationAllowed,
  assertPublicationScope,
} from '../memory-publication-policy.js';
import { beginSQLiteTransaction } from './sqlite-transaction.js';
import type { ApplyReceipt } from '../../shared/memory.js';
import type {
  JobPublicationContext,
  PublishDreamInput,
} from '../memory-jobs.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  MemoryJob,
  MemoryJobInput,
  MemoryJobState,
} from '../memory-jobs.js';
/** Worker-owned job mutations participate in the coordinator's request transaction. */
export class SQLiteJobs {
  constructor(
    private db: DatabaseSync,
    readonly ownerId: string,
    readonly clock = Date.now,
    private publicationContext?: JobPublicationContext,
  ) {}
  private row(row: Record<string, unknown>): MemoryJob {
    return {
      id: String(row.id),
      kind: row.kind as MemoryJob['kind'],
      dotId: String(row.dot_id),
      threadId: row.thread_id as string | null,
      sourceIds: JSON.parse(String(row.source_ids)),
      origin: row.origin as MemoryJob['origin'],
      state: row.state as MemoryJobState,
      leaseToken: row.lease_token as string | null,
      leaseUntil: row.lease_until == null ? null : Number(row.lease_until),
      attempts: Number(row.attempts),
      modelCalls: Number(row.model_calls),
      elapsedMs: Number(row.elapsed_ms),
      dueAt: Number(row.due_at),
      createdAt: Number(row.created_at),
      error: row.error as string | null,
      logicalKey: String(row.logical_key),
      publicationPolicy:
        row.publication_policy as MemoryJob['publicationPolicy'],
      callLimit: Number(row.call_limit),
      timeoutMs: Number(row.time_limit),
      retryLimit: Number(row.retry_limit),
      idleMs: Number(row.idle_ms),
    };
  }
  enqueue(input: MemoryJobInput): MemoryJob {
    const row = this.db
      .prepare(
        `INSERT INTO memory_jobs(owner_id,id,kind,dot_id,thread_id,source_ids,origin,logical_key,due_at,created_at,publication_policy,call_limit,time_limit,retry_limit,idle_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,logical_key) WHERE state IN ('queued','running') DO UPDATE SET logical_key=excluded.logical_key RETURNING *`,
      )
      .get(
        this.ownerId,
        randomUUID(),
        input.kind,
        input.dotId,
        input.threadId ?? null,
        JSON.stringify(input.sourceIds),
        input.origin,
        input.logicalKey,
        input.dueAt ?? this.clock(),
        this.clock(),
        input.publicationPolicy ?? 'hybrid',
        input.callLimit ?? 3,
        input.timeoutMs ?? 300000,
        input.retryLimit ?? 2,
        input.idleMs ?? 0,
      )!;
    return this.row(row);
  }
  get(id: string): MemoryJob | undefined {
    const row = this.db
      .prepare('SELECT * FROM memory_jobs WHERE owner_id=? AND id=?')
      .get(this.ownerId, id);
    return row ? this.row(row) : undefined;
  }
  list(dotId: string): MemoryJob[] {
    return this.db
      .prepare(
        'SELECT * FROM memory_jobs WHERE owner_id=? AND dot_id=? ORDER BY created_at DESC LIMIT 100',
      )
      .all(this.ownerId, dotId)
      .map((row) => this.row(row));
  }
  find(key: string): MemoryJob | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM memory_jobs WHERE owner_id=? AND logical_key=? AND state IN ('queued','running','succeeded') ORDER BY created_at DESC LIMIT 1",
      )
      .get(this.ownerId, key);
    return row ? this.row(row) : undefined;
  }
  lastAutomatic(dotId: string): number | undefined {
    const row = this.db
      .prepare(
        "SELECT max(created_at) AS latest FROM memory_jobs WHERE owner_id=? AND dot_id=? AND kind='dream' AND origin='automatic' AND admitted_day IS NOT NULL",
      )
      .get(this.ownerId, dotId);
    return row?.latest == null ? undefined : Number(row.latest);
  }
  claim(now = this.clock(), idleSince = 0): MemoryJob | undefined {
    this.db
      .prepare(
        `UPDATE memory_jobs SET state='failed',error='Maintenance budget exhausted',lease_token=NULL,lease_until=NULL,
      elapsed_ms=elapsed_ms+CASE WHEN call_started_at IS NULL THEN 0 ELSE max(0,?-call_started_at) END,call_started_at=NULL
      WHERE owner_id=? AND (state='queued' OR (state='running' AND lease_until<=?))
      AND (model_calls>=call_limit OR elapsed_ms+CASE WHEN call_started_at IS NULL THEN 0 ELSE max(0,?-call_started_at) END>=time_limit OR attempts>=retry_limit+1)`,
      )
      .run(now, this.ownerId, now, now);
    const candidate = this.db
      .prepare(
        `SELECT j.id FROM memory_jobs j WHERE j.owner_id=? AND j.due_at<=? AND (j.state='queued' OR (j.state='running' AND j.lease_until<=?))
      AND (j.origin='manual' OR j.kind='compact' OR j.admitted_day IS NOT NULL) AND ?-?>=j.idle_ms
      AND NOT EXISTS(SELECT 1 FROM memory_jobs active WHERE active.owner_id=j.owner_id AND active.dot_id=j.dot_id AND active.kind=j.kind AND active.state='running' AND active.id<>j.id)
      ORDER BY CASE WHEN j.state='running' THEN 0 WHEN j.origin='manual' THEN 1 WHEN j.kind='compact' THEN 2 ELSE 3 END,j.due_at,j.id LIMIT 1`,
      )
      .get(this.ownerId, now, now, now, idleSince);
    if (!candidate) return;
    return this.row(
      this.db
        .prepare(
          `UPDATE memory_jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1,
      elapsed_ms=elapsed_ms+CASE WHEN call_started_at IS NULL THEN 0 ELSE max(0,?-call_started_at) END,call_started_at=NULL WHERE owner_id=? AND id=? RETURNING *`,
        )
        .get(randomUUID(), now + 60000, now, this.ownerId, candidate.id)!,
    );
  }
  admitAutomatic(id: string, day: string, limit: number): boolean {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Invalid automatic admission limit');
    const job = this.db
      .prepare(
        'SELECT dot_id,admitted_day FROM memory_jobs WHERE owner_id=? AND id=?',
      )
      .get(this.ownerId, id);
    if (!job) throw new Error('Maintenance job not found');
    if (job.admitted_day) return true;
    const admitted = this.db
      .prepare(
        'INSERT INTO memory_daily_admissions VALUES(?,?,?,1) ON CONFLICT(owner_id,dot_id,day_key) DO UPDATE SET count=memory_daily_admissions.count+1 WHERE memory_daily_admissions.count<? RETURNING count',
      )
      .get(this.ownerId, job.dot_id, day, limit);
    if (admitted)
      this.db
        .prepare(
          'UPDATE memory_jobs SET admitted_day=? WHERE owner_id=? AND id=?',
        )
        .run(day, this.ownerId, id);
    else
      this.db
        .prepare(
          "UPDATE memory_jobs SET state='cancelled',error='Automatic daily limit reached' WHERE owner_id=? AND id=? AND state='queued'",
        )
        .run(this.ownerId, id);
    return !!admitted;
  }
  cancelQueued(
    dotId: string,
    kind: 'dream' | 'compact',
    automaticOnly = false,
  ) {
    this.db
      .prepare(
        "UPDATE memory_jobs SET state='cancelled',error='Maintenance disabled' WHERE owner_id=? AND dot_id=? AND kind=? AND state IN ('queued','running') AND (?=0 OR origin='automatic')",
      )
      .run(this.ownerId, dotId, kind, +automaticOnly);
  }
  defer(id: string, lease: string) {
    this.db
      .prepare(
        "UPDATE memory_jobs SET state='queued',lease_token=NULL,lease_until=NULL,attempts=max(0,attempts-1),due_at=?,error='Waiting for approval' WHERE owner_id=? AND id=? AND lease_token=? AND state='running' AND lease_until>?",
      )
      .run(this.clock() + 5000, this.ownerId, id, lease, this.clock());
  }
  renew(id: string, lease: string) {
    const now = this.clock();
    const result = this.db
      .prepare(
        "UPDATE memory_jobs SET lease_until=? WHERE owner_id=? AND id=? AND lease_token=? AND state='running' AND lease_until>?",
      )
      .run(now + 60000, this.ownerId, id, lease, now);
    if (result.changes !== 1) throw new Error('Maintenance lease lost');
  }
  recordUsage(
    id: string,
    lease: string,
    usage: { modelCalls?: number; elapsedMs?: number },
  ) {
    const calls = usage.modelCalls ?? 0,
      elapsed = usage.elapsedMs ?? 0,
      now = this.clock();
    if (
      !Number.isSafeInteger(calls) ||
      !Number.isSafeInteger(elapsed) ||
      calls < 0 ||
      elapsed < 0
    )
      throw new Error('Invalid maintenance usage');
    const result = this.db
      .prepare(
        `UPDATE memory_jobs SET model_calls=model_calls+?,elapsed_ms=elapsed_ms+?,call_started_at=CASE WHEN ?>0 AND ?=0 THEN ? ELSE NULL END
      WHERE owner_id=? AND id=? AND lease_token=? AND state='running' AND lease_until>? AND model_calls+?<=call_limit AND (?=0 OR elapsed_ms<time_limit)`,
      )
      .run(
        calls,
        elapsed,
        calls,
        elapsed,
        now,
        this.ownerId,
        id,
        lease,
        now,
        calls,
        calls,
      );
    if (result.changes !== 1)
      throw new Error('Maintenance lease lost or budget exhausted');
  }
  private acknowledge(job: MemoryJob) {
    for (const id of job.sourceIds)
      this.db
        .prepare('INSERT OR IGNORE INTO memory_processed_sources VALUES(?,?,?)')
        .run(this.ownerId, id, job.id);
    this.db
      .prepare(
        "UPDATE memory_jobs SET state='succeeded',error=NULL,lease_token=NULL,lease_until=NULL,call_started_at=NULL WHERE owner_id=? AND id=?",
      )
      .run(this.ownerId, job.id);
    this.db
      .prepare(
        `UPDATE memory_evidence AS e SET processed_job_id=? WHERE e.owner_id=? AND e.processed_job_id IS NULL
      AND EXISTS(SELECT 1 FROM memory_index_runs i WHERE i.owner_id=e.owner_id AND i.thread_id=e.thread_id AND i.run_id=e.run_id)
      AND NOT EXISTS(SELECT 1 FROM memory_episode_chunks c LEFT JOIN memory_processed_sources p ON p.owner_id=c.owner_id AND p.source_id=c.source_id WHERE c.owner_id=e.owner_id AND c.thread_id=e.thread_id AND c.run_id=e.run_id AND p.source_id IS NULL)`,
      )
      .run(job.id, this.ownerId);
  }
  reconcileReceipt(id: string): boolean {
    const job = this.get(id);
    if (!job) throw new Error('Maintenance job not found');
    if (
      !this.publicationContext?.publication.recall.memory.history.receipt(id) ||
      (job.state === 'running' && (job.leaseUntil ?? 0) > this.clock())
    )
      return false;
    this.acknowledge(job);
    return true;
  }
  async publishDream(input: PublishDreamInput): Promise<ApplyReceipt> {
    return this.publishDreamWithFence(input, () => {});
  }
  /** Worker-local fence: never accepted from the serialized repository protocol. */
  async publishDreamWithFence(
    input: PublishDreamInput,
    checkCancellation: () => void,
  ): Promise<ApplyReceipt> {
    checkCancellation();
    const context = this.publicationContext;
    if (!context) throw new Error('Dream publication is not configured');
    const job = this.get(input.jobId);
    if (!job) throw new Error('Maintenance job not found');
    assertPublicationScope(job, input);
    const previous = context.publication.recall.memory.history.receipt(job.id);
    if (previous && job.state === 'succeeded') return previous;
    const validate = () => {
      checkCancellation();
      const current = this.get(job.id);
      if (
        !current ||
        current.state !== 'running' ||
        current.leaseToken !== input.lease ||
        current.attempts !== input.generation ||
        (current.leaseUntil ?? 0) <= this.clock() ||
        current.elapsedMs > (current.timeoutMs ?? 300000)
      )
        throw new Error('Maintenance lease or generation lost');
      assertPublicationAllowed(current, context, this.clock());
      return current;
    };
    validate();
    const commit = <T>(work: () => T): T => {
      const transaction = beginSQLiteTransaction(this.db);
      try {
        const current = validate();
        const receipt = work();
        validate();
        this.acknowledge(current);
        checkCancellation();
        if ((current.leaseUntil ?? 0) <= this.clock())
          throw new Error('Maintenance lease expired during publication');
        transaction.commit();
        return receipt;
      } catch (error) {
        transaction.rollback();
        throw error;
      }
    };
    if (previous) return commit(() => previous);
    return context.publication.apply(
      job.id,
      input.proposal,
      input.policy,
      input.dotId,
      async (work) => commit(work),
    );
  }
  settle(
    id: string,
    lease: string,
    outcome: {
      state: Exclude<MemoryJobState, 'running'>;
      dueAt?: number;
      error?: string;
    },
  ) {
    const result = this.db
      .prepare(
        "UPDATE memory_jobs SET state=?,due_at=?,error=?,lease_token=NULL,lease_until=NULL,call_started_at=NULL WHERE owner_id=? AND id=? AND lease_token=? AND state='running' AND lease_until>?",
      )
      .run(
        outcome.state,
        outcome.dueAt ?? this.clock(),
        outcome.error?.slice(0, 1000) ?? null,
        this.ownerId,
        id,
        lease,
        this.clock(),
      );
    if (result.changes !== 1) throw new Error('Maintenance lease lost');
  }
}
