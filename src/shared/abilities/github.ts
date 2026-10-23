import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isPublicAddress } from '../network-address.js';
import { abilityLimits } from './limits.js';
import { parseReleaseDescriptor } from './manifest.js';
import type { InstallReview } from './types.js';

const hosts = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
export type GitHubFetch = (
  url: string,
  limit: number,
  signal: AbortSignal,
) => Promise<Buffer>;
/** No cookies, credentials, proxy environment, shared agent, or implicit redirect. */
export const fetchGitHub: GitHubFetch = async (input, limit, signal) => {
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(abilityLimits.brokerMs),
  ]);
  let url = new URL(input);
  for (let redirects = 0; redirects <= 3; redirects++) {
    deadline.throwIfAborted();
    if (
      url.protocol !== 'https:' ||
      !hosts.has(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('Unsupported Ability download destination');
    const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
      const cancelled = () => reject(new Error('Ability download cancelled'));
      deadline.addEventListener('abort', cancelled, { once: true });
      if (deadline.aborted) {
        cancelled();
        return;
      }
      void lookup(url.hostname, { all: true }).then(
        (values) => {
          deadline.removeEventListener('abort', cancelled);
          resolve(values);
        },
        (error: unknown) => {
          deadline.removeEventListener('abort', cancelled);
          reject(error);
        },
      );
    });
    deadline.throwIfAborted();
    if (
      !addresses.length ||
      addresses.some((item) => !isPublicAddress(item.address))
    )
      throw new Error('Non-public Ability download destination');
    const destination = addresses[0];
    const response = await new Promise<{
      status: number;
      location?: string;
      body: Buffer;
    }>((resolve, reject) => {
      const req = request(
        url,
        {
          agent: false,
          signal: deadline,
          method: 'GET',
          headers: {
            'User-Agent': 'My-Own-Dots-Ability-Host',
            Accept:
              url.hostname === 'api.github.com' &&
              !/\/releases\/assets\/[0-9]+$/.test(url.pathname)
                ? 'application/vnd.github+json'
                : 'application/octet-stream',
            'X-GitHub-Api-Version': '2026-03-10',
          },
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [destination]);
            else callback(null, destination.address, destination.family);
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            resolve({
              status,
              location: res.headers.location,
              body: Buffer.alloc(0),
            });
            return;
          }
          const length = Number(res.headers['content-length']);
          if (
            res.headers['content-encoding'] ||
            (Number.isFinite(length) && length > limit)
          ) {
            res.destroy();
            reject(new Error('Ability download exceeds limit'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit)
              res.destroy(new Error('Ability download exceeds limit'));
            else chunks.push(chunk);
          });
          res.once('error', reject);
          res.once('end', () =>
            resolve({ status, body: Buffer.concat(chunks) }),
          );
        },
      );
      req.once('error', reject);
      req.end();
    });
    if (response.status === 200) return response.body;
    if (
      ![301, 302, 303, 307, 308].includes(response.status) ||
      !response.location
    )
      throw new Error('Ability download unavailable');
    url = new URL(response.location, url);
  }
  throw new Error('Too many Ability download redirects');
};

export class GitHubAbilities {
  constructor(private readonly fetch: GitHubFetch = fetchGitHub) {}
  async resolve(input: string, signal: AbortSignal): Promise<InstallReview> {
    const url = new URL(input);
    const match =
      /^\/([^/]+)\/([^/]+)\/releases\/download\/(.+)\/([^/]+\.json)$/.exec(
        url.pathname,
      );
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !match
    )
      throw new Error('Use a public GitHub release descriptor URL');
    const [, rawOwner, rawRepository, rawTag] = match;
    const owner = rawOwner.toLowerCase(),
      repository = rawRepository.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(owner) || !/^[a-z0-9._-]+$/.test(repository))
      throw new Error('Invalid Ability repository');
    const descriptorBytes = await this.fetch(
      input,
      abilityLimits.descriptorBytes,
      signal,
    );
    if (descriptorBytes.length > abilityLimits.descriptorBytes)
      throw new Error('Ability descriptor exceeds limit');
    const descriptor = parseReleaseDescriptor(
      JSON.parse(descriptorBytes.toString('utf8')),
    );
    if (
      descriptor.manifest.source.owner !== owner ||
      descriptor.manifest.source.repository !== repository ||
      descriptor.releaseTag !== decodeURIComponent(rawTag)
    )
      throw new Error('Ability release source differs from descriptor');
    const base = `https://api.github.com/repos/${owner}/${repository}`;
    const json = async (path: string): Promise<Record<string, unknown>> => {
      const bytes = await this.fetch(path, abilityLimits.frameBytes, signal);
      if (bytes.length > abilityLimits.frameBytes)
        throw new Error('Ability metadata exceeds limit');
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid GitHub metadata');
      return value as Record<string, unknown>;
    };
    const [repo, release, commit] = await Promise.all([
      json(base),
      json(
        `${base}/releases/tags/${encodeURIComponent(descriptor.releaseTag)}`,
      ),
      json(`${base}/commits/${encodeURIComponent(descriptor.releaseTag)}`),
    ]);
    if (
      repo.private !== false ||
      typeof repo.full_name !== 'string' ||
      repo.full_name.toLowerCase() !== `${owner}/${repository}` ||
      release.draft !== false ||
      release.tag_name !== descriptor.releaseTag ||
      commit.sha !== descriptor.sourceCommit ||
      !Array.isArray(release.assets)
    )
      throw new Error('GitHub release identity changed');
    const asset = release.assets.find(
      (value: unknown) =>
        value &&
        typeof value === 'object' &&
        (value as { id?: unknown }).id === descriptor.asset.id,
    );
    if (
      !asset ||
      asset.name !== descriptor.asset.name ||
      asset.size !== descriptor.asset.compressedBytes ||
      asset.state !== 'uploaded' ||
      (asset.digest != null &&
        asset.digest !== `sha256:${descriptor.asset.sha256}`)
    )
      throw new Error('GitHub asset changed');
    signal.throwIfAborted();
    return {
      id: randomUUID(),
      descriptor,
      descriptorUrl: input,
      descriptorSha256: createHash('sha256')
        .update(descriptorBytes)
        .digest('hex'),
      archiveUrl: `${base}/releases/assets/${descriptor.asset.id}`,
      expiresAt: Date.now() + 10 * 60_000,
    };
  }
}
export function resolveGitHubRelease(
  url: string,
  signal: AbortSignal,
): Promise<InstallReview> {
  return new GitHubAbilities().resolve(url, signal);
}
