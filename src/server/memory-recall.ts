import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  memoryScopeSchema,
  type MemoryItem,
  type SourceRef,
} from '../shared/memory.js';
import {
  evidenceHash,
  type ConversationMemory,
  type IndexCoverage,
  type SourceRecord,
} from './conversation-memory.js';
import type { MemoryStore } from './memory-store.js';
import { MemoryAccess, type RecallPrincipal } from './memory-access.js';
import { MemoryCache } from './memory-cache.js';
export const recallQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    kinds: z
      .array(z.enum(['fact', 'skill', 'episode']))
      .min(1)
      .max(3)
      .optional(),
    scope: memoryScopeSchema.optional(),
    cursor: z.string().max(4000).optional(),
    after: z.number().int().nonnegative().optional(),
    before: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RecallQuery = z.infer<typeof recallQuerySchema>;
export interface RecallMatch {
  id: string;
  kind: 'fact' | 'skill' | 'episode';
  revision?: number;
  title: string;
  text: string;
  createdAt: number;
  sources: SourceRef[];
  sourceIds: string[];
}
export interface RecallPage {
  matches: RecallMatch[];
  coverage: IndexCoverage;
  nextCursor?: string;
}
export interface RecallExcerpt {
  id: string;
  text: string;
  sources: SourceRef[];
  sourceIds: string[];
  nextCursor?: string;
}
type Episodes = Pick<
  ConversationMemory,
  'generation' | 'coverage' | 'searchEpisodes' | 'sourceById' | 'readSource'
