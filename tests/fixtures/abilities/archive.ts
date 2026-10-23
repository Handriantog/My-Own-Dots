import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack, type Header } from 'tar-stream';
import fixture from './manifest.json';
import { parseManifest } from '../../../src/shared/abilities/manifest.ts';
import type { InstallReview } from '../../../src/shared/abilities/types.ts';

export type FixtureEntry = {
  header: Partial<Header> & { name: string };
  body?: string | Buffer;
};
export async function archiveFixture(
  root: string,
  additional: FixtureEntry[] = [],
  manifest: unknown = fixture,
) {
  const entries: FixtureEntry[] = [
    { header: { name: 'ability.json' }, body: JSON.stringify(manifest) },
    {
      header: { name: 'dist/worker.mjs' },
      body: 'throw new Error("Ability code must never run during install");',
    },
    ...additional,
  ];
  const stream = pack();
  const chunks: Buffer[] = [];
  const consumed = (async () => {
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Invalid fixture stream');
      chunks.push(chunk);
    }
  })();
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) =>
      stream.entry(
        { mode: 0o644, mtime: new Date(0), ...entry.header },
        entry.body ?? '',
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }
  stream.finalize();
  await consumed;
  const bytes = gzipSync(Buffer.concat(chunks));
  const path = join(root, randomUUID() + '.tar.gz');
  await writeFile(path, bytes, { mode: 0o600 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const review: InstallReview = {
    id: randomUUID(),
    descriptorUrl:
      'https://github.com/example/abilities/releases/download/fixture%2Fv0.1.0/fixture.json',
    descriptorSha256: 'a'.repeat(64),
    archiveUrl:
      'https://api.github.com/repos/example/abilities/releases/assets/12',
    expiresAt: Date.now() + 60_000,
    descriptor: {
      formatVersion: 1,
      manifest: parseManifest(fixture),
      sourceCommit: 'b'.repeat(40),
      releaseTag: 'fixture/v0.1.0',
      asset: {
        id: 12,
        name: 'fixture.tar.gz',
        sha256,
        compressedBytes: bytes.length,
        extractedBytes: entries.reduce(
          (n, e) => n + Buffer.byteLength(e.body ?? ''),
          0,
        ),
        fileCount: entries.filter(
          (e) => !e.header.type || e.header.type === 'file',
        ).length,
      },
    },
  };
  return { path, bytes, review };
}
