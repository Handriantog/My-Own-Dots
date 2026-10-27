import type { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { MessageSchema, type Message } from '@ag-ui/core';
import { sourceRefSchema } from '../../shared/memory.js';
import { evidenceHash } from '../conversation-memory.js';

/** Validate host metadata for every accepted archive engine and historical schema. */
export function validateCallHistory(
  db: DatabaseSync,
  ownerId: string,
  signal: AbortSignal,
) {
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='call_history'",
      )
      .get()
  ) {
    const seen = new Set<string>();
    for (const row of db
      .prepare(
        'SELECT h.*,c.threadId,b.ownerId FROM call_history h LEFT JOIN calls c ON c.id=h.callId LEFT JOIN thread_bindings b ON b.id=c.threadId',
      )
      .iterate()) {
      signal.throwIfAborted();
      const ids: unknown = JSON.parse(String(row.messageIds));
      if (
        row.ownerId !== ownerId ||
        !Array.isArray(ids) ||
        ids.some((id) => typeof id !== 'string' || !id.length) ||
        new Set(ids).size !== ids.length ||
        (row.afterMessageId !== null &&
          (typeof row.afterMessageId !== 'string' ||
            !row.afterMessageId.length))
      )
        throw new Error('Invalid call history membership');
      for (const id of ids) {
        const key = JSON.stringify([row.threadId, id]);
        if (seen.has(key))
          throw new Error('Conflicting call history membership');
        seen.add(key);
      }
    }
  }
}

