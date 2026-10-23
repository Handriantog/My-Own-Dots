import {
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { archiveFixture } from '../fixtures/abilities/archive.ts';
import { LocalAbilityPackages } from '../../src/desktop/host/abilities/local.ts';
import { AbilityInstaller } from '../../src/desktop/host/abilities/installer.ts';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ability-local-')));
  roots.push(root);
  const { path, review } = await archiveFixture(root);
  const descriptor = join(root, 'fixture.json');
  const archive = join(root, review.descriptor.asset.name);
  await rename(path, archive);
  await writeFile(descriptor, JSON.stringify(review.descriptor));
  let session: string | undefined = 'session';
  const local = new LocalAbilityPackages(() => session);
  return {
    root,
    descriptor,
    archive,
    local,
    setSession: (s: string | undefined) => {
      session = s;
    },
  };
}
it('reads a bounded snapshot without extraction; installs only the reviewed bytes', async () => {
  const f = await fixture();
  const review = await f.local.review(
    f.descriptor,
    new AbortController().signal,
  );
  expect(review.localSource).toBe(f.descriptor);
  expect((await readdir(f.root)).sort()).toEqual([
    'fixture.json',
    'fixture.tar.gz',
  ]);
  await writeFile(f.archive, 'changed after review');
  const pkg = await new AbilityInstaller(
    join(f.root, 'installation'),
    f.local.transport,
  ).prepare(review, new AbortController().signal);
  expect(await readFile(join(pkg.root, 'dist/worker.mjs'), 'utf8')).toContain(
    'must never run during install',
  );
});
it('rejects changed review identity without touching installation', async () => {
  const f = await fixture();
  const review = await f.local.review(
    f.descriptor,
    new AbortController().signal,
  );
  await expect(
    new AbilityInstaller(
      join(f.root, 'installation'),
      f.local.transport,
    ).prepare(
      { ...review, descriptorSha256: 'f'.repeat(64) },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
it.each(['descriptor', 'archive'] as const)(
  'rejects a final %s symlink before review',
  async (which) => {
    const f = await fixture();
    const path = f[which];
    await rename(path, path + '.real');
    await symlink(path + '.real', path);
    await expect(
      f.local.review(f.descriptor, new AbortController().signal),
    ).rejects.toThrow();
  },
);
it('rejects hash mismatch before consent', async () => {
  const f = await fixture();
  await writeFile(f.archive, 'bad');
  await expect(
    f.local.review(f.descriptor, new AbortController().signal),
  ).rejects.toThrow();
});
it('forgets local authority on host session change and expiry', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const review = await f.local.review(f.descriptor, signal);
  f.setSession('replacement');
  await expect(
    f.local.transport.resolve(review.descriptorUrl, signal),
  ).rejects.toThrow();
  f.setSession('session');
  await expect(
    f.local.transport.resolve(review.descriptorUrl, signal),
  ).rejects.toThrow();
});
it('bounds retained packages and clears on shutdown', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  for (let i = 0; i < 4; i++) await f.local.review(f.descriptor, signal);
  await expect(f.local.review(f.descriptor, signal)).rejects.toThrow();
  f.local.clear();
  expect(await f.local.review(f.descriptor, signal)).toBeTruthy();
});
