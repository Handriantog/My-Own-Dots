import type { EvidenceGuard } from '../shared/memory.js';
import { unionEvidence, evidenceHash } from './conversation-memory.js';
import { initializeConversationMemorySchema } from './conversation-memory-schema.js';
import { isDeepStrictEqual } from 'node:util';
import { Pool, type PoolClient } from 'pg';
import {
  AbstractAgent,
  EventType,
  defaultApplyEvents,
  transformChunks,
  type Message,
  type RunAgentInput,
  type BaseEvent,
} from '@ag-ui/client';
import {
  finalizeRunEvents,
  type LocalThreadEndpointRecord,
} from '@copilotkit/runtime/v2';
import { defaultIfEmpty, from, lastValueFrom, tap } from 'rxjs';
import { pageReviewTool } from '../shared/page-review.js';
import { connectionActionTool } from '../shared/connection-types.js';

export type RunStatus =
  'running' | 'finished' | 'failed' | 'stopped' | 'interrupted';
export interface StoredRun {
  runId: string;
  input: RunAgentInput;
  events: BaseEvent[];
  status: RunStatus;
}
export interface ConversationSnapshot {
  messages: Message[];
  state: Record<string, unknown>;
  lastRun?: StoredRun;
}
export interface ThreadLease {
  readonly signal: AbortSignal;
  read(): Promise<ConversationSnapshot>;
  beginRun(input: RunAgentInput, guard?: EvidenceGuard): Promise<void>;
  addEvidenceGuard?(guard: EvidenceGuard): Promise<void>;
  appendEvent(event: BaseEvent): Promise<void>;
  finishRun(
    messages: Message[],
    state: Record<string, unknown>,
    status: Exclude<RunStatus, 'running'>,
    terminal?: BaseEvent,
  ): Promise<void>;
  release(): Promise<void>;
}
export interface ThreadInput {
  threadId: string;
  userId: string;
  agentId: string;
  name?: string;
}
export interface LocalConversationStore {
  readonly ownerId: string;
  getOrCreateThread(input: ThreadInput): Promise<LocalThreadEndpointRecord>;
  getSnapshot(threadId: string): Promise<ConversationSnapshot>;
  acquireThread(threadId: string): Promise<ThreadLease | null>;
  isRunning(threadId: string): Promise<boolean>;
}

/** Client history is a set of additions, never an authority over saved output. */
export function mergeInputMessages(
  saved: Message[],
  incoming: Message[],
): Message[] {
  const merged = structuredClone(saved);
  const ids = new Map(merged.map((message) => [message.id, message]));
  const answered = new Set(
    merged.filter((m) => m.role === 'tool').map((m) => m.toolCallId),
  );
  const clientTools = new Set([pageReviewTool.name, connectionActionTool.name]);
  const pending = new Set(
    merged.flatMap((message) =>
      message.role === 'assistant'
        ? (message.toolCalls ?? [])
            .filter(
              (call) =>
                clientTools.has(call.function.name) && !answered.has(call.id),
            )
            .map((call) => call.id)
        : [],
    ),
  );
  for (const message of incoming) {
    if (!message.id) throw new Error('Every message needs an ID.');
    const prior = ids.get(message.id);
    if (prior) {
      // Some clients serialize an absent subagent marker as null.
      const normalize = (value: Message) => {
        const copy = structuredClone(value);
        if (copy.subagentRunId === null) delete copy.subagentRunId;
        return copy;
      };
      if (!isDeepStrictEqual(normalize(prior), normalize(message)))
        throw new Error(`Cannot rewrite a saved ${prior.role} message.`);
      continue;
    }
    if (message.role === 'tool') {
      if (!pending.delete(message.toolCallId))
        throw new Error(
          'Tool result does not match a pending client approval.',
        );
    } else if (message.role !== 'user') {
      throw new Error(`Client cannot add ${message.role} messages.`);
    }
    const copy = structuredClone(message);
    merged.push(copy);
    ids.set(copy.id, copy);
  }
  return merged;
}

class ReplayAgent extends AbstractAgent {
  run() {
    return from<BaseEvent[]>([]);
  }
}

/** Use AG-UI's own reducer, including tool calls, activities and state patches. */
export async function replayRun(input: RunAgentInput, events: BaseEvent[]) {
  const agent = new ReplayAgent({
    threadId: input.threadId,
    initialMessages: input.messages,
    initialState: input.state,
  });
  await lastValueFrom(
    defaultApplyEvents(
      input,
      from(structuredClone(events)).pipe(transformChunks()),
      agent,
      [],
    ).pipe(
      tap((change) => {
        if (change.messages !== undefined) agent.messages = change.messages;
        if (change.state !== undefined) agent.state = change.state;
      }),
      defaultIfEmpty({}),
    ),
  );
  return {
    messages: agent.messages,
    state: agent.state as Record<string, unknown>,
    pendingInterrupts: agent.pendingInterrupts,
  };
}