>;
interface Cursor {
  key: string;
  memory?: string | null;
  episode?: string | null;
  offset?: number;
}
export class MemoryRecall {
  private secret = randomBytes(32);
  private cache = new MemoryCache<RecallPage>();
  constructor(
    readonly memory: MemoryStore,
    readonly episodes: Episodes,
    readonly access: MemoryAccess,
  ) {}
  private encode(value: Cursor): string {
    const data = Buffer.from(JSON.stringify(value)).toString('base64url');
    return (
      data +
      '.' +
      createHmac('sha256', this.secret).update(data).digest('base64url')
    );
  }
  private decode(cursor: string | undefined, key: string): Cursor | undefined {
    if (!cursor) return;
    try {
      const [data, signature, ...extra] = cursor.split('.');
      const wanted = createHmac('sha256', this.secret).update(data).digest();
      const supplied = Buffer.from(signature, 'base64url');
      if (
        extra.length ||
        wanted.length !== supplied.length ||
        !timingSafeEqual(wanted, supplied)
      )
        throw new Error();
      const parsed = JSON.parse(
        Buffer.from(data, 'base64url').toString(),
      ) as Cursor;
      if (parsed.key !== key) throw new Error();
      return parsed;
    } catch {
      throw new Error('Invalid or stale memory cursor');
    }
  }
  private async permitted(
    principal: RecallPrincipal,
    item: MemoryItem | SourceRecord,
  ): Promise<boolean> {
    if (!this.access.canRead(principal, item)) return false;
    if ('sources' in item)
      for (const ref of item.sources)
        if (!(await this.episodes.readSource(ref))) return false;
    return this.access.canRead(principal, item);
  }
  async search(dotId: string, input: RecallQuery): Promise<RecallPage> {
    const query = recallQuerySchema.parse(input);
    const principal = this.access.forDot(dotId);
    const key = evidenceHash([
      principal,
      { ...query, cursor: undefined },
      this.memory.generation(),
      await this.episodes.generation(),
    ]);
    const position = this.decode(query.cursor, key);
    const cached = this.cache.get(key + (query.cursor ?? ''));
    if (cached) {
      const matches: RecallMatch[] = [];
      for (const match of cached.matches) {
        const item =
          match.kind === 'episode'
            ? await this.episodes.sourceById(match.id)
            : this.memory.get(match.id);
        if (item && (await this.permitted(principal, item)))
          matches.push(match);
      }
      return { ...cached, matches };
    }
    const memoryPage =
      position?.memory === null || query.kinds?.every((k) => k === 'episode')
        ? { items: [] }
        : this.memory.search(
            query,
            principal,
            position?.memory ?? undefined,
            5,
          );
    const allowedThreadIds = this.access.workspace
      .conversations()
      .filter((t) => t.dotId === dotId)
      .map((t) => t.id);
    const episodePage =
      position?.episode === null ||
      (query.kinds && !query.kinds.includes('episode')) ||
      (query.scope && (query.scope.kind !== 'dot' || query.scope.id !== dotId))
        ? { matches: [], coverage: await this.episodes.coverage(dotId) }
        : await this.episodes.searchEpisodes({
            allowedThreadIds,
            query: query.query,
            cursor: position?.episode ?? undefined,
            limit: 5,
            after: query.after,
            before: query.before,
          });
    const matches: RecallMatch[] = [];
    for (const item of memoryPage.items)
      if (await this.permitted(principal, item))
        matches.push({
          id: item.id,
          kind: item.kind,
          revision: item.revision,
          title: item.title,
          text: item.text.slice(0, 600),
          createdAt: item.createdAt,
          sources: item.sources,
          sourceIds: item.sources.map((ref) =>
            evidenceHash([
              principal.ownerId,
              ref.threadId,
              ref.runId,
              ref.messageIds[0],
              ref.start ?? 0,
            ]),
          ),
        });
    for (const item of episodePage.matches)
      if (await this.permitted(principal, item))
        matches.push({
          id: item.id,
          kind: 'episode',
          title: `${item.role} · ${new Date(item.createdAt).toISOString()}`,
          text: item.text.slice(0, 600),
          createdAt: item.createdAt,
          sources: [item.source],
          sourceIds: [item.id],
        });
    const nextMemory =
      'nextCursor' in memoryPage ? memoryPage.nextCursor : undefined;
    const nextEpisode =
      'nextCursor' in episodePage ? episodePage.nextCursor : undefined;
    const result: RecallPage = {
      matches,
      coverage: episodePage.coverage,
      ...(nextMemory || nextEpisode
        ? {
            nextCursor: this.encode({
              key,
              memory: nextMemory ?? null,
              episode: nextEpisode ?? null,
            }),
          }
        : {}),
    };
    this.cache.set(key + (query.cursor ?? ''), result);
    return result;
  }
  private excerpt(
    principal: RecallPrincipal,
    id: string,
    text: string,
    sources: SourceRef[],
    revision: string,
    cursor?: string,
  ): RecallExcerpt {
    const key = evidenceHash([principal, id, revision]);
    const offset = this.decode(cursor, key)?.offset ?? 0;
    let end = offset,
      bytes = 0;
    for (const char of text.slice(offset)) {
      const length = Buffer.byteLength(char);
      if (bytes + length > 2500) break;
      bytes += length;
      end += char.length;
    }
    return {
      id,
      text: text.slice(offset, end),
      sources,
      sourceIds: sources.map((ref) =>
        evidenceHash([
          principal.ownerId,
          ref.threadId,
          ref.runId,
          ref.messageIds[0],
          ref.start ?? 0,
        ]),
      ),
      ...(end < text.length
        ? { nextCursor: this.encode({ key, offset: end }) }
        : {}),
    };
  }
  async read(
    dotId: string,
    id: string,
    cursor?: string,
  ): Promise<RecallExcerpt> {
    const principal = this.access.forDot(dotId),
      item = this.memory.get(id);
    if (!item) return this.readSource(dotId, id, cursor);
    if (!(await this.permitted(principal, item)))
      throw new Error('Memory access unavailable');
    return this.excerpt(
      principal,
      id,
      item.text,
      item.sources,
      String(item.revision),
      cursor,
    );
  }
  async readSource(
    dotId: string,
    id: string,
    cursor?: string,
  ): Promise<RecallExcerpt> {
    const principal = this.access.forDot(dotId),
      item = await this.episodes.sourceById(id);
    if (!item || !(await this.permitted(principal, item)))
      throw new Error('Memory access unavailable');
    return this.excerpt(
      principal,
      id,
      item.text,
      [item.source],
      item.source.contentHash,
      cursor,
    );
  }
}
