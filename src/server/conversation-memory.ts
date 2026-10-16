import type { ContextCheckpoint } from './context-compaction.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Message } from '@ag-ui/core';
import {
  evidenceGuardSchema,
  type EvidenceGuard,
  type SourceRef,
} from '../shared/memory.js';
import type { WorkspaceStore } from './workspace.js';
import {
  initializeConversationMemorySchema,
  type MemoryDatabase,
} from './conversation-memory-schema.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const evidenceHash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export function unionEvidence(
  a: EvidenceGuard | null,
  b: EvidenceGuard,
): EvidenceGuard {
  const guard = evidenceGuardSchema.parse(b);
  if (a && a.originDotId !== guard.originDotId)
    throw new Error('Evidence Dot scope mismatch');
  return evidenceGuardSchema.parse({
    originDotId: guard.originDotId,
    spaceIds: [...new Set([...(a?.spaceIds ?? []), ...guard.spaceIds])].sort(),
    pageIds: [...new Set([...(a?.pageIds ?? []), ...guard.pageIds])].sort(),
  });
}
export interface IndexCoverage {
  indexedRuns: number;
  eligibleRuns: number;
  complete: boolean;
}
export interface EpisodeQuery {
  allowedThreadIds: string[];
  query: string;
  cursor?: string;
  limit?: number;
  after?: number;
  before?: number;
}
export interface SourceRecord {
  id: string;
  ownerId: string;
  source: SourceRef;
  guard: EvidenceGuard;
  text: string;
  role: string;
  createdAt: number;
  toolName?: string;
  workflowComplete?: boolean;
}
export interface EpisodePage {
  matches: SourceRecord[];
  nextCursor?: string;
  coverage: IndexCoverage;
}
interface SourceRow {
  source_id: string;
  source: SourceRef;
  text: string;
  role: string;
  created_at: Date;
  tool_name?: string;
  workflow_complete?: boolean;
}
/** Bound threads are the authority. PG rows alone never establish a grant. */
export class ConversationMemory {
  constructor(
    readonly pg: MemoryDatabase,
    readonly ownerId: string,
    readonly workspace: WorkspaceStore,
  ) {}
  initialize() {
    return initializeConversationMemorySchema(this.pg);
  }
  private threads(dotId?: string) {
    return this.workspace
      .conversations()
      .filter((t) => !dotId || t.dotId === dotId)
      .map((t) => t.id);
  }
  sourcesExist(guard: EvidenceGuard): boolean {
    const dot = this.workspace.dot(guard.originDotId);
    if (!dot) return false;
    if (guard.spaceIds.some((id) => !this.workspace.canAccessSpace(dot.id, id)))
      return false;
    return guard.pageIds.every((id) =>
      guard.spaceIds.some((spaceId) =>
        this.workspace.pages.exists(spaceId, id),
      ),
    );
  }
  async indexRun(runId: string): Promise<void> {
    const rows = await this.pg.query<{
      thread_id: string;
      input: { messages: Message[] };
      evidence_messages: Message[];
      evidence_guard: EvidenceGuard;
      created_at: Date;
    }>(
      `SELECT r.thread_id,r.input,r.evidence_messages,r.evidence_guard,r.created_at FROM local_ai_runs r
       WHERE r.owner_id=$1 AND r.run_id=$2 AND r.thread_id=ANY($3::text[]) AND r.status<>'running'
       AND r.evidence_guard IS NOT NULL AND r.provenance_complete=true
       AND NOT EXISTS(SELECT 1 FROM memory_index_runs i WHERE i.owner_id=r.owner_id AND i.thread_id=r.thread_id AND i.run_id=r.run_id)`,
      [this.ownerId, runId, this.threads()],
    );
    for (const run of rows.rows) {
      const binding = this.workspace.requireThread(run.thread_id);
      if (
        binding.dotId !== run.evidence_guard.originDotId ||
        !this.sourcesExist(run.evidence_guard)
      )
        continue;
      const chunks: Record<string, unknown>[] = [];
      for (const message of run.evidence_messages) {
        if (message.role === 'system' || message.role === 'developer') continue;
        const content =
          typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content ?? '');
        const text =
          content ||
          (message.role === 'assistant' && message.toolCalls?.length
            ? JSON.stringify(message.toolCalls)
            : '');
        for (let start = 0; start < text.length; start += 4000) {
          const source: SourceRef = {
            threadId: run.thread_id,
            runId,
            messageIds: [message.id],
            contentHash: evidenceHash(message),
            guard: run.evidence_guard,
            start,
            end: Math.min(text.length, start + 4000),
          };
          chunks.push({
            id: evidenceHash([
              this.ownerId,
              run.thread_id,
              runId,
              message.id,
              start,
            ]),
            messageId: message.id,
            hash: source.contentHash,
            start,
            text: text.slice(start, start + 4000),
            toolName:
              message.role === 'tool'
                ? [...run.input.messages, ...run.evidence_messages]
                    .flatMap((m) =>
                      m.role === 'assistant' ? (m.toolCalls ?? []) : [],
                    )
                    .find((call) => call.id === message.toolCallId)?.function
                    .name
                : null,
            role: message.role,
            source,
          });
        }
      }
      // One statement atomically inserts all chunks and the indexing receipt.
      await this.pg.query(
        `WITH inserted AS (
        INSERT INTO memory_episode_chunks(owner_id,source_id,thread_id,run_id,message_id,content_hash,start_offset,text,role,source,created_at,tool_name)
        SELECT $1,c->>'id',$2,$3,c->>'messageId',c->>'hash',(c->>'start')::integer,c->>'text',c->>'role',c->'source',$5::timestamptz,c->>'toolName'
        FROM jsonb_array_elements($4::jsonb) c ON CONFLICT DO NOTHING
      ) , receipt AS (INSERT INTO memory_index_runs VALUES ($1,$2,$3,1) ON CONFLICT DO NOTHING RETURNING 1)
      INSERT INTO memory_index_meta VALUES ($1,1) ON CONFLICT(owner_id) DO UPDATE SET revision=memory_index_meta.revision+1`,
        [
          this.ownerId,
          run.thread_id,
          runId,
          JSON.stringify(chunks),
          run.created_at,
        ],
      );
    }
  }
  async threadMessages(threadId: string): Promise<Message[]> {
    this.workspace.requireThread(threadId);
    const result = await this.pg.query<{ messages: Message[] }>(
      'SELECT messages FROM local_ai_threads WHERE owner_id=$1 AND id=$2',
      [this.ownerId, threadId],
    );
    if (!result.rows[0]) throw new Error('Conversation not found');
    return result.rows[0].messages;
  }
  async latestCheckpoint(
    threadId: string,
  ): Promise<ContextCheckpoint | undefined> {
    this.workspace.requireThread(threadId);
    const result = await this.pg.query<{ value: ContextCheckpoint }>(
      'SELECT value FROM memory_checkpoints WHERE owner_id=$1 AND thread_id=$2 ORDER BY covered_count DESC,created_at DESC LIMIT 1',
      [this.ownerId, threadId],
    );
    const checkpoint = result.rows[0]?.value;
    if (!checkpoint) return;
    const prefix = (await this.threadMessages(threadId)).slice(
      0,
      checkpoint.sourceMessageIds.length,
    );
    return evidenceHash(prefix) === checkpoint.sourceHash
      ? checkpoint
      : undefined;
  }
  async saveCheckpoint(
    checkpoint: ContextCheckpoint,
    expectedPrefixHash: string,
  ): Promise<boolean> {
    const messages = await this.threadMessages(checkpoint.threadId);
    const prefix = messages.slice(0, checkpoint.sourceMessageIds.length);
    if (
      checkpoint.sourceHash !== expectedPrefixHash ||
      evidenceHash(prefix) !== expectedPrefixHash ||
      !isDeepStrictEqual(
        prefix.map((m) => m.id),
        checkpoint.sourceMessageIds,
      )
    )
      return false;
    const result = await this.pg.query(
      `INSERT INTO memory_checkpoints(owner_id,thread_id,id,covered_count,value)
      SELECT $1,$2,$3,$4::integer,$5::jsonb FROM local_ai_threads t WHERE t.owner_id=$1 AND t.id=$2
      AND (SELECT coalesce(jsonb_agg(m ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements(t.messages) WITH ORDINALITY AS x(m,ordinal) WHERE ordinal<=$4::integer)=$6::jsonb
      ON CONFLICT(owner_id,id) DO UPDATE SET value=excluded.value RETURNING id`,
      [
        this.ownerId,
        checkpoint.threadId,
        checkpoint.id,
        checkpoint.sourceMessageIds.length,
        JSON.stringify(checkpoint),
        JSON.stringify(prefix),
      ],
    );
    return result.rowCount === 1;
  }
  async generation(): Promise<number> {
    const result = await this.pg.query(
      'SELECT revision FROM memory_index_meta WHERE owner_id=$1',
      [this.ownerId],
    );
    return Number(result.rows[0]?.revision ?? 0);
  }
  async coverage(dotId?: string): Promise<IndexCoverage> {
    const result = await this.pg.query<{ eligible: string; indexed: string }>(
      `SELECT count(*) AS eligible,count(i.run_id) AS indexed FROM local_ai_runs r
      LEFT JOIN memory_index_runs i USING(owner_id,thread_id,run_id) WHERE r.owner_id=$1 AND r.thread_id=ANY($2::text[]) AND r.status<>'running'`,
      [this.ownerId, this.threads(dotId)],
    );
    const indexedRuns = Number(result.rows[0].indexed),
      eligibleRuns = Number(result.rows[0].eligible);
    return {
      indexedRuns,
      eligibleRuns,
      complete: indexedRuns === eligibleRuns,
    };
  }
  private record(row: SourceRow): SourceRecord {
    return {
      id: row.source_id,
      ownerId: this.ownerId,
      source: row.source,
      guard: row.source.guard,
      text: row.text,
      role: row.role,
      createdAt: row.created_at.getTime(),
      toolName: row.tool_name ?? undefined,
      workflowComplete: row.workflow_complete === true,
    };
  }
  async searchEpisodes(query: EpisodeQuery): Promise<EpisodePage> {
    const allowed = new Set(this.threads());
    const threads = query.allowedThreadIds.filter((id) => allowed.has(id));
    const limit = Math.max(1, Math.min(10, query.limit ?? 10));
    const offset = Number(query.cursor ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || query.query.length > 500)
      throw new Error('Invalid episode query');
    const coverage = await this.coverage();
    if (!/[\p{L}\p{N}]/u.test(query.query) || !threads.length)
      return { matches: [], coverage };
    const result = await this.pg.query<SourceRow>(
      `SELECT source_id,source,text,role,created_at,tool_name,(SELECT e.workflow_complete FROM memory_evidence e WHERE e.owner_id=memory_episode_chunks.owner_id AND e.thread_id=memory_episode_chunks.thread_id AND e.run_id=memory_episode_chunks.run_id) AS workflow_complete FROM memory_episode_chunks
      WHERE owner_id=$1 AND thread_id=ANY($2::text[]) AND search @@ websearch_to_tsquery('simple',$3)
      AND ($4::timestamptz IS NULL OR created_at >= $4) AND ($5::timestamptz IS NULL OR created_at <= $5)
      ORDER BY created_at DESC,source_id LIMIT $6 OFFSET $7`,
      [
        this.ownerId,
        threads,
        query.query,
        query.after == null ? null : new Date(query.after),
        query.before == null ? null : new Date(query.before),
        limit + 1,
        offset,
      ],
    );
    const visible = result.rows
      .slice(0, limit)
      .filter((row) => this.sourcesExist(row.source.guard));
    return {
      matches: visible.map((row) => this.record(row)),
      coverage,
      ...(result.rows.length > limit
        ? { nextCursor: String(offset + limit) }
        : {}),
    };
  }
  async sourceById(id: string): Promise<SourceRecord | undefined> {
    const result = await this.pg.query<SourceRow>(
      'SELECT source_id,source,text,role,created_at,tool_name,(SELECT e.workflow_complete FROM memory_evidence e WHERE e.owner_id=memory_episode_chunks.owner_id AND e.thread_id=memory_episode_chunks.thread_id AND e.run_id=memory_episode_chunks.run_id) AS workflow_complete FROM memory_episode_chunks WHERE owner_id=$1 AND source_id=$2 AND thread_id=ANY($3::text[])',
      [this.ownerId, id, this.threads()],
    );
    const row = result.rows[0];
    return row && this.sourcesExist(row.source.guard)
      ? this.record(row)
      : undefined;
  }
  async readSource(ref: SourceRef): Promise<SourceRecord | undefined> {
    const id = evidenceHash([
      this.ownerId,
      ref.threadId,
      ref.runId,
      ref.messageIds[0],
      ref.start ?? 0,
    ]);
    const record = await this.sourceById(id);
    if (record)
      return isDeepStrictEqual(record.source, ref) ? record : undefined;
    if (!this.threads().includes(ref.threadId) || !this.sourcesExist(ref.guard))
      return;
    const result = await this.pg.query<{
      evidence_messages: Message[];
      evidence_guard: EvidenceGuard;
      created_at: Date;
    }>(
      `SELECT evidence_messages,evidence_guard,created_at FROM local_ai_runs WHERE owner_id=$1 AND thread_id=$2 AND run_id=$3 AND provenance_complete=true AND status<>'running'`,
      [this.ownerId, ref.threadId, ref.runId],
    );
    const run = result.rows[0];
    if (
      !run ||
      !isDeepStrictEqual(run.evidence_guard, ref.guard) ||
      ref.messageIds.length !== 1
    )
      return;
    const message = run.evidence_messages.find(
      (m) => m.id === ref.messageIds[0],
    );
    if (!message || evidenceHash(message) !== ref.contentHash) return;
    const text =
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? '');
    const start = ref.start ?? 0,
      end = ref.end ?? text.length;
    if (start < 0 || end > text.length || start >= end) return;
    return {
      id,
      ownerId: this.ownerId,
      source: ref,
      guard: ref.guard,
      text: text.slice(start, end),
      role: message.role,
      createdAt: run.created_at.getTime(),
    };
  }
}