type ThreadRow = {
  id: string;
  agent_id: string;
  name: string | null;
  created_at: Date;
  updated_at: Date;
  messages: Message[];
  state: Record<string, unknown>;
};
type RunRow = {
  run_id: string;
  input: RunAgentInput;
  events: BaseEvent[];
  status: RunStatus;
};

export class PostgresConversations implements LocalConversationStore {
  private readonly pool: Pool;
  private initialization?: Promise<void>;
  constructor(
    connectionString: string,
    readonly ownerId: string,
  ) {
    this.pool = new Pool({
      connectionString,
      max: 12,
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
    });
    // Checked-out sessions have a separate listener which aborts their agent.
    this.pool.on('error', () =>
      console.error('Local conversation database connection failed.'),
    );
  }

  initialize(): Promise<void> {
    this.initialization ??= this.initializeDatabase().catch(
      (error: unknown) => {
        this.initialization = undefined;
        throw error;
      },
    );
    return this.initialization;
  }
  private async initializeDatabase() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS local_ai_threads (
        owner_id text NOT NULL, id text NOT NULL, agent_id text NOT NULL, name text,
        messages jsonb NOT NULL DEFAULT '[]', state jsonb NOT NULL DEFAULT '{}',
        last_run_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, id)
      );
      CREATE TABLE IF NOT EXISTS local_ai_runs (
        owner_id text NOT NULL, thread_id text NOT NULL, run_id text NOT NULL,
        input jsonb NOT NULL, events jsonb NOT NULL DEFAULT '[]', status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, thread_id, run_id),
        FOREIGN KEY (owner_id, thread_id) REFERENCES local_ai_threads(owner_id, id)
      );
    `);
    await initializeConversationMemorySchema(this.pool);
    const stale = await this.pool.query<{ thread_id: string }>(
      "SELECT DISTINCT thread_id FROM local_ai_runs WHERE owner_id = $1 AND status = 'running'",
      [this.ownerId],
    );
    for (const row of stale.rows) {
      const lease = await this.acquireThreadSession(row.thread_id);
      if (!lease) continue; // Another live process still owns this turn.
      try {
        await this.recoverInterrupted(lease);
      } finally {
        await lease.release();
      }
    }
  }
  async close() {
    await this.pool.end();
  }
  private requireOwner(userId: string) {
    if (userId !== this.ownerId)
      throw new Error('Conversation owner does not match.');
  }
  private record(row: ThreadRow): LocalThreadEndpointRecord {
    return {
      id: row.id,
      agentId: row.agent_id,
      name: row.name,
      organizationId: 'local',
      createdById: this.ownerId,
      archived: false,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
  async createThread(input: ThreadInput) {
    this.requireOwner(input.userId);
    await this.initialize();
    const result = await this.pool.query<ThreadRow>(
      'INSERT INTO local_ai_threads(owner_id,id,agent_id,name) VALUES($1,$2,$3,$4) RETURNING *',
      [this.ownerId, input.threadId, input.agentId, input.name ?? null],
    );
    return this.record(result.rows[0]);
  }
  async getOrCreateThread(input: ThreadInput) {
    this.requireOwner(input.userId);
    await this.initialize();
    await this.pool.query(
      'INSERT INTO local_ai_threads(owner_id,id,agent_id,name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [this.ownerId, input.threadId, input.agentId, input.name ?? null],
    );
    const result = await this.pool.query<ThreadRow>(
      'SELECT * FROM local_ai_threads WHERE owner_id=$1 AND id=$2',
      [this.ownerId, input.threadId],
    );
    if (result.rows[0]?.agent_id !== input.agentId)
      throw new Error('Conversation belongs to a different agent.');
    return this.record(result.rows[0]);
  }
  async listThreads(agentId?: string) {
    await this.initialize();
    const result = await this.pool.query<ThreadRow>(
      'SELECT * FROM local_ai_threads WHERE owner_id=$1 AND ($2::text IS NULL OR agent_id=$2) ORDER BY updated_at DESC',
      [this.ownerId, agentId ?? null],
    );
    return result.rows.map((row) => this.record(row));
  }
  async getThreadMessages({
    threadId,
    userId,
  }: {
    threadId: string;
    userId: string;
  }) {
    this.requireOwner(userId);
    return { messages: (await this.getSnapshot(threadId)).messages };
  }
  async getState(threadId: string) {
    return (await this.getSnapshot(threadId)).state;
  }
  async getEvents(threadId: string): Promise<BaseEvent[]> {
    await this.initialize();
    const result = await this.pool.query<RunRow>(
      'SELECT events FROM local_ai_runs WHERE owner_id=$1 AND thread_id=$2 ORDER BY created_at, run_id',
      [this.ownerId, threadId],
    );
    return result.rows.flatMap((row) => row.events);
  }
  async getSnapshot(threadId: string) {
    await this.initialize();
    const snapshot = await this.read(this.pool, threadId);
    if (snapshot.lastRun?.status !== 'running') return snapshot;
    const lease = await this.acquireThreadSession(threadId);
    if (!lease) return snapshot;
    try {
      await this.recoverInterrupted(lease);
      return await lease.read();
    } finally {
      await lease.release();
    }
  }
  private async read(
    client: Pick<PoolClient, 'query'>,
    threadId: string,
  ): Promise<ConversationSnapshot> {
    const result = await client.query<
      ThreadRow & {
        run_id: string | null;
        input: RunAgentInput;
        events: BaseEvent[];
        status: RunStatus;
      }
    >(
      'SELECT t.*, r.run_id, r.input, r.events, r.status FROM local_ai_threads t LEFT JOIN local_ai_runs r ON r.owner_id=t.owner_id AND r.thread_id=t.id AND r.run_id=t.last_run_id WHERE t.owner_id=$1 AND t.id=$2',
      [this.ownerId, threadId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Conversation not found.');
    if (!row.run_id) return { messages: row.messages, state: row.state };
    const lastRun: StoredRun = {
      runId: row.run_id,
      input: row.input,
      events: row.events,
      status: row.status,
    };
    return { ...(await replayRun(lastRun.input, lastRun.events)), lastRun };
  }
  async isRunning(threadId: string) {
    const lease = await this.acquireThread(threadId);
    if (!lease) return true;
    await lease.release();
    return false;
  }
  async acquireThread(threadId: string): Promise<ThreadLease | null> {
    await this.initialize();
    return this.acquireThreadSession(threadId);
  }
  private async acquireThreadSession(
    threadId: string,
  ): Promise<ThreadLease | null> {
    const client = await this.pool.connect();
    const controller = new AbortController();
    const lost = () =>
      controller.abort(new Error('Conversation storage connection was lost.'));
    client.on('error', lost);
    let released = false;
    let runId: string | undefined;
    const query = async (sql: string, values: unknown[] = []) => {
      controller.signal.throwIfAborted();
      if (released) throw new Error('Conversation lock was released.');
      try {
        return await client.query(sql, values);
      } catch (error) {
        controller.abort(new Error('Conversation storage write failed.'));
        throw error;
      }
    };
    const release = async () => {
      if (released) return;
      released = true;
      let destroy = controller.signal.aborted;
      try {
        if (!destroy)
          await client.query(
            'SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',
            [this.ownerId, threadId],
          );
      } catch (error) {
        destroy = true;
        throw error;
      } finally {
        client.removeListener('error', lost);
        client.release(destroy);
      }
    };
    try {
      const lock = await query(
        'SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS acquired',
        [this.ownerId, threadId],
      );
      if (!lock.rows[0].acquired) {
        await release();
        return null;
      }
      const lease: ThreadLease = {
        signal: controller.signal,
        read: async () => {
          controller.signal.throwIfAborted();
          const snapshot = await this.read(client, threadId);
          runId =
            snapshot.lastRun?.status === 'running'
              ? snapshot.lastRun.runId
              : undefined;
          return snapshot;
        },
        beginRun: async (input, guard) => {
          if (input.threadId !== threadId)
            throw new Error('Conversation scope mismatch.');
          const exists = await query(
            'SELECT 1 FROM local_ai_runs WHERE owner_id=$1 AND thread_id=$2 AND run_id=$3',
            [this.ownerId, threadId, input.runId],
          );
          if (exists.rowCount)
            throw new Error('This run ID has already been used.');
          const previous = await query(
            'SELECT t.messages,r.evidence_guard,r.provenance_complete FROM local_ai_threads t LEFT JOIN local_ai_runs r ON r.owner_id=t.owner_id AND r.thread_id=t.id AND r.run_id=t.last_run_id WHERE t.owner_id=$1 AND t.id=$2',
            [this.ownerId, threadId],
          );
          const prior = previous.rows[0];
          const inherited = guard
            ? unionEvidence(prior?.evidence_guard ?? null, guard)
            : null;
          const complete =
            !!guard &&
            (!prior?.messages?.length || prior?.provenance_complete === true);
          await query('BEGIN');
          try {
            await query(
              "INSERT INTO local_ai_runs(owner_id,thread_id,run_id,input,status,evidence_guard,prior_message_ids,provenance_complete) VALUES($1,$2,$3,$4,'running',$5,$6,$7)",
              [
                this.ownerId,
                threadId,
                input.runId,
                JSON.stringify(input),
                inherited ? JSON.stringify(inherited) : null,
                JSON.stringify(
                  (prior?.messages ?? []).map((m: Message) => m.id),
                ),
                complete,
              ],
            );
            await query(
              'UPDATE local_ai_threads SET last_run_id=$3,messages=$4,state=$5,updated_at=now() WHERE owner_id=$1 AND id=$2',
              [
                this.ownerId,
                threadId,
                input.runId,
                JSON.stringify(input.messages),
                JSON.stringify(input.state),
              ],
            );
            await query('COMMIT');
            runId = input.runId;
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
          }
        },
        addEvidenceGuard: async (guard) => {
          if (!runId) throw new Error('No active conversation run.');
          const current = await query(
            'SELECT evidence_guard FROM local_ai_runs WHERE owner_id=$1 AND thread_id=$2 AND run_id=$3',
            [this.ownerId, threadId, runId],
          );
          const combined = unionEvidence(
            current.rows[0]?.evidence_guard ?? null,
            guard,
          );
          await query(
            'UPDATE local_ai_runs SET evidence_guard=$4 WHERE owner_id=$1 AND thread_id=$2 AND run_id=$3',
            [this.ownerId, threadId, runId, JSON.stringify(combined)],
          );
        },
        appendEvent: async (event) => {
          if (!runId) throw new Error('No active conversation run.');
          const result = await query(
            "UPDATE local_ai_runs SET events=events || $4::jsonb WHERE owner_id=$1 AND thread_id=$2 AND run_id=$3 AND status='running'",
            [this.ownerId, threadId, runId, JSON.stringify([event])],
          );
          if (result.rowCount !== 1)
            throw new Error('Conversation run ownership was lost.');
        },
        finishRun: async (messages, state, status, terminal) => {
          if (!runId) throw new Error('No active conversation run.');
          await query('BEGIN');
          try {
            await query(
              'UPDATE local_ai_threads SET messages=$3,state=$4,updated_at=now() WHERE owner_id=$1 AND id=$2',
              [
                this.ownerId,
                threadId,
                JSON.stringify(messages),
                JSON.stringify(state),
              ],
            );
            await query(
              "UPDATE local_ai_runs SET status=$4,events=events || $5::jsonb,evidence_messages=(SELECT coalesce(jsonb_agg(m),'[]'::jsonb) FROM jsonb_array_elements($6::jsonb) m WHERE NOT prior_message_ids ? (m->>'id')) WHERE owner_id=$1 AND thread_id=$2 AND run_id=$3",
              [
                this.ownerId,
                threadId,
                runId,
                status,
                JSON.stringify(terminal ? [terminal] : []),
                JSON.stringify(messages),
              ],
            );
            if (status !== 'interrupted') {
              const answered = new Set(
                messages
                  .filter((m) => m.role === 'tool')
                  .map((m) => m.toolCallId),
              );
              const pending = messages.some(
                (m) =>
                  m.role === 'assistant' &&
                  m.toolCalls?.some((call) => !answered.has(call.id)),
              );
              await query(
                `INSERT INTO memory_evidence(owner_id,id,thread_id,run_id,dot_id,workflow_complete,completed_at)
                SELECT owner_id,$4,thread_id,run_id,evidence_guard->>'originDotId',$5,$6 FROM local_ai_runs
                WHERE owner_id=$1 AND thread_id=$2 AND run_id=$3 AND provenance_complete=true AND evidence_guard IS NOT NULL
                ON CONFLICT(owner_id,thread_id,run_id) DO NOTHING`,
                [
                  this.ownerId,
                  threadId,
                  runId,
                  evidenceHash([this.ownerId, threadId, runId]),
                  status === 'finished' && !pending,
                  Date.now(),
                ],
              );
            }
            await query('COMMIT');
            runId = undefined;
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
          }
        },
        release,
      };
      return lease;
    } catch (error) {
      await release();
      throw error;
    }
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
