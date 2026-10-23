import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DirectoryAnchor } from '../../../shared/abilities/directory.js';
/** Only a known installed digest and fixed README name; never a renderer path. */
export async function readAbilityDocumentation(
  packages: string,
  digest: string,
): Promise<string | null> {
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(digest);
  const root = await DirectoryAnchor.capture(join(packages, digest));
  await root.check();
  const file = await open(
    join(root.path, 'README.md'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!file) return null;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 65536)
      throw Error('Invalid documentation');
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await file.stat();
    await root.check();
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error('Documentation changed');
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    await file.close();
  }
}
