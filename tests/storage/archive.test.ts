import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { readArchive, writeArchive } from '../../src/server/storage/archive.ts';
import { archiveFixture } from '../fixtures/storage-archive.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture(files: Record<string, string | Buffer> = {}) {
  const result = await archiveFixture(files);
  cleanups.push(result.dispose);
  return result;
}
const absent = async (path: string) =>
  expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });

describe('verified archives', () => {
  it('rejects truncated age output without publishing files', async () => {
    const f = await fixture({ 'data/memory.json': 'irreplaceable memory' });
    await writeArchive(f);
    const bytes = await readFile(f.destination);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(f.destination, bytes.subarray(0, -12));
    await expect(
      readArchive({ ...f, source: f.destination }),
    ).rejects.toThrow();
    await absent(f.stagingDirectory);
    expect(await readdir(f.root)).toEqual(
      expect.arrayContaining(['source', 'backup.dotbackup']),
    );
    expect((await readdir(f.root)).length).toBe(2);
  }, 30000);
  it('round trips a large stream with bounded buffering', async () => {
    const f = await fixture();
    f.manifest.kind = 'dot-export';
    const chunk = randomBytes(64 * 1024);
    const hash = createHash('sha256');
    const bytes = 32 * 1024 * 1024;
    await pipeline(
      Readable.from(
        (function* () {
          for (let i = 0; i < bytes / chunk.length; i++) {
            hash.update(chunk);
            yield chunk;
          }
        })(),
      ),
      createWriteStream(join(f.sourceDirectory, 'large.bin')),
    );
    f.manifest.entries.push({
      path: 'large.bin',
      bytes,
      sha256: hash.digest('hex'),
    });
    // Measure external memory, not noisy V8 RSS. Buffering the whole plaintext
    // would exceed this bound; fixture generation itself uses a single chunk.
    const baseline = process.memoryUsage().arrayBuffers;
    let peak = baseline;
    const sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }, 1);
    try {
      await writeArchive({ ...f, passphrase: undefined });
      expect(
        await readArchive({
          ...f,
          source: f.destination,
          passphrase: undefined,
        }),
      ).toEqual(f.manifest);
      const actual = createHash('sha256');
      for await (const data of createReadStream(
        join(f.stagingDirectory, 'large.bin'),
      ))
        actual.update(data);
      expect(actual.digest('hex')).toBe(f.manifest.entries[0].sha256);
      expect(peak - baseline).toBeLessThan(bytes);
    } finally {
      clearInterval(sample);
    }
  });
  it('requires encryption for workspace backups', async () => {
    const f = await fixture();
    await expect(writeArchive({ ...f, passphrase: undefined })).rejects.toThrow(
      /passphrase/i,
    );
    await absent(f.destination);
  });
  it('round trips encrypted Unicode files and rejects wrong passwords', async () => {
    const f = await fixture({ '记忆/café.txt': 'private memory' });
    await writeArchive(f);
    await expect(
      readArchive({
        ...f,
        source: f.destination,
        passphrase: 'wrong password',
      }),
    ).rejects.toThrow();
    await absent(f.stagingDirectory);
    expect(await readArchive({ ...f, source: f.destination })).toEqual(
      f.manifest,
    );
    expect(
      await readFile(join(f.stagingDirectory, '记忆/café.txt'), 'utf8'),
    ).toBe('private memory');
  }, 30000);
  it('round trips empty Dot archives', async () => {
    const f = await fixture();
    f.manifest.kind = 'dot-export';
    await writeArchive({ ...f, passphrase: undefined });
    expect(
      await readArchive({ ...f, source: f.destination, passphrase: undefined }),
    ).toEqual(f.manifest);
    expect(await readdir(f.stagingDirectory)).toEqual([]);
  });
  it('cancels without publishing and preserves existing destinations', async () => {
    const f = await fixture({ one: 'hello' });
    const signal = AbortSignal.abort();
    await expect(writeArchive({ ...f, signal })).rejects.toThrow();
    await absent(f.destination);
    await writeArchive({
      ...f,
      manifest: { ...f.manifest, kind: 'dot-export' },
      passphrase: undefined,
    });
    await expect(writeArchive(f)).rejects.toThrow();
    await expect(
      readArchive({ ...f, source: f.destination, signal }),
    ).rejects.toThrow();
    await absent(f.stagingDirectory);
  });
});

// Independent vectors published by the age authors, not generated by this codec.
// https://github.com/C2SP/CCTV/tree/main/age (CC0 / Zero-Clause BSD)
it('decrypts the upstream age scrypt interoperability vector', async () => {
  const { openArchiveStream } =
    await import('../../src/server/storage/archive-encryption.ts');
  const { writeFile } = await import('node:fs/promises');
  const f = await fixture();
  const vector = await readFile(
    new URL('../fixtures/age/armor_scrypt.txt', import.meta.url),
    'utf8',
  );
  const body = vector
    .split('-----BEGIN AGE ENCRYPTED FILE-----\n')[1]
    .split('-----END AGE ENCRYPTED FILE-----')[0];
  await writeFile(
    f.destination,
    Buffer.from(body.replace(/\s/g, ''), 'base64'),
  );
  const opened = await openArchiveStream(f.destination, 'password', f.signal);
  try {
    const hash = createHash('sha256');
    for await (const chunk of opened.stream) hash.update(chunk);
    expect(hash.digest('hex')).toBe(vector.match(/^payload: (.*)$/m)![1]);
    expect(opened.encrypted).toBe(true);
  } finally {
    await opened.close();
  }
});

