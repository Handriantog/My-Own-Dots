import { z } from 'zod';
import {
  fetchGitHub,
  type GitHubFetch,
} from '../../../shared/abilities/github.js';
import {
  libraryIdSchema,
  sourceCommitSchema,
  type AbilityLibrary,
} from '../../../shared/abilities/library.js';
const repository = 'Handriantog/My-Own-Dot-Abilities';
const api = `https://api.github.com/repos/${repository}`;
const web = `https://github.com/${repository}`;
const maxDocumentBytes = 65536;
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const entry = z
  .strictObject({
    id: libraryIdSchema,
    name: z.string().min(1).max(200),
    path: z.string().max(200),
    status: z.enum(['planned', 'development', 'released']),
    version: version.nullable(),
    license: z.string().min(1).max(100),
  })
  .refine(
    (e) =>
      e.path === `abilities/${e.id}` &&
      (e.status !== 'released' || e.version !== null) &&
      (e.status !== 'planned' || e.version === null),
  );
const catalogSchema = z
  .strictObject({
    catalogVersion: z.literal(1),
    abilities: z.array(entry).max(200),
  })
  .refine(
    (c) => new Set(c.abilities.map((e) => e.id)).size === c.abilities.length,
  );
/** Fixed public collection. Metadata never authorizes an install or execution. */
export class GitHubAbilityLibrary {
  private cached?: { value: AbilityLibrary; expires: number };
  constructor(private readonly fetch: GitHubFetch = fetchGitHub) {}
  private async content(
    path: string,
    commit: string,
    signal: AbortSignal,
  ): Promise<string> {
    const bytes = await this.fetch(
      `${api}/contents/${path}?ref=${commit}`,
      maxDocumentBytes * 2,
      signal,
    );
    if (bytes.length > maxDocumentBytes * 2)
      throw Error('Documentation exceeds limit');
    const file = z
      .object({
        type: z.literal('file'),
        encoding: z.literal('base64'),
        size: z.number().int().min(0).max(maxDocumentBytes),
        content: z.string().max(maxDocumentBytes * 2),
      })
      .parse(JSON.parse(bytes.toString('utf8')));
    const encoded = file.content.replace(/\s/g, ''),
      decoded = Buffer.from(encoded, 'base64');
    if (decoded.length !== file.size || decoded.toString('base64') !== encoded)
      throw Error('Invalid documentation');
    return decoded.toString('utf8');
  }
  async browse(refresh: boolean, signal: AbortSignal): Promise<AbilityLibrary> {
    signal.throwIfAborted();
    if (!refresh && this.cached && this.cached.expires > Date.now())
      return structuredClone(this.cached.value);
    const bytes = await this.fetch(`${api}/git/ref/heads/main`, 131072, signal);
    if (bytes.length > 131072) throw Error('Invalid source revision');
    const {
      object: { sha },
    } = z
      .object({
        object: z.object({
          type: z.literal('commit'),
          sha: sourceCommitSchema,
        }),
      })
      .parse(JSON.parse(bytes.toString('utf8')));
    const catalog = catalogSchema.parse(
      JSON.parse(await this.content('catalog.json', sha, signal)),
    );
    const value: AbilityLibrary = {
      sourceCommit: sha,
      entries: catalog.abilities.map((e) => ({
        id: e.id,
        name: e.name,
        publisher: 'Handriantog',
        license: e.license,
        status: e.status,
        version: e.version,
        sourceUrl: `${web}/tree/${sha}/${e.path}`,
        ...(e.status === 'released' && e.version
          ? {
              descriptorUrl: `${web}/releases/download/${encodeURIComponent(`${e.id}/v${e.version}`)}/${e.id}-${e.version}.json`,
            }
          : {}),
      })),
    };
    this.cached = { value, expires: Date.now() + 300000 };
    return structuredClone(value);
  }
  async documentation(
    id: string,
    commit: string,
    signal: AbortSignal,
  ): Promise<string> {
    libraryIdSchema.parse(id);
    sourceCommitSchema.parse(commit);
    signal.throwIfAborted();
    return this.content(`abilities/${id}/README.md`, commit, signal);
  }
}
