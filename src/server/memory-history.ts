import type { DatabaseSync } from 'node:sqlite';
import type { Message } from '@ag-ui/core';
import { evidenceHash } from './conversation-memory.js';
import type {
  ApplyReceipt,
  DreamChange,
  MemoryItem,
  MemoryScope,
  RestorePreview,
  SourceRef,
} from '../shared/memory.js';
/** Audit writes participate in MemoryStore.atomic; this class never owns the connection. */
export class MemoryHistory {
  constructor(
    private db: DatabaseSync,
    private ownerId: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_receipts(ownerId TEXT NOT NULL,id TEXT NOT NULL,jobId TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(ownerId,id),UNIQUE(ownerId,jobId));
      CREATE TABLE IF NOT EXISTS memory_pending_operations(ownerId TEXT NOT NULL,itemId TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(ownerId,itemId));
      CREATE TABLE IF NOT EXISTS memory_suppressions(ownerId TEXT NOT NULL,sourceKey TEXT NOT NULL,threadId TEXT NOT NULL,messageId TEXT NOT NULL,value TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(ownerId,sourceKey,messageId));
      CREATE INDEX IF NOT EXISTS memory_suppressions_thread ON memory_suppressions(ownerId,threadId,messageId);
      CREATE TABLE IF NOT EXISTS memory_source_grants(ownerId TEXT NOT NULL,itemId TEXT NOT NULL,sourceKey TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(ownerId,itemId,sourceKey));
      CREATE TABLE IF NOT EXISTS memory_restore_previews(ownerId TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(ownerId,id));`);
  }
  receipt(key: string): ApplyReceipt | undefined {
    const row = this.db
      .prepare(
        'SELECT value FROM memory_receipts WHERE ownerId=? AND (id=? OR jobId=?)',
      )
      .get(this.ownerId, key, key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  receipts(dotId?: string): ApplyReceipt[] {
    return this.db
      .prepare(
        "SELECT value FROM memory_receipts WHERE ownerId=? AND (? IS NULL OR json_extract(value,'$.dotId')=?) ORDER BY rowid DESC LIMIT 100",
      )
      .all(this.ownerId, dotId ?? null, dotId ?? null)
      .map((r) => JSON.parse(String(r.value)));
  }
  saveReceipt(receipt: ApplyReceipt): void {
    this.db
      .prepare('INSERT INTO memory_receipts VALUES (?,?,?,?)')
      .run(this.ownerId, receipt.id, receipt.jobId, JSON.stringify(receipt));
  }
  operation(id: string): DreamChange | undefined {
    const row = this.db
      .prepare(
        'SELECT value FROM memory_pending_operations WHERE ownerId=? AND itemId=?',
      )
      .get(this.ownerId, id);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  saveOperation(id: string, change: DreamChange): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO memory_pending_operations VALUES (?,?,?)',
      )
      .run(this.ownerId, id, JSON.stringify(change));
  }
  suppressionGeneration(): number {
    return Number(
      this.db
        .prepare(
          "SELECT value FROM memory_meta WHERE ownerId=? AND key='suppression-generation'",
        )
        .get(this.ownerId)?.value ?? 0,
    );
  }
  suppress(sources: SourceRef[], reason: string): void {
    for (const source of sources)
      for (const messageId of source.messageIds)
        this.db
          .prepare(
            'INSERT OR IGNORE INTO memory_suppressions VALUES (?,?,?,?,?,?)',
          )
          .run(
            this.ownerId,
            evidenceHash(source),
            source.threadId,
            messageId,
            JSON.stringify(source),
            reason,
          );
    this.db
      .prepare(
        "INSERT INTO memory_meta VALUES (?,'suppression-generation','1') ON CONFLICT(ownerId,key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
      )
      .run(this.ownerId);
  }
  sourceSuppressed(ref: SourceRef): boolean {
    return ref.messageIds.some((id) =>
      this.db
        .prepare(
          'SELECT value FROM memory_suppressions WHERE ownerId=? AND threadId=? AND messageId=?',
        )
        .all(this.ownerId, ref.threadId, id)
        .some((row) => {
          const old = JSON.parse(String(row.value)) as SourceRef;
          return (
            old.contentHash === ref.contentHash &&
            (old.start ?? 0) < (ref.end ?? Infinity) &&
            (ref.start ?? 0) < (old.end ?? Infinity)
          );
        }),
    );
  }
  maskMessages(threadId: string, messages: Message[]): Message[] {
    const suppressed = this.db
      .prepare(
        'SELECT value FROM memory_suppressions WHERE ownerId=? AND threadId=?',
      )
      .all(this.ownerId, threadId)
      .map((r) => JSON.parse(String(r.value)) as SourceRef);
    return messages.map((original) => {
      const spans = suppressed.filter(
        (s) =>
          s.messageIds.includes(original.id) &&
          s.contentHash === evidenceHash(original),
      );
      if (!spans.length) return structuredClone(original);
      const message = structuredClone(original);
      if (typeof message.content === 'string') {
        let text = message.content;
        // Merge overlaps before replacement; offsets refer to the original text.
        const ranges = spans
          .map((s) => [s.start ?? 0, s.end ?? text.length])
          .sort((a, b) => a[0] - b[0]);
        const merged: number[][] = [];
        for (const span of ranges) {
          const last = merged.at(-1);
          if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
          else merged.push(span);
        }
        for (const [start, end] of merged.reverse())
          text =
            text.slice(0, start) +
            '[Memory content withheld]' +
            text.slice(end);
        message.content = text;
      } else if (message.role === 'assistant') {
        message.content = '[Memory content withheld]';
        message.toolCalls = message.toolCalls?.map((call) => ({
          ...call,
          function: {
            ...call.function,
            arguments: '{"memoryContentWithheld":true}',
          },
        }));
      }
      return message;
    });
  }
  grant(item: MemoryItem, scope: MemoryScope): void {
    this.db
      .prepare('DELETE FROM memory_source_grants WHERE ownerId=? AND itemId=?')
      .run(this.ownerId, item.id);
    if (scope.kind === 'dot') return;
    for (const ref of item.sources)
      this.db
        .prepare('INSERT INTO memory_source_grants VALUES (?,?,?,?)')
        .run(this.ownerId, item.id, evidenceHash(ref), JSON.stringify(ref));
  }
  hasGrant(ref: SourceRef, dotId: string, spaceIds: string[]): boolean {
    const rows = this.db
      .prepare(
        "SELECT m.value FROM memory_source_grants g JOIN memory_items m ON m.ownerId=g.ownerId AND m.id=g.itemId WHERE g.ownerId=? AND g.sourceKey=? AND m.status='active'",
      )
      .all(this.ownerId, evidenceHash(ref));
    return rows.some((row) => {
      const item = JSON.parse(String(row.value)) as MemoryItem;
      return (
        (item.expiresAt === null || item.expiresAt > Date.now()) &&
        (item.scope.kind === 'owner' ||
          (item.scope.kind === 'dot' && item.scope.id === dotId) ||
          (item.scope.kind === 'space' && spaceIds.includes(item.scope.id)))
      );
    });
  }
  savePreview(preview: RestorePreview): void {
    this.db
      .prepare('INSERT INTO memory_restore_previews VALUES (?,?,?)')
      .run(this.ownerId, preview.id, JSON.stringify(preview));
  }
  preview(id: string): RestorePreview | undefined {
    const row = this.db
      .prepare(
        'SELECT value FROM memory_restore_previews WHERE ownerId=? AND id=?',
      )
      .get(this.ownerId, id);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
}
