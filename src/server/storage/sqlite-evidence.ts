import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { Message } from '@ag-ui/core';
import type { WorkspaceStore } from '../workspace.js';
import type { ContextCheckpoint } from '../context-compaction.js';
import type { EvidenceGuard, SourceRef } from '../../shared/memory.js';
import {
  evidenceHash,
  guardDependenciesAllowed,
  type EpisodePage,
  type EpisodeQuery,
  type IndexCoverage,
  type SourceRecord,
  type PendingSources,
  type CompactSnapshot,
} from '../conversation-memory.js';
interface SourceRow {
  source_id: string;
  source: string;
  text: string;
  role: string;
  created_at: number;
  tool_name: string | null;
  workflow_complete: number | null;
}
export class SQLiteEvidence {
  constructor(
    private db: DatabaseSync,
    readonly ownerId: string,
    readonly workspace: WorkspaceStore,
    readonly memoryEnabled: () => boolean,
  ) {}
  private threads(dotId?: string) {
    return this.workspace
      .conversations()
      .filter((thread) => !dotId || thread.dotId === dotId)
      .map((thread) => thread.id);
  }
  dependenciesAllowed(guard: EvidenceGuard, dotId: string) {
    return guardDependenciesAllowed(
      this.workspace,
      guard,
      dotId,
      this.memoryEnabled(),
    );
  }
  sourcesExist(guard: EvidenceGuard) {
    const dot = this.workspace.dot(guard.originDotId);
    return (
      !!dot &&
      guard.spaceIds.every((id) => this.workspace.canAccessSpace(dot.id, id)) &&
      this.dependenciesAllowed(guard, dot.id) &&
      guard.pageIds.every((id) =>
        guard.spaceIds.some((space) => this.workspace.pages.exists(space, id)),
      )
    );
  }
  threadMessages(threadId: string): Message[] {
    this.workspace.requireThread(threadId);
    if (
      !this.db
        .prepare('SELECT 1 FROM conversation_threads WHERE owner_id=? AND id=?')
        .get(this.ownerId, threadId)
    )
      throw new Error('Conversation not found');
    return this.db
      .prepare(
        'SELECT v.value FROM conversation_messages m JOIN conversation_message_versions v USING(owner_id,thread_id,message_id,hash) WHERE m.owner_id=? AND m.thread_id=? ORDER BY m.seq',
      )
      .all(this.ownerId, threadId)
      .map((row) => JSON.parse(String(row.value)));
  }
  modelMessages(threadId: string, messages: Message[]): Message[] {
    const binding = this.workspace.requireThread(threadId);
    const hidden = new Set<string>();
    const rows = this.db
      .prepare(
        "SELECT r.evidence_guard,m.message_id FROM conversation_runs r JOIN conversation_run_messages m USING(owner_id,thread_id,run_id) WHERE r.owner_id=? AND r.thread_id=? AND r.evidence_guard IS NOT NULL AND m.kind='evidence'",
      )
      .all(this.ownerId, threadId);
    for (const row of rows) {
      const guard: EvidenceGuard = JSON.parse(String(row.evidence_guard));
      if (guard.originDotId !== binding.dotId || !this.sourcesExist(guard))
        hidden.add(String(row.message_id));
    }
    return this.workspace.memory
      .maskMessages(threadId, messages)
      .map((message) =>
        !hidden.has(message.id)
          ? message
          : ({
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
            } as Message),
      );
  }
  blockedThreads(threadIds: string[]): string[] {
    return this.db
      .prepare(
        `SELECT t.id FROM conversation_threads t JOIN conversation_runs r ON r.owner_id=t.owner_id AND r.thread_id=t.id AND r.run_id=t.last_run_id
      WHERE t.owner_id=? AND t.id IN(SELECT value FROM json_each(?)) AND r.status='finished'
      AND EXISTS(SELECT 1 FROM conversation_messages m JOIN conversation_message_versions v USING(owner_id,thread_id,message_id,hash), json_each(json_extract(v.value,'$.toolCalls')) c
        WHERE m.owner_id=t.owner_id AND m.thread_id=t.id AND json_extract(v.value,'$.role')='assistant'
        AND NOT EXISTS(SELECT 1 FROM conversation_messages a JOIN conversation_message_versions av USING(owner_id,thread_id,message_id,hash) WHERE a.owner_id=t.owner_id AND a.thread_id=t.id AND json_extract(av.value,'$.role')='tool' AND json_extract(av.value,'$.toolCallId')=json_extract(c.value,'$.id')))`,
      )
      .all(this.ownerId, JSON.stringify(threadIds))
      .map((row) => String(row.id));
  }
  sourceThreads(sourceIds: string[]): string[] {
    return this.db
      .prepare(
        'SELECT DISTINCT thread_id FROM memory_episode_chunks WHERE owner_id=? AND source_id IN(SELECT value FROM json_each(?))',
      )
      .all(this.ownerId, JSON.stringify(sourceIds))
      .map((row) => String(row.thread_id));
  }
  pendingRuns(threadIds: string[], cursor: string): string[] {
    return this.db
      .prepare(
        `SELECT r.run_id FROM conversation_runs r WHERE r.owner_id=? AND r.thread_id IN(SELECT value FROM json_each(?)) AND r.status<>'running' AND r.provenance_complete=1 AND r.run_id>? AND NOT EXISTS(SELECT 1 FROM memory_index_runs i WHERE i.owner_id=r.owner_id AND i.thread_id=r.thread_id AND i.run_id=r.run_id) ORDER BY r.run_id LIMIT 5`,
      )
      .all(this.ownerId, JSON.stringify(threadIds), cursor)
      .map((row) => String(row.run_id));
  }
  pendingSources(input: PendingSources): string[] {
    return this.db
      .prepare(
        `SELECT c.source_id FROM memory_episode_chunks c JOIN memory_evidence e USING(owner_id,thread_id,run_id) JOIN memory_index_runs i USING(owner_id,thread_id,run_id)
      LEFT JOIN memory_processed_sources p ON p.owner_id=c.owner_id AND p.source_id=c.source_id WHERE c.owner_id=? AND e.dot_id=? AND e.completed_at>=? AND c.thread_id IN(SELECT value FROM json_each(?)) AND p.source_id IS NULL AND c.source_id>? ORDER BY c.source_id LIMIT 40`,
      )
      .all(
        this.ownerId,
        input.dotId,
        input.since,
        JSON.stringify(input.threadIds),
        input.cursor,
      )
      .map((row) => String(row.source_id));
  }
  compactSnapshot(threadId: string): CompactSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT t.last_run_id,t.updated_at,r.status AS last_status,(SELECT id FROM memory_checkpoints c WHERE c.owner_id=t.owner_id AND c.thread_id=t.id ORDER BY covered_count DESC,created_at DESC LIMIT 1) AS checkpoint_id FROM conversation_threads t LEFT JOIN conversation_runs r ON r.owner_id=t.owner_id AND r.thread_id=t.id AND r.run_id=t.last_run_id WHERE t.owner_id=? AND t.id=?`,
      )
      .get(this.ownerId, threadId);
    return row
      ? {
          lastRunId: row.last_run_id as string | null,
          updatedAt: Number(row.updated_at),
          lastStatus: row.last_status as string | null,
          checkpointId: row.checkpoint_id as string | null,
        }
      : undefined;
  }
  completedExchanges(threadId: string, since: number): number {
    return Number(
      this.db
        .prepare(
          'SELECT count(*) AS n FROM memory_evidence WHERE owner_id=? AND thread_id=? AND workflow_complete=1 AND completed_at>?',
        )
        .get(this.ownerId, threadId, since)!.n,
    );
  }
  private evidenceMessages(
    threadId: string,
    runId: string,
    kind: 'input' | 'evidence',
  ): Message[] {
    return this.db
      .prepare(
        'SELECT v.value FROM conversation_run_messages m JOIN conversation_message_versions v USING(owner_id,thread_id,message_id,hash) WHERE m.owner_id=? AND m.thread_id=? AND m.run_id=? AND m.kind=? ORDER BY m.seq',
      )
      .all(this.ownerId, threadId, runId, kind)
      .map((row) => JSON.parse(String(row.value)));
  }
  /** At most 64 chunks and 32 messages per request; the async facade yields between batches. */
  indexBatch(runId: string): { complete: boolean } {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM conversation_runs r WHERE r.owner_id=? AND r.run_id=? AND r.thread_id IN(SELECT value FROM json_each(?)) AND r.status<>'running' AND r.evidence_guard IS NOT NULL AND r.provenance_complete=1
      AND NOT EXISTS(SELECT 1 FROM memory_index_runs i WHERE i.owner_id=r.owner_id AND i.thread_id=r.thread_id AND i.run_id=r.run_id) ORDER BY r.thread_id`,
      )
      .all(this.ownerId, runId, JSON.stringify(this.threads()));
    for (const run of rows) {
      const threadId = String(run.thread_id),
        guard: EvidenceGuard = JSON.parse(String(run.evidence_guard));
      if (
        this.workspace.requireThread(threadId).dotId !== guard.originDotId ||
        !this.sourcesExist(guard)
      )
        continue;
      const cursor = this.db
        .prepare(
          'SELECT message_seq,offset FROM memory_index_progress WHERE owner_id=? AND thread_id=? AND run_id=?',
        )
        .get(this.ownerId, threadId, runId);
      let sequence = Number(cursor?.message_seq ?? 0),
        offset = Number(cursor?.offset ?? 0),
        chunks = 0;
      const messages = this.db
        .prepare(
          "SELECT m.seq,v.value FROM conversation_run_messages m JOIN conversation_message_versions v USING(owner_id,thread_id,message_id,hash) WHERE m.owner_id=? AND m.thread_id=? AND m.run_id=? AND m.kind='evidence' AND m.seq>=? ORDER BY m.seq LIMIT 33",
        )
        .all(this.ownerId, threadId, runId, sequence);
      let toolNames: Map<string, string> | undefined;
      const toolName = (id: string) => {
        toolNames ??= new Map(
          [
            ...this.evidenceMessages(threadId, runId, 'input'),
            ...this.evidenceMessages(threadId, runId, 'evidence'),
          ].flatMap((message) =>
            message.role === 'assistant'
              ? (message.toolCalls ?? []).map(
                  (call) => [call.id, call.function.name] as const,
                )
              : [],
          ),
        );
        return toolNames.get(id);
      };
      let finished = messages.length <= 32;
      for (const row of messages.slice(0, 32)) {
        const message: Message = JSON.parse(String(row.value));
        sequence = Number(row.seq);
        const content =
          typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content ?? '');
        const text =
          content ||
          (message.role === 'assistant' && message.toolCalls?.length
            ? JSON.stringify(message.toolCalls)
            : '');
        const contentHash = evidenceHash(message);
        const tool =
          message.role === 'tool' ? toolName(message.toolCallId) : undefined;
        if (message.role !== 'system' && message.role !== 'developer') {
          while (offset < text.length && chunks < 64) {
            const start = offset;
            let bytes = 0;
            for (const character of text.slice(start)) {
              const size = Buffer.byteLength(character);
              if (bytes + size > 4000) break;
              bytes += size;
              offset += character.length;
            }
            const source: SourceRef = {
              threadId,
              runId,
              messageIds: [message.id],
              contentHash,
              guard,
              start,
              end: offset,
              messageLength: text.length,
            };
            this.db
              .prepare(
                'INSERT OR IGNORE INTO memory_episode_chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
              )
              .run(
                this.ownerId,
                evidenceHash([
                  this.ownerId,
                  threadId,
                  runId,
                  message.id,
                  start,
                ]),
                threadId,
                runId,
                message.id,
                source.contentHash,
                start,
                text.slice(start, offset),
                message.role,
                JSON.stringify(source),
                run.created_at,
                tool ?? null,
              );
            chunks++;
          }
          if (offset < text.length) {
            finished = false;
            break;
          }
        }
        sequence++;
        offset = 0;
        if (chunks >= 64 && sequence <= Number(messages.at(-1)?.seq)) {
          finished = false;
          break;
        }
      }
      if (finished) {
        this.db
          .prepare('INSERT OR IGNORE INTO memory_index_runs VALUES(?,?,?,1)')
          .run(this.ownerId, threadId, runId);
        this.db
          .prepare(
            'DELETE FROM memory_index_progress WHERE owner_id=? AND thread_id=? AND run_id=?',
          )
          .run(this.ownerId, threadId, runId);
      } else
        this.db
          .prepare(
            'INSERT INTO memory_index_progress VALUES(?,?,?,?,?) ON CONFLICT(owner_id,thread_id,run_id) DO UPDATE SET message_seq=excluded.message_seq,offset=excluded.offset',
          )
          .run(this.ownerId, threadId, runId, sequence, offset);
      this.db
        .prepare(
          'INSERT INTO memory_index_meta VALUES(?,1) ON CONFLICT(owner_id) DO UPDATE SET revision=revision+1',
        )
        .run(this.ownerId);
      return { complete: finished && rows.length === 1 };
    }
    return { complete: true };
  }
  generation(): number {
    return Number(
      this.db
        .prepare('SELECT revision FROM memory_index_meta WHERE owner_id=?')
        .get(this.ownerId)?.revision ?? 0,
    );
  }
  coverage(dotId?: string): IndexCoverage {
    const row = this.db
      .prepare(
        "SELECT count(*) AS eligible,count(i.run_id) AS indexed FROM conversation_runs r LEFT JOIN memory_index_runs i USING(owner_id,thread_id,run_id) WHERE r.owner_id=? AND r.thread_id IN(SELECT value FROM json_each(?)) AND r.status<>'running'",
      )
      .get(this.ownerId, JSON.stringify(this.threads(dotId)))!;
    const eligibleRuns = Number(row.eligible),
      indexedRuns = Number(row.indexed);
    return {
      eligibleRuns,
      indexedRuns,
      complete: eligibleRuns === indexedRuns,
    };
  }
  private record(row: SourceRow): SourceRecord {
    const source: SourceRef = JSON.parse(row.source);
    return {
      id: row.source_id,
      ownerId: this.ownerId,
      source,
      guard: source.guard,
      text: row.text,
      role: row.role,
      createdAt: row.created_at,
      toolName: row.tool_name ?? undefined,
      workflowComplete: row.workflow_complete === 1,
    };
  }
  searchEpisodes(query: EpisodeQuery): EpisodePage {
    const bound = new Set(this.threads()),
      threads = query.allowedThreadIds.filter((id) => bound.has(id));
    const limit = Math.max(1, Math.min(10, query.limit ?? 10)),
      offset = Number(query.cursor ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || query.query.length > 500)
      throw new Error('Invalid episode query');
    const coverage = this.coverage();
    const tokens = query.query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!tokens.length || !threads.length) return { matches: [], coverage };
    const rows = this.db
      .prepare(
        `SELECT c.*,e.workflow_complete FROM memory_episodes_fts JOIN memory_episode_chunks c ON c.rowid=memory_episodes_fts.rowid LEFT JOIN memory_evidence e USING(owner_id,thread_id,run_id)
      WHERE memory_episodes_fts MATCH ? AND c.owner_id=? AND c.thread_id IN(SELECT value FROM json_each(?)) AND (? IS NULL OR c.created_at>=?) AND (? IS NULL OR c.created_at<=?) ORDER BY c.created_at DESC,c.source_id LIMIT ? OFFSET ?`,
      )
      .all(
        tokens.map((token) => '"' + token + '"').join(' AND '),
        this.ownerId,
        JSON.stringify(threads),
        query.after ?? null,
        query.after ?? null,
        query.before ?? null,
        query.before ?? null,
        limit + 1,
        offset,
      ) as unknown as SourceRow[];
    return {
      matches: rows
        .slice(0, limit)
        .map((row) => this.record(row))
        .filter((row) => this.sourcesExist(row.guard)),
      coverage,
      ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
    };
  }
  sourceById(id: string): SourceRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT c.*,e.workflow_complete FROM memory_episode_chunks c LEFT JOIN memory_evidence e USING(owner_id,thread_id,run_id) WHERE c.owner_id=? AND c.source_id=? AND c.thread_id IN(SELECT value FROM json_each(?))',
      )
      .get(this.ownerId, id, JSON.stringify(this.threads())) as unknown as
      SourceRow | undefined;
    if (!row) return;
    const record = this.record(row);
    return this.sourcesExist(record.guard) ? record : undefined;
  }
  readSource(ref: SourceRef): SourceRecord | undefined {
    const id = evidenceHash([
      this.ownerId,
      ref.threadId,
      ref.runId,
      ref.messageIds[0],
      ref.start ?? 0,
    ]);
    const record = this.sourceById(id);
    if (record)
      return isDeepStrictEqual(record.source, ref) ? record : undefined;
    if (
      !this.threads().includes(ref.threadId) ||
      !this.sourcesExist(ref.guard) ||
      ref.messageIds.length !== 1
    )
      return;
    const run = this.db
      .prepare(
        "SELECT evidence_guard,created_at FROM conversation_runs WHERE owner_id=? AND thread_id=? AND run_id=? AND provenance_complete=1 AND status<>'running'",
      )
      .get(this.ownerId, ref.threadId, ref.runId);
    if (
      !run ||
      !isDeepStrictEqual(JSON.parse(String(run.evidence_guard)), ref.guard)
    )
      return;
    const message = this.evidenceMessages(
      ref.threadId,
      ref.runId,
      'evidence',
    ).find((message) => message.id === ref.messageIds[0]);
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
      createdAt: Number(run.created_at),
    };
  }
  latestCheckpoint(
    threadId: string,
    messages?: Message[],
  ): ContextCheckpoint | undefined {
    this.workspace.requireThread(threadId);
    const row = this.db
      .prepare(
        'SELECT value FROM memory_checkpoints WHERE owner_id=? AND thread_id=? ORDER BY covered_count DESC,created_at DESC LIMIT 1',
      )
      .get(this.ownerId, threadId);
    if (!row) return;
    const checkpoint: ContextCheckpoint = JSON.parse(String(row.value));
    const prefix = (messages ?? this.threadMessages(threadId)).slice(
      0,
      checkpoint.sourceMessageIds.length,
    );
    return evidenceHash(prefix) === checkpoint.sourceHash
      ? checkpoint
      : undefined;
  }
  saveCheckpoint(
    checkpoint: ContextCheckpoint,
    expectedPrefixHash: string,
    lease?: { id: string; token: string; now: number },
  ): boolean {
    const prefix = this.threadMessages(checkpoint.threadId).slice(
      0,
      checkpoint.sourceMessageIds.length,
    );
    if (
      checkpoint.sourceHash !== expectedPrefixHash ||
      evidenceHash(prefix) !== expectedPrefixHash ||
      !isDeepStrictEqual(
        prefix.map((message) => message.id),
        checkpoint.sourceMessageIds,
      )
    )
      return false;
    if (
      lease &&
      !this.db
        .prepare(
          "SELECT 1 FROM memory_jobs WHERE owner_id=? AND id=? AND lease_token=? AND state='running' AND lease_until>?",
        )
        .get(
          this.ownerId,
          lease.id,
          lease.token,
          Math.max(lease.now, Date.now()),
        )
    )
      return false;
    this.db
      .prepare(
        'INSERT INTO memory_checkpoints VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,id) DO UPDATE SET value=excluded.value',
      )
      .run(
        this.ownerId,
        checkpoint.threadId,
        checkpoint.id,
        checkpoint.sourceMessageIds.length,
        JSON.stringify(checkpoint),
        Date.now(),
      );
    return true;
  }
}
