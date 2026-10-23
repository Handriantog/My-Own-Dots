import { afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  link,
  rm,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAbilityDocumentation } from '../../src/desktop/host/abilities/documentation.ts';
const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ability-readme-')));
  roots.push(root);
  const digest = 'a'.repeat(64),
    directory = join(root, digest);
  await mkdir(directory);
  return { root, digest, directory };
}
it('reads the fixed package README and returns null for a package without one', async () => {
  const f = await fixture();
  expect(await readAbilityDocumentation(f.root, f.digest)).toBeNull();
  await writeFile(
    join(f.directory, 'README.md'),
    '# Music\n\n**Play** together.',
  );
  expect(await readAbilityDocumentation(f.root, f.digest)).toBe(
    '# Music\n\n**Play** together.',
  );
});
it.each(['symlink', 'hardlink', 'directory', 'oversize'])(
  'rejects a %s README',
  async (kind) => {
    const f = await fixture(),
      file = join(f.directory, 'README.md'),
      secret = join(f.root, 'private');
    await writeFile(secret, 'private sentinel');
    if (kind === 'symlink') await symlink(secret, file);
    if (kind === 'hardlink') await link(secret, file);
    if (kind === 'directory') await mkdir(file);
    if (kind === 'oversize') await writeFile(file, 'x'.repeat(65537));
    await expect(readAbilityDocumentation(f.root, f.digest)).rejects.toThrow();
  },
);
it('rejects traversal and a replaced package directory', async () => {
  const f = await fixture();
  await expect(
    readAbilityDocumentation(f.root, '../private'),
  ).rejects.toThrow();
  await rm(f.directory, { recursive: true });
  await symlink(f.root, f.directory);
  await expect(readAbilityDocumentation(f.root, f.digest)).rejects.toThrow();
});
