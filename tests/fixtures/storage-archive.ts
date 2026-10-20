import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ArchiveManifest } from '../../src/shared/storage-archive.ts';

export const recoveryPassword = 'test-only recovery password';
export const sha256 = (data: Uint8Array | string) =>
  createHash('sha256').update(data).digest('hex');

export async function archiveFixture(
  files: Record<string, string | Buffer> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dot-archive-test-'));
  const sourceDirectory = join(root, 'source');
  await mkdir(sourceDirectory);
  for (const [name, data] of Object.entries(files)) {
    await mkdir(dirname(join(sourceDirectory, name)), { recursive: true });
    await writeFile(join(sourceDirectory, name), data);
  }
  const manifest: ArchiveManifest = {
    version: 1,
    minimumReader: 1,
    kind: 'workspace-backup',
    archiveId: randomUUID(),
    workspaceId: 'workspace-test',
    ownerId: 'owner-test',
    createdAt: '2026-10-19T00:00:00.000Z',
    entries: Object.entries(files).map(([path, data]) => ({
      path,
      bytes: Buffer.byteLength(data),
      sha256: sha256(data),
    })),
    coverage: [{ component: 'core', state: 'included' }],
  };
  return {
    root,
    sourceDirectory,
    manifest,
    destination: join(root, 'backup.dotbackup'),
    stagingDirectory: join(root, 'restored'),
    passphrase: recoveryPassword,
    signal: new AbortController().signal,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
