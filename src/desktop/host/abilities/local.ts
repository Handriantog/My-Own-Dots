import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AbilityFailure } from '../../../shared/abilities/bridge.js';
import { abilityLimits } from '../../../shared/abilities/limits.js';
import { parseReleaseDescriptor } from '../../../shared/abilities/manifest.js';
import type { InstallReview } from '../../../shared/abilities/types.js';
import {
  fetchGitHub,
  resolveGitHubRelease,
  type GitHubFetch,
} from './github.js';

const prefix = 'local-ability:';
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
// Only a main-process native chooser may supply a path. No paths come from IPC or a worker.
export class LocalAbilityPackages {
  private readonly entries = new Map<
    string,
    { review: InstallReview; bytes: Buffer }
  >();
  private generation?: string;
  constructor(private readonly session: () => string | undefined) {}
  clear() {
    this.entries.clear();
    this.generation = undefined;
  }
  private live() {
    const session = this.session();
    if (session !== this.generation) {
      this.clear();
      this.generation = session;
    }
    if (!session) throw new AbilityFailure('host_unavailable');
    for (const [key, entry] of this.entries)
      if (entry.review.expiresAt <= Date.now()) this.entries.delete(key);
    return session;
  }
  private get(url: string) {
    this.live();
    const entry = this.entries.get(url);
    if (!entry) throw new AbilityFailure('permission_denied');
    return entry;
  }
  readonly transport: {
    resolve: typeof resolveGitHubRelease;
    download: GitHubFetch;
  } = {
    resolve: async (url, signal) => {
      signal.throwIfAborted();
      return url.startsWith(prefix)
        ? structuredClone(this.get(url).review)
        : resolveGitHubRelease(url, signal);
    },
    download: async (url, limit, signal) => {
      signal.throwIfAborted();
      if (!url.startsWith(prefix)) return fetchGitHub(url, limit, signal);
      const bytes = this.get(url).bytes;
      if (bytes.length > limit) throw new AbilityFailure('invalid_response');
      return Buffer.from(bytes);
    },
  };
  private async read(path: string, limit: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size < 1 ||
        info.size > limit
      )
        throw new AbilityFailure('invalid_response');
      // One extra byte detects growth, without allowing an unbounded readFile allocation.
      const bytes = Buffer.alloc(info.size + 1);
      let size = 0;
      while (size < bytes.length) {
        signal.throwIfAborted();
        const n = (await file.read(bytes, size, bytes.length - size, null))
          .bytesRead;
        if (!n) break;
        size += n;
      }
      const after = await file.stat();
      if (
        size !== info.size ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      )
        throw new AbilityFailure('invalid_response');
      return bytes.subarray(0, size);
    } finally {
      await file.close();
    }
  }
  async review(path: string, signal: AbortSignal): Promise<InstallReview> {
    const session = this.live();
    if (this.entries.size >= 4) throw new AbilityFailure('busy');
    const source = join(await realpath(dirname(path)), basename(path));
    const raw = await this.read(source, abilityLimits.descriptorBytes, signal);
    const descriptor = parseReleaseDescriptor(JSON.parse(raw.toString('utf8')));
    const bytes = await this.read(
      join(dirname(source), descriptor.asset.name),
      16 * 1024 * 1024,
      signal,
    );
    if (
      bytes.length !== descriptor.asset.compressedBytes ||
      digest(bytes) !== descriptor.asset.sha256
    )
      throw new AbilityFailure('invalid_response');
    signal.throwIfAborted();
    if (this.live() !== session) throw new AbilityFailure('permission_denied');
    // Recheck after reads: concurrent chooser requests cannot exceed the cache bound.
    if (this.entries.size >= 4) throw new AbilityFailure('busy');
    const id = randomUUID(),
      url = prefix + id;
    const review: InstallReview = {
      id,
      descriptor,
      descriptorUrl: url,
      archiveUrl: url,
      descriptorSha256: digest(raw),
      expiresAt: Date.now() + 600_000,
      localSource: source,
    };
    this.entries.set(url, { review, bytes });
    return structuredClone(review);
  }
}