async function crafted(
  f: Awaited<ReturnType<typeof fixture>>,
  entries: {
    name: string;
    content?: string;
    type?: 'file' | 'symlink' | 'link' | 'directory' | 'fifo';
    linkname?: string;
  }[],
  manifest: unknown = { ...f.manifest, kind: 'dot-export' },
) {
  const { pack } = await import('tar-stream');
  const { createGzip } = await import('node:zlib');
  const tar = pack();
  const writing = pipeline(
    Readable.from(tar),
    createGzip(),
    createWriteStream(f.destination),
  );
  for (const entry of [
    { name: 'manifest.json', content: JSON.stringify(manifest) },
    ...entries,
  ]) {
    await new Promise<void>((resolve, reject) =>
      tar.entry(
        {
          name: entry.name,
          type: 'type' in entry ? entry.type : 'file',
          linkname: 'linkname' in entry ? entry.linkname : undefined,
        },
        entry.content ?? '',
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }
  tar.finalize();
  await writing;
}
it.each(['symlink', 'link', 'directory', 'fifo'] as const)(
  'rejects %s entries without retaining staging',
  async (type) => {
    const f = await fixture({ one: '' });
    await crafted(f, [
      {
        name: 'one',
        type,
        linkname:
          type === 'symlink' || type === 'link' ? '../../outside' : undefined,
      },
    ]);
    await expect(readArchive({ ...f, source: f.destination })).rejects.toThrow(
      /unsupported/i,
    );
    await absent(f.stagingDirectory);
  },
);
it.each(
  [
    [{ name: '../outside', content: 'unsafe' }],
    [{ name: '/absolute', content: 'unsafe' }],
    [{ name: 'other', content: 'unsafe' }],
    [{ name: 'one', content: 'wrong' }],
    [
      { name: 'one', content: 'hello' },
      { name: 'one', content: 'hello' },
    ],
    [],
  ].map((entries) => ({ entries })),
)(
  'rejects undeclared, missing, duplicate, or corrupt content $entries',
  async ({ entries }) => {
    const f = await fixture({ one: 'hello' });
    await crafted(f, entries);
    await expect(
      readArchive({ ...f, source: f.destination }),
    ).rejects.toThrow();
    await absent(f.stagingDirectory);
  },
);
it('rejects a plaintext workspace backup and quota violations before publishing', async () => {
  const f = await fixture({ one: 'hello' });
  await crafted(f, [{ name: 'one', content: 'hello' }], f.manifest);
  await expect(readArchive({ ...f, source: f.destination })).rejects.toThrow(
    /encrypted/,
  );
  await absent(f.stagingDirectory);
  await crafted(f, [{ name: 'one', content: 'hello' }]);
  for (const limits of [
    { maxEntries: 0 },
    { maxManifestBytes: 8 },
    { maxFileBytes: 4 },
    { maxTotalBytes: 4 },
    { maxPathBytes: 2 },
  ]) {
    await expect(
      readArchive({ ...f, source: f.destination, limits }),
    ).rejects.toThrow(/limit/);
    await absent(f.stagingDirectory);
  }
});
it('rejects source symlinks and changed content and keeps existing staging intact', async () => {
  const f = await fixture({ one: 'hello' });
  f.manifest.kind = 'dot-export';
  const { writeFile, symlink, unlink, mkdir } =
    await import('node:fs/promises');
  await writeFile(join(f.sourceDirectory, 'one'), 'wrong');
  await expect(writeArchive({ ...f, passphrase: undefined })).rejects.toThrow(
    /checksum/,
  );
  await absent(f.destination);
  await unlink(join(f.sourceDirectory, 'one'));
  await writeFile(join(f.root, 'outside'), 'hello');
  await symlink(join(f.root, 'outside'), join(f.sourceDirectory, 'one'));
  await expect(writeArchive({ ...f, passphrase: undefined })).rejects.toThrow();
  await absent(f.destination);
  await crafted(f, [{ name: 'one', content: 'hello' }]);
  await mkdir(f.stagingDirectory);
  await writeFile(join(f.stagingDirectory, 'preserve'), 'keep');
  await expect(readArchive({ ...f, source: f.destination })).rejects.toThrow();
  expect(await readFile(join(f.stagingDirectory, 'preserve'), 'utf8')).toBe(
    'keep',
  );
});
it('bounds hostile age headers before password derivation', async () => {
  const f = await fixture();
  const { writeFile } = await import('node:fs/promises');
  for (const text of [
    'age-encryption.org/v1\n' + 'x'.repeat(70 * 1024),
    'age-encryption.org/v1\n-> scrypt AAAAAAAAAAAAAAAAAAAAAA 30\nAAAA\n--- AAAA\n',
  ]) {
    await writeFile(f.destination, text);
    await expect(readArchive({ ...f, source: f.destination })).rejects.toThrow(
      /limit|work factor/,
    );
    await absent(f.stagingDirectory);
  }
});
