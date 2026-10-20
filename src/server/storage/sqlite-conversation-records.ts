import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BaseEvent, Message, RunAgentInput } from '@ag-ui/core';
import type { LocalThreadEndpointRecord } from '@copilotkit/runtime/v2';
import type {
  ConversationSnapshot,
  RunStatus,
  ThreadInput,
} from '../local-conversations.js';
import type { EvidenceGuard } from '../../shared/memory.js';
import { evidenceHash, unionEvidence } from '../conversation-memory.js';
export interface SQLiteThreadLease {
  threadId: string;
  token: string;
  generation: number;
}
type ThreadRow = {
  id: string;
  agent_id: string;
  name: string | null;
  state: string;
  last_run_id: string | null;
  created_at: number;
  updated_at: number;
  lease_token: string | null;
  lease_until: number;
  lease_generation: number;
};
type RunRow = {
  run_id: string;
  input: string;
  status: RunStatus;
  evidence_guard: string | null;
  prior_message_ids: string;
  provenance_complete: number;
  next_event_seq: number;
};
/** Synchronous repository, only called inside the storage worker's short request transaction. */
export class SQLiteConversationRecords {
  constructor(
    private db: DatabaseSync,
    readonly ownerId: string,
  ) {}
  private thread(threadId: string) {
    const row = this.db
      .prepare('SELECT * FROM conversation_threads WHERE owner_id=? AND id=?')
      .get(this.ownerId, threadId) as ThreadRow | undefined;
    if (!row) throw new Error('Conversation not found.');
    return row;
  }
  private run(threadId: string, runId: string) {
    return this.db
      .prepare(
        'SELECT * FROM conversation_runs WHERE owner_id=? AND thread_id=? AND run_id=?',
      )
      .get(this.ownerId, threadId, runId) as RunRow;
  }
  private record(row: ThreadRow): LocalThreadEndpointRecord {
    return {
      id: row.id,
      agentId: row.agent_id,
      name: row.name,
      organizationId: 'local',
      createdById: this.ownerId,
      archived: false,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
  private requireOwner(input: ThreadInput) {
    if (input.userId !== this.ownerId)
      throw new Error('Conversation owner does not match.');
  }
  createThread(input: ThreadInput) {
    this.requireOwner(input);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO conversation_threads(owner_id,id,agent_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        this.ownerId,
        input.threadId,
        input.agentId,
        input.name ?? null,
        now,
        now,
      );
    return this.record(this.thread(input.threadId));
  }
  getOrCreateThread(input: ThreadInput) {
    this.requireOwner(input);
    if (
      !this.db
        .prepare('SELECT 1 FROM conversation_threads WHERE owner_id=? AND id=?')
        .get(this.ownerId, input.threadId)
    )
      return this.createThread(input);
    const row = this.thread(input.threadId);
    if (row.agent_id !== input.agentId)
      throw new Error('Conversation belongs to a different agent.');
    return this.record(row);
  }
  listThreads(agentId?: string) {
    return (
      this.db
        .prepare(
          'SELECT * FROM conversation_threads WHERE owner_id=? AND (? IS NULL OR agent_id=?) ORDER BY updated_at DESC,id',
        )
        .all(this.ownerId, agentId ?? null, agentId ?? null) as ThreadRow[]
    ).map((row) => this.record(row));
  }
  interruptedThreads(): string[] {
    return this.db
      .prepare(
        "SELECT DISTINCT thread_id FROM conversation_runs WHERE owner_id=? AND status='running'",
      )
      .all(this.ownerId)
      .map((row) => String(row.thread_id));
  }
  private currentMessages(threadId: string): Message[] {
    return this.db
      .prepare(
        'SELECT v.value FROM conversation_messages m JOIN conversation_message_versions v USING(owner_id,thread_id,message_id,hash) WHERE m.owner_id=? AND m.thread_id=? ORDER BY m.seq',
      )
      .all(this.ownerId, threadId)
      .map((row) => JSON.parse(String(row.value)));
  }
  private runMessages(
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
  readSnapshot(threadId: string): ConversationSnapshot {
    const thread = this.thread(threadId);
    const snapshot: ConversationSnapshot = {
      messages: this.currentMessages(threadId),
      state: JSON.parse(thread.state),
    };
    if (thread.last_run_id) {
      const run = this.run(threadId, thread.last_run_id);
      snapshot.lastRun = {
        runId: run.run_id,
        input: {
          ...JSON.parse(run.input),
          messages: this.runMessages(threadId, run.run_id, 'input'),
        },
        events: this.events(threadId, run.run_id),
        status: run.status,
      };
    }
    return snapshot;
  }
  private events(threadId: string, runId: string): BaseEvent[] {
    return this.db
      .prepare(
        'SELECT value FROM conversation_events WHERE owner_id=? AND thread_id=? AND run_id=? ORDER BY seq',
      )
      .all(this.ownerId, threadId, runId)
      .map((row) => JSON.parse(String(row.value)));
  }
  getEvents(threadId: string): BaseEvent[] {
    this.thread(threadId);
    return this.db
      .prepare(
        'SELECT e.value FROM conversation_runs r JOIN conversation_events e USING(owner_id,thread_id,run_id) WHERE r.owner_id=? AND r.thread_id=? ORDER BY r.created_at,r.run_id,e.seq',
      )
      .all(this.ownerId, threadId)
      .map((row) => JSON.parse(String(row.value)));
  }
  acquire(threadId: string, duration: number): SQLiteThreadLease | null {
    this.duration(duration);
    const thread = this.thread(threadId);
    if (thread.lease_token && thread.lease_until > Date.now()) return null;
    const token = randomUUID();
    const generation = thread.lease_generation + 1;
    this.db
      .prepare(
        'UPDATE conversation_threads SET lease_token=?,lease_generation=?,lease_until=? WHERE owner_id=? AND id=?',
      )
      .run(token, generation, Date.now() + duration, this.ownerId, threadId);
    return { threadId, token, generation };
  }
  private duration(value: number) {
    if (!Number.isSafeInteger(value) || value < 25 || value > 60_000)
      throw new Error('Invalid conversation lease duration');
  }
  private owned(lease: SQLiteThreadLease): ThreadRow {
    const thread = this.thread(lease.threadId);
    if (
      thread.lease_token !== lease.token ||
      thread.lease_generation !== lease.generation ||
      thread.lease_until <= Date.now()
    )
      throw new Error('Conversation lease ownership was lost.');
    return thread;
  }
  renew(lease: SQLiteThreadLease, duration: number) {
    this.duration(duration);
    this.owned(lease);
    this.db
      .prepare(
        'UPDATE conversation_threads SET lease_until=? WHERE owner_id=? AND id=?',
      )
      .run(Date.now() + duration, this.ownerId, lease.threadId);
  }
  release(lease: SQLiteThreadLease) {
    this.db
      .prepare(
        'UPDATE conversation_threads SET lease_token=NULL,lease_until=0 WHERE owner_id=? AND id=? AND lease_token=? AND lease_generation=?',
      )
      .run(this.ownerId, lease.threadId, lease.token, lease.generation);
  }
  readLeased(lease: SQLiteThreadLease) {
    const thread = this.owned(lease);
    if (thread.last_run_id)
      this.db
        .prepare(
          "UPDATE conversation_runs SET lease_generation=? WHERE owner_id=? AND thread_id=? AND run_id=? AND status='running'",
        )
        .run(
          lease.generation,
          this.ownerId,
          lease.threadId,
          thread.last_run_id,
        );
    return this.readSnapshot(lease.threadId);
  }
  private active(lease: SQLiteThreadLease): RunRow {
    const thread = this.owned(lease);
    if (!thread.last_run_id) throw new Error('No active conversation run.');
    const run = this.run(lease.threadId, thread.last_run_id);
    if (run.status !== 'running')
      throw new Error('No active conversation run.');
    const generation = this.db
      .prepare(
        'SELECT lease_generation FROM conversation_runs WHERE owner_id=? AND thread_id=? AND run_id=?',
      )
      .get(this.ownerId, lease.threadId, run.run_id)!.lease_generation;
    if (generation !== lease.generation)
      throw new Error(
        'Conversation run ownership was lost. Read interrupted state before recovery.',
      );
    return run;
  }
  private version(threadId: string, message: Message) {
    if (!message.id) throw new Error('Every message needs an ID.');
    const hash = evidenceHash(message);
    this.db
      .prepare(
        'INSERT OR IGNORE INTO conversation_message_versions VALUES(?,?,?,?,?)',
      )
      .run(this.ownerId, threadId, message.id, hash, JSON.stringify(message));
    return hash;
  }
  private saveMessages(threadId: string, messages: Message[]) {
    const current = this.db
      .prepare(
        'SELECT message_id,seq,hash FROM conversation_messages WHERE owner_id=? AND thread_id=? ORDER BY seq',
      )
      .all(this.ownerId, threadId);
    const byId = new Map(current.map((row) => [String(row.message_id), row]));
    const ids = new Set(messages.map((message) => message.id));
    if (ids.size !== messages.length) throw new Error('Duplicate message ID');
    // Stable appends touch only new/changed rows. Explicit snapshots can also remove or reorder current messages;
    // immutable versions and run-input references remain for evidence and recovery.
    const reorder = current.some(
      (row, index) => messages[index]?.id !== row.message_id,
    );
    if (reorder) {
      this.db
        .prepare(
          'DELETE FROM conversation_messages WHERE owner_id=? AND thread_id=? AND message_id NOT IN (SELECT value FROM json_each(?))',
        )
        .run(this.ownerId, threadId, JSON.stringify([...ids]));
      this.db
        .prepare(
          'UPDATE conversation_messages SET seq=-seq-1 WHERE owner_id=? AND thread_id=?',
        )
        .run(this.ownerId, threadId);
    }
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const prior = byId.get(message.id);
      const hash = evidenceHash(message);
      if (prior?.hash === hash && !reorder) continue;
      if (prior?.hash !== hash) this.version(threadId, message);
      this.db
        .prepare(
          'INSERT INTO conversation_messages VALUES(?,?,?,?,?) ON CONFLICT(owner_id,thread_id,message_id) DO UPDATE SET hash=excluded.hash,seq=excluded.seq',
        )
        .run(this.ownerId, threadId, message.id, index, hash);
    }
  }
  private saveRunMessages(
    threadId: string,
    runId: string,
    kind: 'input' | 'evidence',
    messages: Message[],
  ) {
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const hash = this.version(threadId, message);
      this.db
        .prepare('INSERT INTO conversation_run_messages VALUES(?,?,?,?,?,?,?)')
        .run(this.ownerId, threadId, runId, kind, index, message.id, hash);
    }
  }
  beginRun(
    lease: SQLiteThreadLease,
    input: RunAgentInput,
    guard?: EvidenceGuard,
  ) {
    const thread = this.owned(lease);
    if (input.threadId !== lease.threadId)
      throw new Error('Conversation scope mismatch.');
    if (this.run(lease.threadId, input.runId))
      throw new Error('This run ID has already been used.');
    const previous = thread.last_run_id
      ? this.run(lease.threadId, thread.last_run_id)
      : undefined;
    if (previous?.status === 'running')
      throw new Error('Recover the active conversation run first.');
    const priorIds = this.currentMessages(lease.threadId).map(
      (message) => message.id,
    );
    const inherited = guard
      ? unionEvidence(
          previous?.evidence_guard ? JSON.parse(previous.evidence_guard) : null,
          guard,
        )
      : null;
    const complete =
      !!guard && (!priorIds.length || previous?.provenance_complete === 1);
    const { messages, ...metadata } = input;
    this.db
      .prepare(
        "INSERT INTO conversation_runs(owner_id,thread_id,run_id,input,status,created_at,lease_generation,evidence_guard,prior_message_ids,provenance_complete) VALUES(?,?,?,?,'running',?,?,?,?,?)",
      )
      .run(
        this.ownerId,
        lease.threadId,
        input.runId,
        JSON.stringify(metadata),
        Date.now(),
        lease.generation,
        inherited ? JSON.stringify(inherited) : null,
        JSON.stringify(priorIds),
        +complete,
      );
    this.saveMessages(lease.threadId, messages);
    this.saveRunMessages(lease.threadId, input.runId, 'input', messages);
    this.db
      .prepare(
        'UPDATE conversation_threads SET last_run_id=?,state=?,updated_at=? WHERE owner_id=? AND id=?',
      )
      .run(
        input.runId,
        JSON.stringify(input.state),
        Date.now(),
        this.ownerId,
        lease.threadId,
      );
    this.owned(lease);
  }
  addEvidenceGuard(lease: SQLiteThreadLease, guard: EvidenceGuard) {
    const run = this.active(lease);
    const combined = unionEvidence(
      run.evidence_guard ? JSON.parse(run.evidence_guard) : null,
      guard,
    );
    this.db
      .prepare(
        'UPDATE conversation_runs SET evidence_guard=? WHERE owner_id=? AND thread_id=? AND run_id=?',
      )
      .run(JSON.stringify(combined), this.ownerId, lease.threadId, run.run_id);
    this.owned(lease);
  }
  appendEvent(lease: SQLiteThreadLease, event: BaseEvent) {
    const run = this.active(lease);
    const terminal =
      event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR';
    const prior = this.db
      .prepare(
        'SELECT value FROM conversation_events WHERE owner_id=? AND thread_id=? AND run_id=? AND terminal=1',
      )
      .get(this.ownerId, lease.threadId, run.run_id);
    if (prior) {
      if (
        terminal &&
        evidenceHash(JSON.parse(String(prior.value))) === evidenceHash(event)
      )
        return;
      throw new Error('Conversation already has a terminal event.');
    }
    if ('threadId' in event && event.threadId !== lease.threadId)
      throw new Error('Conversation event scope mismatch.');
    if ('runId' in event && event.runId !== run.run_id)
      throw new Error('Conversation event run mismatch.');
    this.db
      .prepare('INSERT INTO conversation_events VALUES(?,?,?,?,?,?,?)')
      .run(
        this.ownerId,
        lease.threadId,
        run.run_id,
        run.next_event_seq,
        event.type,
        +terminal,
        JSON.stringify(event),
      );
    this.db
      .prepare(
        'UPDATE conversation_runs SET next_event_seq=next_event_seq+1 WHERE owner_id=? AND thread_id=? AND run_id=?',
      )
      .run(this.ownerId, lease.threadId, run.run_id);
    this.owned(lease);
  }
  finishRun(
    lease: SQLiteThreadLease,
    messages: Message[],
    state: Record<string, unknown>,
    status: Exclude<RunStatus, 'running'>,
    terminal?: BaseEvent,
  ) {
    const run = this.active(lease);
    if (terminal) this.appendEvent(lease, terminal);
    this.saveMessages(lease.threadId, messages);
    const prior = new Set<string>(JSON.parse(run.prior_message_ids));
    this.saveRunMessages(
      lease.threadId,
      run.run_id,
      'evidence',
      messages.filter((message) => !prior.has(message.id)),
    );
    this.db
      .prepare(
        'UPDATE conversation_runs SET status=? WHERE owner_id=? AND thread_id=? AND run_id=?',
      )
      .run(status, this.ownerId, lease.threadId, run.run_id);
    this.db
      .prepare(
        'UPDATE conversation_threads SET state=?,updated_at=? WHERE owner_id=? AND id=?',
      )
      .run(JSON.stringify(state), Date.now(), this.ownerId, lease.threadId);
    if (
      status !== 'interrupted' &&
      run.provenance_complete &&
      run.evidence_guard
    ) {
      const answered = new Set(
        messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.toolCallId),
      );
      const pending = messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.toolCalls?.some((call) => !answered.has(call.id)),
      );
      const guard: EvidenceGuard = JSON.parse(run.evidence_guard);
      this.db
        .prepare(
          'INSERT OR IGNORE INTO memory_evidence(owner_id,id,thread_id,run_id,dot_id,workflow_complete,completed_at) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          this.ownerId,
          evidenceHash([this.ownerId, lease.threadId, run.run_id]),
          lease.threadId,
          run.run_id,
          guard.originDotId,
          +(status === 'finished' && !pending),
          Date.now(),
        );
    }
    this.owned(lease);
  }
}
