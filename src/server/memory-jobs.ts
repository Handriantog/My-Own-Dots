import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
export type MemoryJobState =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface MemoryJob {
  id: string;
  kind: 'compact' | 'dream';
  dotId: string;
  threadId: string | null;
  sourceIds: string[];
  origin: 'manual' | 'automatic';
  state: MemoryJobState;
  leaseToken: string | null;
  leaseUntil: number | null;
  attempts: number;
  modelCalls: number;
  elapsedMs: number;
  dueAt: number;
  createdAt: number;
  error: string | null;
  logicalKey: string;
}
export interface MemoryJobInput {
  kind: 'compact' | 'dream';
  dotId: string;
  threadId?: string;
  sourceIds: string[];
  origin: 'manual' | 'automatic';
  logicalKey: string;
  dueAt?: number;
}
type JobRow = Record<string, unknown>;
export class MemoryJobs {
  constructor(
    readonly pg: Pool,
    readonly ownerId: string,
    readonly clock: () => number = Date.now,
  ) {}
  private row(row: JobRow): MemoryJob {
    return {
      id: String(row.id),
      kind: row.kind as MemoryJob['kind'],
      dotId: String(row.dot_id),
      threadId: row.thread_id as string | null,
      sourceIds: row.source_ids as string[],
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
    };
  }
  async enqueue(input: MemoryJobInput): Promise<MemoryJob> {
    const result = await this.pg.query(
      `INSERT INTO memory_jobs(owner_id,id,kind,dot_id,thread_id,source_ids,origin,logical_key,due_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(owner_id,logical_key) WHERE state IN ('queued','running') DO UPDATE SET logical_key=excluded.logical_key RETURNING *`,
      [
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
      ],
    );
    return this.row(result.rows[0]);
  }
  async get(id: string): Promise<MemoryJob | undefined> {
    const result = await this.pg.query(
      'SELECT * FROM memory_jobs WHERE owner_id=$1 AND id=$2',
      [this.ownerId, id],
    );
    return result.rows[0] ? this.row(result.rows[0]) : undefined;
  }
  async list(dotId: string): Promise<MemoryJob[]> {
    const result = await this.pg.query(
      'SELECT * FROM memory_jobs WHERE owner_id=$1 AND dot_id=$2 ORDER BY created_at DESC LIMIT 100',
      [this.ownerId, dotId],
    );
    return result.rows.map((row) => this.row(row));
  }
  async claim(now = this.clock()): Promise<MemoryJob | undefined> {
    await this.pg.query(
      `UPDATE memory_jobs SET state='failed',error='Maintenance budget exhausted',lease_token=NULL,lease_until=NULL,elapsed_ms=elapsed_ms+CASE WHEN call_started_at IS NULL THEN 0 ELSE greatest(0,$2-call_started_at) END,call_started_at=NULL
      WHERE owner_id=$1 AND (state='queued' OR (state='running' AND lease_until<=$2))
      AND (model_calls>=3 OR elapsed_ms+CASE WHEN call_started_at IS NULL THEN 0 ELSE greatest(0,$2-call_started_at) END>=300000 OR attempts>=3)`,
      [this.ownerId, now],
    );
    const result = await this.pg.query(
      `WITH candidate AS (
      SELECT j.id FROM memory_jobs j WHERE j.owner_id=$1 AND j.due_at<=$2 AND (j.state='queued' OR (j.state='running' AND j.lease_until<=$2))
      AND NOT EXISTS(SELECT 1 FROM memory_jobs active WHERE active.owner_id=j.owner_id AND active.dot_id=j.dot_id AND active.kind=j.kind AND active.state='running' AND active.id<>j.id)
      ORDER BY CASE WHEN j.state='running' THEN 0 WHEN j.origin='manual' THEN 1 WHEN j.kind='compact' THEN 2 ELSE 3 END,j.due_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE memory_jobs j SET state='running',lease_token=$3,lease_until=$2+60000,attempts=attempts+1,
      elapsed_ms=elapsed_ms+CASE WHEN call_started_at IS NULL THEN 0 ELSE greatest(0,$2-call_started_at) END,call_started_at=NULL
      FROM candidate WHERE j.owner_id=$1 AND j.id=candidate.id RETURNING j.*`,
      [this.ownerId, now, randomUUID()],
    );
    return result.rows[0] ? this.row(result.rows[0]) : undefined;
  }
  async renew(id: string, lease: string): Promise<void> {
    const result = await this.pg.query(
      "UPDATE memory_jobs SET lease_until=$4+60000 WHERE owner_id=$1 AND id=$2 AND lease_token=$3 AND state='running' AND lease_until>$4",
      [this.ownerId, id, lease, this.clock()],
    );
    if (result.rowCount !== 1) throw new Error('Maintenance lease lost');
  }
  async recordUsage(
    id: string,
    lease: string,
    usage: { modelCalls?: number; elapsedMs?: number },
  ): Promise<void> {
    const calls = usage.modelCalls ?? 0,
      elapsed = usage.elapsedMs ?? 0;
    if (
      !Number.isSafeInteger(calls) ||
      !Number.isSafeInteger(elapsed) ||
      calls < 0 ||
      elapsed < 0
    )
      throw new Error('Invalid maintenance usage');
    const result = await this.pg.query(
      `UPDATE memory_jobs SET model_calls=model_calls+$4,elapsed_ms=elapsed_ms+$5,
      call_started_at=CASE WHEN $4>0 AND $5=0 THEN $6 ELSE NULL END
      WHERE owner_id=$1 AND id=$2 AND lease_token=$3 AND state='running' AND lease_until>$6 AND model_calls+$4<=3 AND ($4=0 OR elapsed_ms<300000)`,
      [this.ownerId, id, lease, calls, elapsed, this.clock()],
    );
    if (result.rowCount !== 1)
      throw new Error('Maintenance lease lost or budget exhausted');
  }
  async settle(
    id: string,
    lease: string,
    outcome: {
      state: Exclude<MemoryJobState, 'running'>;
      dueAt?: number;
      error?: string;
    },
  ): Promise<void> {
    const result = await this.pg.query(
      `UPDATE memory_jobs SET state=$4,due_at=$5,error=$6,lease_token=NULL,lease_until=NULL,call_started_at=NULL
      WHERE owner_id=$1 AND id=$2 AND lease_token=$3 AND state='running' AND lease_until>$7`,
      [
        this.ownerId,
        id,
        lease,
        outcome.state,
        outcome.dueAt ?? this.clock(),
        outcome.error?.slice(0, 1000) ?? null,
        this.clock(),
      ],
    );
    if (result.rowCount !== 1) throw new Error('Maintenance lease lost');
  }
}
