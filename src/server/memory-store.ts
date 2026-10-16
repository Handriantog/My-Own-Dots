import { memoryDefaults } from './memory-config.js';
import {
  memorySettingsSchema,
  memorySettingsPatchSchema,
  type MemorySettings,
  type MemorySettingsPatch,
} from '../shared/memory.js';
import { MemoryHistory } from './memory-history.js';
import type { Message } from '@ag-ui/core';
import type { SourceRef } from '../shared/memory.js';
import type { RecallQuery } from './memory-recall.js';
import type { RecallPrincipal } from './memory-access.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Memory } from '../shared/types.js';
import {
  memoryCreateSchema,
  memoryListQuerySchema,
  memoryPatchSchema,
  type MemoryCreate,
  type MemoryItem,
  type MemoryListQuery,
  type MemoryPage,
  type MemoryPatch,
} from '../shared/memory.js';

/** Curated memory is owner-scoped. The workspace owns this connection. */
export class MemoryStore {
  readonly history: MemoryHistory;
  private depth = 0;
  private pinValidator?: (item: MemoryItem) => void;
  constructor(
    private db: DatabaseSync,
    readonly ownerId: string,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, scopeKind TEXT NOT NULL,
        scopeId TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        revision INTEGER NOT NULL, updatedAt INTEGER NOT NULL, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_items_owner ON memory_items(ownerId, status, updatedAt, id);
      CREATE INDEX IF NOT EXISTS memory_items_scope ON memory_items(ownerId, scopeKind, scopeId);
      CREATE TABLE IF NOT EXISTS memory_revisions (
        itemId TEXT NOT NULL, ownerId TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(itemId, revision)
      );
      CREATE TABLE IF NOT EXISTS memory_sources (
        itemId TEXT NOT NULL, ownerId TEXT NOT NULL, sourceKey TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(itemId, sourceKey)
      );
      CREATE TABLE IF NOT EXISTS memory_settings (ownerId TEXT NOT NULL, dotId TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(ownerId,dotId));
      CREATE TABLE IF NOT EXISTS memory_meta (ownerId TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(ownerId,key));
    `);
    const hasFts = db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='memory_fts'")
      .get();
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(itemId UNINDEXED,title,text);
      CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_fts VALUES(new.id,json_extract(new.value,'$.title'),json_extract(new.value,'$.text')); END;
      CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory_items BEGIN
        DELETE FROM memory_fts WHERE itemId=old.id;
        INSERT INTO memory_fts VALUES(new.id,json_extract(new.value,'$.title'),json_extract(new.value,'$.text')); END;
      CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_items BEGIN DELETE FROM memory_fts WHERE itemId=old.id; END;`);
    this.history = new MemoryHistory(db, ownerId);
    if (!hasFts)
      db.exec(
        "INSERT INTO memory_fts SELECT id,json_extract(value,'$.title'),json_extract(value,'$.text') FROM memory_items",
      );
  }
  settings(dotId: string, now = Date.now()): MemorySettings {
    const row = this.db
      .prepare('SELECT value FROM memory_settings WHERE ownerId=? AND dotId=?')
      .get(this.ownerId, dotId);
    if (row) return memorySettingsSchema.parse(JSON.parse(String(row.value)));
    const { inputTokenLimit, pinnedTokenLimit, ...timing } = memoryDefaults;
    void inputTokenLimit;
    void pinnedTokenLimit;
    const settings = memorySettingsSchema.parse({
      ...timing,
      revision: 1,
      createdAt: now,
      enabledAt: null,
      learningEnabled: false,
      autoCompact: true,
      autoDream: true,
      publicationPolicy: 'hybrid',
    });
    this.db
      .prepare('INSERT OR IGNORE INTO memory_settings VALUES (?,?,?)')
      .run(this.ownerId, dotId, JSON.stringify(settings));
    return this.settings(dotId, now);
  }
  updateSettings(
    dotId: string,
    revision: number,
    patch: MemorySettingsPatch,
    now = Date.now(),
  ): MemorySettings {
    const parsed = memorySettingsPatchSchema.parse(patch);
    return this.atomic(() => {
      const old = this.settings(dotId, now);
      if (old.revision !== revision)
        throw new Error('Memory settings revision conflict');
      const settings = memorySettingsSchema.parse({
        ...old,
        ...parsed,
        revision: revision + 1,
        enabledAt:
          parsed.learningEnabled === true && !old.learningEnabled
            ? now
            : old.enabledAt,
      });
      this.db
        .prepare(
          'UPDATE memory_settings SET value=? WHERE ownerId=? AND dotId=?',
        )
        .run(JSON.stringify(settings), this.ownerId, dotId);
      return settings;
    });
  }
  sourceSuppressed(ref: SourceRef): boolean {
    return this.history.sourceSuppressed(ref);
  }
  suppressionGeneration(): number {
    return this.history.suppressionGeneration();
  }
  maskMessages(threadId: string, messages: Message[]): Message[] {
    return this.history.maskMessages(threadId, messages);
  }
  search(
    query: RecallQuery,
    principal: RecallPrincipal,
    cursor?: string,
    limit = 5,
  ): MemoryPage {
    const words = query.query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!words.length) return { items: [] };
    const offset = Number(cursor ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error('Invalid memory cursor');
    const match = words
      .map((word) => '"' + word.replaceAll('"', '""') + '"')
      .join(' AND ');
    const clauses = [
      'memory_fts MATCH ?',
      'm.ownerId=?',
      "m.status='active'",
      "(json_extract(m.value,'$.expiresAt') IS NULL OR json_extract(m.value,'$.expiresAt')>?)",
      "(m.scopeKind='owner' OR (m.scopeKind='dot' AND m.scopeId=?) OR (m.scopeKind='space' AND m.scopeId IN (SELECT value FROM json_each(?))))",
    ];
    const args: SQLInputValue[] = [
      match,
      this.ownerId,
      Date.now(),
      principal.dotId,
      JSON.stringify(principal.spaceIds),
    ];
    if (query.kinds) {
      clauses.push('m.kind IN (SELECT value FROM json_each(?))');
      args.push(JSON.stringify(query.kinds));
    }
    if (query.scope) {
      clauses.push('m.scopeKind=? AND m.scopeId=?');
      args.push(
        query.scope.kind,
        query.scope.kind === 'owner' ? '' : query.scope.id,
      );
    }
    const rows = this.db
      .prepare(
        `SELECT m.value FROM memory_fts JOIN memory_items m ON m.id=memory_fts.itemId WHERE ${clauses.join(' AND ')} ORDER BY bm25(memory_fts),m.id LIMIT ? OFFSET ?`,
      )
      .all(...args, limit + 1, offset);
    return {
      items: rows
        .slice(0, limit)
        .map((row) => JSON.parse(String(row.value)) as MemoryItem),
      ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
    };
  }
  atomic<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }
  generation(): number {
    return Number(
      this.db
        .prepare(
          "SELECT value FROM memory_meta WHERE ownerId=? AND key='generation'",
        )
        .get(this.ownerId)?.value ?? 0,
    );
  }
  setPinValidator(validate: (item: MemoryItem) => void) {
    this.pinValidator = validate;
  }
  pinned(): MemoryItem[] {
    return this.db
      .prepare(
        "SELECT value FROM memory_items WHERE ownerId=? AND status='active' AND json_extract(value,'$.pinned')=1",
      )
      .all(this.ownerId)
      .map((row) => JSON.parse(String(row.value)) as MemoryItem);
  }
  private save(item: MemoryItem) {
    this.pinValidator?.(item);
    this.db
      .prepare(
        `INSERT INTO memory_items VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET scopeKind=excluded.scopeKind, scopeId=excluded.scopeId,
        kind=excluded.kind,status=excluded.status,revision=excluded.revision,updatedAt=excluded.updatedAt,value=excluded.value
      WHERE memory_items.ownerId=excluded.ownerId`,
      )
      .run(
        item.id,
        this.ownerId,
        item.scope.kind,
        item.scope.kind === 'owner' ? '' : item.scope.id,
        item.kind,
        item.status,
        item.revision,
        item.updatedAt,
        JSON.stringify(item),
      );
    this.db
      .prepare('INSERT INTO memory_revisions VALUES (?,?,?,?)')
      .run(item.id, this.ownerId, item.revision, JSON.stringify(item));
    this.db
      .prepare('DELETE FROM memory_sources WHERE itemId=? AND ownerId=?')
      .run(item.id, this.ownerId);
    for (const source of item.sources)
      this.db
        .prepare('INSERT OR IGNORE INTO memory_sources VALUES (?,?,?,?)')
        .run(item.id, this.ownerId, source.contentHash, JSON.stringify(source));
    this.db
      .prepare(
        "INSERT INTO memory_meta VALUES (?,'generation','1') ON CONFLICT(ownerId,key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
      )
      .run(this.ownerId);
    return item;
  }
  importLegacy(rows: Memory[]): void {
    this.atomic(() => {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM memory_meta WHERE ownerId=? AND key='legacy-import'",
          )
          .get(this.ownerId)
      )
        return;
      for (const row of rows) {
        if (!row.id || !row.text || !Number.isFinite(row.createdAt))
          throw new Error('Invalid legacy memory');
        if (this.get(row.id)) continue;
        // Legacy content predates the manual-write size limit; preserve it intact.
        this.save({
          ...row,
          ownerId: this.ownerId,
          scope: { kind: 'owner' },
          kind: 'fact',
          status: 'active',
          title: row.text.slice(0, 120),
          pinned: false,
          sources: [],
          revision: 1,
          updatedAt: row.createdAt,
          expiresAt: null,
          supersedesId: null,
        });
      }
      this.db
        .prepare("INSERT INTO memory_meta VALUES (?,'legacy-import','1')")
        .run(this.ownerId);
    });
  }
  create(input: MemoryCreate): MemoryItem {
    const data = memoryCreateSchema.parse(input);
    const now = Date.now();
    return this.atomic(() =>
      this.save({
        ...data,
        id: randomUUID(),
        ownerId: this.ownerId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  get(id: string): MemoryItem | undefined {
    const row = this.db
      .prepare('SELECT value FROM memory_items WHERE id=? AND ownerId=?')
      .get(id, this.ownerId);
    return row ? (JSON.parse(String(row.value)) as MemoryItem) : undefined;
  }
  listOwner(input: MemoryListQuery = {}): MemoryPage {
    const query = memoryListQuerySchema.parse(input);
    const where = ['ownerId=?'];
    const args: SQLInputValue[] = [this.ownerId];
    for (const name of ['status', 'kind'] as const)
      if (query[name]) {
        where.push(`${name}=?`);
        args.push(query[name]);
      }
    if (query.scope) {
      where.push('scopeKind=?', 'scopeId=?');
      args.push(
        query.scope.kind,
        query.scope.kind === 'owner' ? '' : query.scope.id,
      );
    }
    const offset = Number(query.cursor ?? 0);
    if (!Number.isSafeInteger(offset)) throw new Error('Invalid cursor');
    const rows = this.db
      .prepare(
        `SELECT value FROM memory_items WHERE ${where.join(' AND ')} ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?`,
      )
      .all(...args, query.limit + 1, offset);
    return {
      items: rows
        .slice(0, query.limit)
        .map((r) => JSON.parse(String(r.value)) as MemoryItem),
      ...(rows.length > query.limit
        ? { nextCursor: String(offset + query.limit) }
        : {}),
    };
  }
  edit(id: string, expectedRevision: number, patch: MemoryPatch): MemoryItem {
    const parsed = memoryPatchSchema.parse(patch);
    return this.atomic(() => {
      const item = this.get(id);
      if (!item) throw new Error('Memory not found');
      if (item.revision !== expectedRevision)
        throw new Error('Memory revision conflict');
      const preserveLegacy =
        item.kind === 'fact' &&
        item.text.length > 2000 &&
        (parsed.text === undefined || parsed.text === item.text) &&
        (parsed.kind === undefined || parsed.kind === 'fact');
      const data = memoryCreateSchema.parse({
        scope: item.scope,
        kind: item.kind,
        status: item.status,
        title: item.title,
        text: preserveLegacy ? item.text.slice(0, 2000) : item.text,
        pinned: item.pinned,
        sources: item.sources,
        expiresAt: item.expiresAt,
        supersedesId: item.supersedesId,
        ...parsed,
      });
      if (preserveLegacy) data.text = item.text;
      return this.save({
        ...item,
        ...data,
        revision: item.revision + 1,
        updatedAt: Date.now(),
      });
    });
  }
  revisions(id: string): MemoryItem[] {
    return this.db
      .prepare(
        'SELECT value FROM memory_revisions WHERE itemId=? AND ownerId=? ORDER BY revision',
      )
      .all(id, this.ownerId)
      .map((r) => JSON.parse(String(r.value)) as MemoryItem);
  }
}
