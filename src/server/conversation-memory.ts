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
    ...Object.fromEntries(
      ['memoryItemIds', 'memorySourceKeys', 'folderGrantIds'].flatMap((key) => {
        const k = key as
          'memoryItemIds' | 'memorySourceKeys' | 'folderGrantIds';
        const values = [
          ...new Set([...(a?.[k] ?? []), ...(guard[k] ?? [])]),
        ].sort();
        return values.length ? [[key, values]] : [];
      }),
    ),
  });
}
export function guardDependenciesAllowed(
  workspace: WorkspaceStore,
  guard: EvidenceGuard,
  dotId: string,
  memoryEnabled: boolean,
  seen = new Set<string>(),
): boolean {
  if (guard.folderGrantIds?.length) {
    const grants = new Set(
      workspace.folders.list(dotId).map((grant) => grant.id),
    );
    if (guard.folderGrantIds.some((id) => !grants.has(id))) return false;
  }
  if (
    (guard.memoryItemIds?.length || guard.memorySourceKeys?.length) &&
    (!memoryEnabled || !workspace.dot(dotId)?.memoryAllowed)
  )
    return false;
  if (
    guard.memorySourceKeys?.some((key) =>
      workspace.memory.history.keySuppressed(key),
    )
  )
    return false;
  return (guard.memoryItemIds ?? []).every((id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    const item = workspace.memory.get(id);
    if (!item || !['active', 'superseded'].includes(item.status)) return false;
    if (item.scope.kind === 'dot' && item.scope.id !== dotId) return false;
    if (
      item.scope.kind === 'space' &&
      !workspace.canAccessSpace(dotId, item.scope.id)
    )
      return false;
    return item.sources.every(
      (ref) =>
        !workspace.memory.sourceSuppressed(ref) &&
        ref.guard.spaceIds.every((space) =>
          workspace.canAccessSpace(dotId, space),
        ) &&
        ref.guard.pageIds.every((page) =>
          ref.guard.spaceIds.some((space) =>
            workspace.pages.exists(space, page),
          ),
        ) &&
        guardDependenciesAllowed(
          workspace,
          ref.guard,
          dotId,
          memoryEnabled,
          seen,
        ),
    );
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
export interface CompactSnapshot {
  lastRunId: string | null;
  updatedAt: number;
  lastStatus: string | null;
  checkpointId: string | null;
}
export interface PendingSources {
  dotId: string;
  since: number;
  threadIds: string[];
  cursor: string;
}
export type EvidenceResult<T> = T | Promise<T>;
export interface ConversationEvidenceRepository {
  blockedThreads(threadIds: string[]): EvidenceResult<string[]>;
  sourceThreads(sourceIds: string[]): EvidenceResult<string[]>;
  pendingRuns(threadIds: string[], cursor: string): EvidenceResult<string[]>;
  pendingSources(input: PendingSources): EvidenceResult<string[]>;
  compactSnapshot(
    threadId: string,
  ): EvidenceResult<CompactSnapshot | undefined>;
  completedExchanges(threadId: string, since: number): EvidenceResult<number>;
  modelMessages(
    threadId: string,
    messages: Message[],
  ): EvidenceResult<Message[]>;
  indexRun(runId: string): Promise<void>;
  threadMessages(threadId: string): EvidenceResult<Message[]>;
  latestCheckpoint(
    threadId: string,
    messages?: Message[],
  ): EvidenceResult<ContextCheckpoint | undefined>;
  saveCheckpoint(
    checkpoint: ContextCheckpoint,
    expectedPrefixHash: string,
    lease?: { id: string; token: string; now: number },
  ): EvidenceResult<boolean>;
  generation(): EvidenceResult<number>;
  coverage(dotId?: string): EvidenceResult<IndexCoverage>;
  searchEpisodes(query: EpisodeQuery): EvidenceResult<EpisodePage>;
  sourceById(id: string): EvidenceResult<SourceRecord | undefined>;
  readSource(ref: SourceRef): EvidenceResult<SourceRecord | undefined>;
}
/** Bound threads are the authority. PG rows alone never establish a grant. */
export class ConversationMemory {
  constructor(
    readonly pg: MemoryDatabase,
    readonly ownerId: string,
    readonly workspace: WorkspaceStore,
    readonly memoryEnabled: () => boolean = () => true,
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
    return (
      this.dependenciesAllowed(guard, dot.id) &&
      guard.pageIds.every((id) =>
        guard.spaceIds.some((spaceId) =>
          this.workspace.pages.exists(spaceId, id),
        ),
      )
    );
  }
  dependenciesAllowed(guard: EvidenceGuard, dotId: string): boolean {
    return guardDependenciesAllowed(
      this.workspace,
      guard,
      dotId,
      this.memoryEnabled(),
    );
  }
  async blockedThreads(threadIds: string[]): Promise<string[]> {
    const result = await this.pg.query<{ id: string }>(
      `SELECT t.id FROM local_ai_threads t JOIN local_ai_runs r ON r.owner_id=t.owner_id AND r.thread_id=t.id AND r.run_id=t.last_run_id
      WHERE t.owner_id=$1 AND t.id=ANY($2::text[]) AND r.status='finished'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.messages) m CROSS JOIN LATERAL jsonb_array_elements(coalesce(m->'toolCalls','[]'::jsonb)) c
        WHERE m->>'role'='assistant' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t.messages) answer WHERE answer->>'role'='tool' AND answer->>'toolCallId'=c->>'id'))`,
      [this.ownerId, threadIds],
    );
    return result.rows.map((row) => row.id);
  }
  async sourceThreads(sourceIds: string[]): Promise<string[]> {
    const result = await this.pg.query<{ thread_id: string }>(
      'SELECT DISTINCT thread_id FROM memory_episode_chunks WHERE owner_id=$1 AND source_id=ANY($2::text[])',
      [this.ownerId, sourceIds],
    );
    return result.rows.map((row) => row.thread_id);
  }
  async pendingRuns(threadIds: string[], cursor: string): Promise<string[]> {
    const result = await this.pg.query<{ run_id: string }>(
      `SELECT r.run_id FROM local_ai_runs r WHERE r.owner_id=$1 AND r.thread_id=ANY($2::text[]) AND r.status<>'running' AND r.provenance_complete=true
      AND r.run_id>$3 AND NOT EXISTS(SELECT 1 FROM memory_index_runs i WHERE i.owner_id=r.owner_id AND i.thread_id=r.thread_id AND i.run_id=r.run_id) ORDER BY r.run_id LIMIT 5`,
      [this.ownerId, threadIds, cursor],
    );
    return result.rows.map((row) => row.run_id);
  }
  async pendingSources(input: PendingSources): Promise<string[]> {
    const result = await this.pg.query<{ source_id: string }>(
      `SELECT c.source_id FROM memory_episode_chunks c JOIN memory_evidence e ON e.owner_id=c.owner_id AND e.thread_id=c.thread_id AND e.run_id=c.run_id
      LEFT JOIN memory_processed_sources p ON p.owner_id=c.owner_id AND p.source_id=c.source_id
      WHERE c.owner_id=$1 AND e.dot_id=$2 AND e.completed_at>=$3 AND c.thread_id=ANY($4::text[]) AND p.source_id IS NULL AND c.source_id>$5 ORDER BY c.source_id LIMIT 40`,
      [this.ownerId, input.dotId, input.since, input.threadIds, input.cursor],
    );
    return result.rows.map((row) => row.source_id);
  }
  async compactSnapshot(
    threadId: string,
  ): Promise<CompactSnapshot | undefined> {
    const result = await this.pg.query<{
      last_run_id: string | null;
      updated_at: Date;
      last_status: string | null;
      checkpoint_id: string | null;
    }>(
      `SELECT t.last_run_id,t.updated_at,r.status AS last_status,(SELECT id FROM memory_checkpoints c WHERE c.owner_id=t.owner_id AND c.thread_id=t.id ORDER BY covered_count DESC,created_at DESC LIMIT 1) AS checkpoint_id FROM local_ai_threads t LEFT JOIN local_ai_runs r ON r.owner_id=t.owner_id AND r.thread_id=t.id AND r.run_id=t.last_run_id WHERE t.owner_id=$1 AND t.id=$2`,
      [this.ownerId, threadId],
    );
    const row = result.rows[0];
    return row
      ? {
          lastRunId: row.last_run_id,
          updatedAt: row.updated_at.getTime(),
          lastStatus: row.last_status,
          checkpointId: row.checkpoint_id,
        }
      : undefined;
  }
  async completedExchanges(threadId: string, since: number): Promise<number> {
    const result = await this.pg.query(
      'SELECT count(*) AS n FROM memory_evidence WHERE owner_id=$1 AND thread_id=$2 AND workflow_complete=true AND completed_at>$3',
      [this.ownerId, threadId, since],
    );
    return Number(result.rows[0].n);
  }
  async modelMessages(
    threadId: string,
    messages: Message[],
  ): Promise<Message[]> {
    const binding = this.workspace.requireThread(threadId);
    const runs = await this.pg.query<{ guard: EvidenceGuard; ids: string[] }>(
      `SELECT evidence_guard AS guard,jsonb_path_query_array(evidence_messages,'$[*].id') AS ids FROM local_ai_runs WHERE owner_id=$1 AND thread_id=$2 AND evidence_guard IS NOT NULL`,
      [this.ownerId, threadId],
    );
    const hidden = new Set<string>();
    for (const run of runs.rows)
      if (
        run.guard.originDotId !== binding.dotId ||
        !this.sourcesExist(run.guard)
      )
        for (const id of run.ids) hidden.add(id);
    return this.workspace.memory
      .maskMessages(threadId, messages)
      .map((message) => {
        if (!hidden.has(message.id)) return message;
        return {
          ...message,
          content: '[Memory content withheld]',
          ...(message.role === 'assistant'
            ? {
                toolCalls: message.toolCalls?.map((call) => ({
                  ...call,
                  function: {
                    ...call.function,
                    arguments: '{"memoryContentWithheld":true}',
                  },
                })),
              }
            : {}),
        } as Message;
      });
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
        for (let start = 0; start < text.length;) {
          let end = start,
            bytes = 0;
          for (const char of text.slice(start)) {
            const size = Buffer.byteLength(char);
            if (bytes + size > 4000) break;
            bytes += size;
            end += char.length;
          }
          const source: SourceRef = {
            threadId: run.thread_id,
            runId,
            messageIds: [message.id],
            contentHash: evidenceHash(message),
            guard: run.evidence_guard,
            start,
            end,
            messageLength: text.length,
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
            text: text.slice(start, end),
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
          start = end;
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
    messages?: Message[],
  ): Promise<ContextCheckpoint | undefined> {
    this.workspace.requireThread(threadId);
    const result = await this.pg.query<{ value: ContextCheckpoint }>(
      'SELECT value FROM memory_checkpoints WHERE owner_id=$1 AND thread_id=$2 ORDER BY covered_count DESC,created_at DESC LIMIT 1',
      [this.ownerId, threadId],
    );
    const checkpoint = result.rows[0]?.value;
    if (!checkpoint) return;
    const prefix = (messages ?? (await this.threadMessages(threadId))).slice(
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
    lease?: { id: string; token: string; now: number },
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
      `WITH current_lease AS (SELECT id FROM memory_jobs WHERE owner_id=$1 AND id=$7 AND lease_token=$8 AND state='running' AND lease_until>$9::bigint FOR UPDATE)
      INSERT INTO memory_checkpoints(owner_id,thread_id,id,covered_count,value)
      SELECT $1,$2,$3,$4::integer,$5::jsonb FROM local_ai_threads t WHERE t.owner_id=$1 AND t.id=$2
      AND ($7::text IS NULL OR EXISTS(SELECT 1 FROM current_lease))
      AND (SELECT coalesce(jsonb_agg(m ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements(t.messages) WITH ORDINALITY AS x(m,ordinal) WHERE ordinal<=$4::integer)=$6::jsonb
      ON CONFLICT(owner_id,id) DO UPDATE SET value=excluded.value RETURNING id`,
      [
        this.ownerId,
        checkpoint.threadId,
        checkpoint.id,
        checkpoint.sourceMessageIds.length,
        JSON.stringify(checkpoint),
        JSON.stringify(prefix),
        lease?.id ?? null,
        lease?.token ?? null,
        lease ? Math.max(lease.now, Date.now()) : null,
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