/** Offline validation follows an exact schema allowlist. It never executes archived SQL. */
export async function validateUnifiedGraph(
  db: DatabaseSync,
  ownerId: string,
  signal: AbortSignal,
  schema = 3,
) {
  validateCallHistory(db, ownerId, signal);
  const checks = [
    ...(schema >= 6
      ? [
          `SELECT 1 FROM voice_input_receipts r JOIN conversation_threads t ON t.owner_id=r.ownerId AND t.id=r.parentThreadId JOIN calls c ON c.id=r.callId WHERE t.agent_id<>r.dotId OR c.threadId<>r.parentThreadId LIMIT 1`,
        ]
      : []),
    ...(schema >= 3
      ? [
          `SELECT 1 FROM voice_delegations j JOIN conversation_threads p ON p.owner_id=j.owner_id AND p.id=j.parent_thread_id JOIN conversation_threads w ON w.owner_id=j.owner_id AND w.id=j.worker_thread_id JOIN calls c ON c.id=j.call_id WHERE p.agent_id<>j.dot_id OR w.agent_id<>j.dot_id OR c.threadId<>j.parent_thread_id LIMIT 1`,
          `SELECT 1 FROM voice_delegations j JOIN conversation_messages m ON m.owner_id=j.owner_id AND m.thread_id=j.parent_thread_id AND m.message_id=j.source_message_id JOIN conversation_message_versions v ON v.owner_id=m.owner_id AND v.thread_id=m.thread_id AND v.message_id=m.message_id AND v.hash=m.hash WHERE json_extract(v.value,'$.role') IS NOT 'user' OR json_extract(v.value,'$.content') IS NOT j.source_text LIMIT 1`,
          `SELECT 1 FROM voice_delegations j JOIN conversation_messages m ON m.owner_id=j.owner_id AND m.thread_id=j.parent_thread_id AND m.message_id=j.receipt_message_id JOIN conversation_message_versions v ON v.owner_id=m.owner_id AND v.thread_id=m.thread_id AND v.message_id=m.message_id AND v.hash=m.hash WHERE json_extract(v.value,'$.role') IS NOT 'assistant' LIMIT 1`,
        ]
      : []),
    `SELECT 1 FROM conversation_threads t LEFT JOIN dots d ON d.id=t.agent_id WHERE d.id IS NULL LIMIT 1`,
    `SELECT 1 FROM conversation_threads t WHERE t.last_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversation_runs r WHERE r.owner_id=t.owner_id AND r.thread_id=t.id AND r.run_id=t.last_run_id) LIMIT 1`,
    `SELECT 1 FROM thread_bindings b LEFT JOIN conversation_threads t ON t.owner_id=b.ownerId AND t.id=b.id WHERE t.id IS NULL OR t.agent_id<>b.dotId LIMIT 1`,
    `SELECT 1 FROM conversation_threads t WHERE NOT EXISTS(SELECT 1 FROM thread_bindings b WHERE b.ownerId=t.owner_id AND b.id=t.id AND b.dotId=t.agent_id) AND NOT EXISTS(SELECT 1 FROM page_threads p WHERE p.threadId=t.id AND p.dotId=t.agent_id) LIMIT 1`,
    `SELECT 1 FROM memory_evidence e JOIN conversation_threads t ON t.owner_id=e.owner_id AND t.id=e.thread_id WHERE e.dot_id<>t.agent_id OR (e.processed_job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memory_jobs j WHERE j.owner_id=e.owner_id AND j.id=e.processed_job_id AND j.dot_id=e.dot_id)) LIMIT 1`,
    `SELECT 1 FROM memory_jobs j LEFT JOIN dots d ON d.id=j.dot_id WHERE d.id IS NULL OR (j.thread_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversation_threads t WHERE t.owner_id=j.owner_id AND t.id=j.thread_id AND t.agent_id=j.dot_id)) LIMIT 1`,
    `SELECT 1 FROM memory_jobs j,json_each(j.source_ids) s WHERE j.kind='dream' AND NOT EXISTS(SELECT 1 FROM memory_episode_chunks c JOIN conversation_threads t ON t.owner_id=c.owner_id AND t.id=c.thread_id WHERE c.owner_id=j.owner_id AND c.source_id=s.value AND t.agent_id=j.dot_id) LIMIT 1`,
    `SELECT 1 FROM memory_processed_sources p WHERE NOT EXISTS(SELECT 1 FROM memory_episode_chunks c WHERE c.owner_id=p.owner_id AND c.source_id=p.source_id) OR NOT EXISTS(SELECT 1 FROM memory_jobs j WHERE j.owner_id=p.owner_id AND j.id=p.job_id) LIMIT 1`,
    `SELECT 1 FROM conversation_runs r WHERE json_extract(r.input,'$.threadId') IS NOT r.thread_id OR json_extract(r.input,'$.runId') IS NOT r.run_id OR r.next_event_seq<>(SELECT count(*) FROM conversation_events e WHERE e.owner_id=r.owner_id AND e.thread_id=r.thread_id AND e.run_id=r.run_id) LIMIT 1`,
    `SELECT 1 FROM conversation_events e WHERE json_extract(e.value,'$.type') IS NOT e.type OR (json_extract(e.value,'$.threadId') IS NOT NULL AND json_extract(e.value,'$.threadId')<>e.thread_id) OR (json_extract(e.value,'$.runId') IS NOT NULL AND json_extract(e.value,'$.runId')<>e.run_id) OR e.terminal<>(e.type IN ('RUN_FINISHED','RUN_ERROR')) LIMIT 1`,
    `SELECT 1 FROM conversation_messages GROUP BY owner_id,thread_id HAVING min(seq)<>0 OR max(seq)<>count(*)-1 LIMIT 1`,
    `SELECT 1 FROM conversation_run_messages GROUP BY owner_id,thread_id,run_id,kind HAVING min(seq)<>0 OR max(seq)<>count(*)-1 LIMIT 1`,
    `SELECT 1 FROM conversation_events GROUP BY owner_id,thread_id,run_id HAVING min(seq)<>0 OR max(seq)<>count(*)-1 LIMIT 1`,
  ];
  for (const query of checks) {
    signal.throwIfAborted();
    if (db.prepare(query).get())
      throw new Error('Invalid unified workspace reference or binding');
    await setImmediate();
  }
  let checked = 0;
  for (const row of db
    .prepare('SELECT message_id,hash,value FROM conversation_message_versions')
    .iterate()) {
    signal.throwIfAborted();
    const message = JSON.parse(String(row.value));
    if (
      !MessageSchema.safeParse(message).success ||
      message.id !== row.message_id ||
      evidenceHash(message) !== row.hash
    )
      throw new Error('Invalid unified message reference or hash');
    if (++checked % 100 === 0) await setImmediate();
  }
  for (const row of db
    .prepare(
      `SELECT c.*,v.value AS message,r.evidence_guard FROM memory_episode_chunks c
    LEFT JOIN conversation_run_messages m ON m.owner_id=c.owner_id AND m.thread_id=c.thread_id AND m.run_id=c.run_id AND m.kind='evidence' AND m.message_id=c.message_id
    LEFT JOIN conversation_message_versions v ON v.owner_id=m.owner_id AND v.thread_id=m.thread_id AND v.message_id=m.message_id AND v.hash=m.hash
    JOIN conversation_runs r ON r.owner_id=c.owner_id AND r.thread_id=c.thread_id AND r.run_id=c.run_id`,
    )
    .iterate()) {
    signal.throwIfAborted();
    const source = sourceRefSchema.parse(JSON.parse(String(row.source)));
    const message: Message | null =
      row.message === null ? null : JSON.parse(String(row.message));
    const content =
      message &&
      (typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? ''));
    const text =
      content ||
      (message?.role === 'assistant' && message.toolCalls?.length
        ? JSON.stringify(message.toolCalls)
        : '');
    if (
      !message ||
      row.owner_id !== ownerId ||
      source.threadId !== row.thread_id ||
      source.runId !== row.run_id ||
      source.messageIds.length !== 1 ||
      source.messageIds[0] !== row.message_id ||
      source.contentHash !== row.content_hash ||
      evidenceHash(message) !== row.content_hash ||
      row.source_id !==
        evidenceHash([
          ownerId,
          row.thread_id,
          row.run_id,
          row.message_id,
          row.start_offset,
        ]) ||
      source.start !== row.start_offset ||
      source.end === undefined ||
      source.end > text.length ||
      source.end <= source.start ||
      source.messageLength !== text.length ||
      row.text !== text.slice(source.start, source.end) ||
      row.role !== message.role ||
      !isDeepStrictEqual(source.guard, JSON.parse(String(row.evidence_guard)))
    )
      throw new Error('Invalid unified source evidence reference');
    if (++checked % 100 === 0) await setImmediate();
  }
}
