import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveFixture,
  type FixtureEntry,
} from '../fixtures/abilities/archive.ts';
import manifest from '../fixtures/abilities/manifest.json';
import { verifyAbilityPackage } from '../../src/desktop/host/abilities/package.ts';
import { AbilityInstaller } from '../../src/desktop/host/abilities/installer.ts';
import {
  GitHubAbilities,
  fetchGitHub,
} from '../../src/desktop/host/abilities/github.ts';

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('node:https', () => ({ request: network.request }));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('GitHub transport boundaries', () => {
  it.each([
    'https://evil.example/file',
    'http://github.com/file',
    'https://user:secret@github.com/file',
  ])('rejects unapproved destination %s before lookup', async (url) => {
    await expect(
      fetchGitHub(url, 100, new AbortController().signal),
    ).rejects.toThrow();
    expect(network.lookup).not.toHaveBeenCalled();
    expect(network.request).not.toHaveBeenCalled();
  });
  it.each(['127.0.0.1', '10.0.0.2', '::1', '::ffff:127.0.0.1', 'fe80::1'])(
    'rejects mixed public/private DNS answer %s before any request',
    async (address) => {
      network.lookup.mockResolvedValue([
        { address: '140.82.112.3', family: 4 },
        { address, family: address.includes(':') ? 6 : 4 },
      ]);
      await expect(
        fetchGitHub(
          'https://github.com/file',
          100,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(network.request).not.toHaveBeenCalled();
    },
  );
  it('pins lookup and retains TLS hostname, with no cookies or authorization', async () => {
    network.lookup.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
    network.request.mockImplementation((_url, _options, respond) => {
      const req = Object.assign(new EventEmitter(), {
        end: () =>
          queueMicrotask(() => {
            const res = Object.assign(new EventEmitter(), {
              statusCode: 200,
              headers: {},
              destroy: vi.fn(),
            });
            respond(res);
            res.emit('data', Buffer.from('ok'));
            res.emit('end');
          }),
      });
      return req;
    });
    expect(
      await fetchGitHub(
        'https://api.github.com/repos/example/abilities',
        100,
        new AbortController().signal,
      ),
    ).toEqual(Buffer.from('ok'));
    const [url, options] = network.request.mock.calls[0];
    expect(url.hostname).toBe('api.github.com');
    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).not.toBe(false);
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(options.headers).not.toHaveProperty('Cookie');
    expect(options.headers.Accept).toBe('application/vnd.github+json');
    const resolved = vi.fn();
    options.lookup('api.github.com', { all: true }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, [
      { address: '140.82.112.3', family: 4 },
    ]);
  });
  it('cancels a stalled DNS lookup before opening a connection', async () => {
    network.lookup.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = fetchGitHub(
      'https://github.com/file',
      100,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(network.request).not.toHaveBeenCalled();
  }, 300);
  it('validates a redirect before DNS or a second request', async () => {
    network.lookup.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
    network.request.mockImplementation((_url, _options, respond) =>
      Object.assign(new EventEmitter(), {
        end: () =>
          queueMicrotask(() =>
            respond(
              Object.assign(new EventEmitter(), {
                statusCode: 302,
                headers: { location: 'https://127.0.0.1/private' },
                destroy: vi.fn(),
              }),
            ),
          ),
      }),
    );
    await expect(
      fetchGitHub('https://github.com/file', 100, new AbortController().signal),
    ).rejects.toThrow();
    expect(network.lookup).toHaveBeenCalledTimes(1);
    expect(network.request).toHaveBeenCalledTimes(1);
  });
  it('enforces streamed bytes when the response omits Content-Length', async () => {
    network.lookup.mockResolvedValue([{ address: '140.82.112.3', family: 4 }]);
    network.request.mockImplementation((_url, _options, respond) =>
      Object.assign(new EventEmitter(), {
        end: () =>
          queueMicrotask(() => {
            const res = Object.assign(new EventEmitter(), {
              statusCode: 200,
              headers: {},
              destroy: (error: Error) => res.emit('error', error),
            });
            respond(res);
            res.emit('data', Buffer.alloc(101));
          }),
      }),
    );
    await expect(
      fetchGitHub('https://github.com/file', 100, new AbortController().signal),
    ).rejects.toThrow(/limit/);
  });
});
async function setup() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ability-install-')),
  );
  roots.push(root);
  const staging = join(root, 'staging');
  await mkdir(staging, { mode: 0o700 });
  await writeFile(join(root, 'sentinel'), 'outside data');
  return { root, staging, signal: new AbortController().signal };
}
describe('review-bound package extraction', () => {
  it('extracts and seals reviewed bytes without running the supplied worker', async () => {
    const f = await setup(),
      archive = await archiveFixture(f.root);
    const spawn = vi.spyOn(childProcess, 'spawn');
    const pkg = await verifyAbilityPackage(
      archive.path,
      archive.review,
      f.staging,
      f.signal,
    );
    expect(pkg.digest).toBe(archive.review.descriptor.asset.sha256);
    expect(pkg.files.map((entry) => entry.path)).toEqual([
      'ability.json',
      'dist/worker.mjs',
    ]);
    expect(await readFile(join(pkg.root, 'ability.json'), 'utf8')).toBe(
      JSON.stringify(manifest),
    );
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([
    { header: { name: '../sentinel' }, body: 'replaced' },
    { header: { name: '/tmp/ability-outside' }, body: 'replaced' },
    { header: { name: 'link', type: 'symlink', linkname: '../sentinel' } },
    { header: { name: 'link', type: 'link', linkname: '../sentinel' } },
    {
      header: {
        name: 'device',
        type: 'character-device',
        devmajor: 1,
        devminor: 2,
      },
    },
    { header: { name: 'dist/WORKER.mjs' }, body: 'collision' },
    { header: { name: 'bin/undeclared', mode: 0o755 }, body: 'executable' },
  ] as FixtureEntry[])(
    'rejects dangerous archive entry $header.name',
    async (entry) => {
      const f = await setup(),
        archive = await archiveFixture(f.root, [entry]);
      const spawn = vi.spyOn(childProcess, 'spawn');
      await expect(
        verifyAbilityPackage(archive.path, archive.review, f.staging, f.signal),
      ).rejects.toThrow();
      expect(await readdir(f.staging)).toEqual([]);
      expect(await readFile(join(f.root, 'sentinel'), 'utf8')).toBe(
        'outside data',
      );
      expect(spawn).not.toHaveBeenCalled();
    },
  );
  it('rejects canonically equivalent Unicode file names', async () => {
    const f = await setup(),
      archive = await archiveFixture(f.root, [
        { header: { name: 'café.txt' }, body: 'one' },
        { header: { name: 'cafe\u0301.txt' }, body: 'two' },
      ]);
    await expect(
      verifyAbilityPackage(archive.path, archive.review, f.staging, f.signal),
    ).rejects.toThrow();
  });
  it('rejects extra manifest keys and reviewed-manifest mismatch', async () => {
    const f = await setup();
    for (const value of [
      { ...manifest, installer: 'run.sh' },
      { ...manifest, name: 'Changed after approval' },
    ]) {
      const archive = await archiveFixture(f.root, [], value);
      await expect(
        verifyAbilityPackage(archive.path, archive.review, f.staging, f.signal),
      ).rejects.toThrow();
    }
  });
  it('rejects digest mismatch, inflation beyond declared size, and truncated streams', async () => {
    const f = await setup(),
      archive = await archiveFixture(f.root);
    const wrongHash = structuredClone(archive.review);
    wrongHash.descriptor.asset.sha256 = '0'.repeat(64);
    await expect(
      verifyAbilityPackage(archive.path, wrongHash, f.staging, f.signal),
    ).rejects.toThrow();
    const small = structuredClone(archive.review);
    small.descriptor.asset.extractedBytes = 1;
    await expect(
      verifyAbilityPackage(archive.path, small, f.staging, f.signal),
    ).rejects.toThrow();
    await writeFile(archive.path, archive.bytes.subarray(0, -10));
    await expect(
      verifyAbilityPackage(archive.path, archive.review, f.staging, f.signal),
    ).rejects.toThrow();
  });
  it('rejects a symlink staging parent before writing anything', async () => {
    const f = await setup(),
      archive = await archiveFixture(f.root);
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await rm(f.staging, { recursive: true });
    await symlink(outside, f.staging);
    await expect(
      verifyAbilityPackage(archive.path, archive.review, f.staging, f.signal),
    ).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });
});
describe('immutable installation', () => {
  it('converges concurrent installs on one verified package', async () => {
    const f = await setup(),
      archive = await archiveFixture(f.root);
    const installer = new AbilityInstaller(join(f.root, 'abilities'), {
      resolve: async () => structuredClone(archive.review),
      download: async () => archive.bytes,
    });
    const results = await Promise.all([
      installer.prepare(archive.review, f.signal),
      installer.prepare(archive.review, f.signal),
    ]);
    expect(results[0].root).toBe(results[1].root);
    expect(await readdir(join(f.root, 'abilities', 'packages'))).toEqual([
      results[0].digest,
    ]);
  });
  it('rejects moving tags/assets before fetching executable bytes', async () => {
    const f = await setup(),
      archive = await archiveFixture(f.root),
      download = vi.fn(async () => archive.bytes);
    const changed = structuredClone(archive.review);
    changed.descriptor.sourceCommit = 'c'.repeat(40);
    const installer = new AbilityInstaller(join(f.root, 'abilities'), {
      resolve: async () => changed,
      download,
    });
    await expect(installer.prepare(archive.review, f.signal)).rejects.toThrow();
    expect(download).not.toHaveBeenCalled();
  });
  it('does not promote into a replaced parent', async () => {
    const f = await setup(),
      archive = await archiveFixture(f.root);
    const base = join(f.root, 'abilities'),
      outside = join(f.root, 'outside');
    await mkdir(outside);
    const installer = new AbilityInstaller(base, {
      resolve: async () => archive.review,
      download: async () => {
        await rename(base, base + '-old');
        await symlink(outside, base);
        return archive.bytes;
      },
    });
    await expect(installer.prepare(archive.review, f.signal)).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });
  it('does not activate interrupted downloads and can retry a fresh request', async () => {
    const f = await setup(),
      archive = await archiveFixture(f.root);
    const controller = new AbortController();
    const download = vi.fn(async () => {
      controller.abort();
      return archive.bytes;
    });
    const installer = new AbilityInstaller(join(f.root, 'abilities'), {
      resolve: async () => archive.review,
      download,
    });
    await expect(
      installer.prepare(archive.review, controller.signal),
    ).rejects.toThrow();
    expect(await readdir(join(f.root, 'abilities'))).toEqual([]);
    download.mockImplementation(async () => archive.bytes);
    const pkg = await installer.prepare(archive.review, f.signal);
    expect(pkg.digest).toBe(archive.review.descriptor.asset.sha256);
  });
});
describe('GitHub identity resolution', () => {
  it('pins repository, tag, commit, asset identity and digest in the review', async () => {
    const f = await setup(),
      { review } = await archiveFixture(f.root);
    const fetch = vi.fn(async (url: string) => {
      if (url === review.descriptorUrl)
        return Buffer.from(JSON.stringify(review.descriptor));
      if (url.endsWith('/repos/example/abilities'))
        return Buffer.from(
          JSON.stringify({ full_name: 'example/abilities', private: false }),
        );
      if (url.includes('/commits/'))
        return Buffer.from(
          JSON.stringify({ sha: review.descriptor.sourceCommit }),
        );
      return Buffer.from(
        JSON.stringify({
          tag_name: review.descriptor.releaseTag,
          draft: false,
          assets: [
            {
              id: 12,
              name: 'fixture.tar.gz',
              size: review.descriptor.asset.compressedBytes,
              state: 'uploaded',
              digest: 'sha256:' + review.descriptor.asset.sha256,
            },
          ],
        }),
      );
    });
    const client = new GitHubAbilities(fetch);
    const resolved = await client.resolve(review.descriptorUrl, f.signal);
    expect(resolved.archiveUrl).toBe(review.archiveUrl);
    expect(resolved.descriptor).toEqual(review.descriptor);
    expect(resolved.descriptorSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      client.resolve(
        'http://github.com/example/abilities/releases/latest',
        f.signal,
      ),
    ).rejects.toThrow();
  });
});
