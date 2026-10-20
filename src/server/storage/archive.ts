import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import {
  encryptArchiveStream,
  openArchiveStream,
} from './archive-encryption.js';
import { extract, pack } from 'tar-stream';
import {
  archiveLimits,
  parseArchiveManifest,
  type ArchiveEntry,
  type ArchiveLimits,
  type ArchiveManifest,
} from '../../shared/storage-archive.js';
import { validateArchivePaths } from './archive-paths.js';

type Options = {
  passphrase?: string;
  signal: AbortSignal;
  limits?: Partial<ArchiveLimits>;
};
const MANIFEST = 'manifest.json';

function validate(
  json: string,
  limits: Partial<ArchiveLimits>,
): ArchiveManifest {
  const manifest = parseArchiveManifest(json, limits);
  validateArchivePaths(
    manifest.entries.map((entry) => entry.path),
    limits,
  );
  if (
    manifest.entries.some(
      (entry) =>
        entry.path.split('/')[0].normalize('NFC').toLowerCase() === MANIFEST,
    )
  )
    throw new Error('Archive entry conflicts with its manifest');
  return manifest;
}
function checksum(entry: ArchiveEntry): Transform {
  let bytes = 0;
  const hash = createHash('sha256');
  return new Transform({
    transform(chunk: Buffer, _encoding, next) {
      bytes += chunk.length;
      if (bytes > entry.bytes)
        return next(new Error('Archive file size mismatch'));
      hash.update(chunk);
      next(null, chunk);
    },
    flush(next) {
      next(
        bytes === entry.bytes && hash.digest('hex') === entry.sha256
          ? undefined
          : new Error('Archive file checksum or size mismatch'),
      );
    },
  });
}
async function sourceFile(root: string, entry: ArchiveEntry) {
  let parent = root;
  for (const part of ['', ...entry.path.split('/').slice(0, -1)]) {
    parent = join(parent, part);
    if (!(await lstat(parent)).isDirectory())
      throw new Error('Archive source must contain only regular directories');
  }
  const file = await open(
    join(root, entry.path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== entry.bytes)
      throw new Error('Archive source file changed');
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Sources must be an immutable app-owned capture. No existing destination is replaced. */
export async function writeArchive(
  options: Options & {
    sourceDirectory: string;
    destination: string;
    manifest: ArchiveManifest;
  },
): Promise<void> {
  const limits = archiveLimits(options.limits);
  const json = JSON.stringify(options.manifest);
  const manifest = validate(json, limits);
  options.signal.throwIfAborted();
  const temporary = await mkdtemp(
    join(dirname(options.destination), `.${basename(options.destination)}-`),
  );
  await chmod(temporary, 0o700);
  const output = join(temporary, 'archive');
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const tar = pack();
  const gzip = createGzip();
  const tasks: Promise<unknown>[] = [];
  const watch = (task: Promise<unknown>) => {
    tasks.push(task);
    void task.catch((error: unknown) => controller.abort(error));
    return task;
  };
  const abort = () => {
    tar.destroy(signal.reason);
    gzip.destroy(signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    // Drain concurrently so tar entry backpressure bounds memory to stream buffers.
    watch(pipeline(Readable.from(tar), gzip, { signal }));
    const writing = (async () => {
      await new Promise<void>((resolve, reject) =>
        tar
          .entry(
            { name: MANIFEST, type: 'file', mode: 0o600, mtime: new Date(0) },
            json,
            (error) => (error ? reject(error) : resolve()),
          )
          .on('error', reject),
      );
      for (const entry of manifest.entries) {
        signal.throwIfAborted();
        const file = await sourceFile(options.sourceDirectory, entry);
        try {
          const sink = tar.entry({
            name: entry.path,
            type: 'file',
            size: entry.bytes,
            mode: 0o600,
            mtime: new Date(0),
          });
          await pipeline(
            file.createReadStream({ autoClose: false }),
            checksum(entry),
            sink as unknown as Writable,
            { signal },
          );
        } finally {
          await file.close();
        }
      }
      tar.finalize();
    })();
    watch(writing);
    let encoded: Readable = gzip;
    if (options.passphrase)
      encoded = await encryptArchiveStream(gzip, options.passphrase);
    watch(
      pipeline(
        encoded,
        createWriteStream(output, { flags: 'wx', mode: 0o600 }),
        { signal },
      ),
    );
    await Promise.all(tasks);
    signal.throwIfAborted();
    const saved = await open(output, 'r');
    try {
      await saved.sync();
    } finally {
      await saved.close();
    }
    // An exclusive hard-link publishes the complete file atomically without the
    // overwrite behavior of rename. Both paths are on the same filesystem.
    signal.throwIfAborted();
    await link(output, options.destination);
  } finally {
    controller.abort(new Error('Archive operation finished'));
    await Promise.allSettled(tasks);
    signal.removeEventListener('abort', abort);
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Staging must be in an app-owned private parent and must not already exist.
 * It is never an active workspace. Callers may use it only after this resolves.
 */
export async function readArchive(
  options: Options & {
    source: string;
    stagingDirectory: string;
  },
): Promise<ArchiveManifest> {
  const limits = archiveLimits(options.limits);
  options.signal.throwIfAborted();
  await mkdir(options.stagingDirectory, { mode: 0o700 });
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const tar = extract();
  // Decryption may reject before a tar pipeline exists (for example a wrong password).
  tar.on('error', () => {});
  let source: Awaited<ReturnType<typeof openArchiveStream>> | undefined;
  const tasks: Promise<unknown>[] = [];
  let success = false;
  const abort = () => {
    tar.destroy(signal.reason);
    source?.stream.destroy(signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  const watch = (task: Promise<unknown>) => {
    tasks.push(task);
    void task.catch((error: unknown) => controller.abort(error));
    return task;
  };
  try {
    source = await openArchiveStream(
      options.source,
      options.passphrase,
      signal,
    );
    const { stream: compressed } = source;
    let expanded = 0;
    let expandedLimit = limits.maxManifestBytes + 4 * 1024 * 1024;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        expanded += chunk.length;
        next(
          expanded > expandedLimit
            ? new Error('Archive expanded size exceeds limit')
            : null,
          chunk,
        );
      },
    });
    let manifest: ArchiveManifest | undefined;
    const seen = new Set<string>();
    const entries = new Map<string, ArchiveEntry>();
    watch(
      pipeline(
        compressed,
        createGunzip(),
        bounded,
        tar as unknown as Writable,
        { signal },
      ),
    );
    watch(
      (async () => {
        for await (const stream of tar) {
          signal.throwIfAborted();
          const header = stream.header;
          if (
            header.type !== 'file' ||
            header.linkname ||
            !Number.isSafeInteger(header.size) ||
            header.size < 0
          )
            throw new Error('Archive contains an unsupported entry');
          if (!manifest) {
            if (
              header.name !== MANIFEST ||
              header.size > limits.maxManifestBytes
            )
              throw new Error(
                'Archive manifest must be first and within its size limit',
              );
            const chunks: Buffer[] = [];
            for await (const chunk of stream)
              chunks.push(Buffer.from(chunk as Uint8Array));
            manifest = validate(
              new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.concat(chunks),
              ),
              limits,
            );
            for (const entry of manifest.entries)
              entries.set(entry.path, entry);
            expandedLimit =
              header.size +
              manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0) +
              4 * 1024 * 1024 +
              manifest.entries.length * 4096;
            continue;
          }
          const entry = entries.get(header.name);
          if (!entry || seen.has(header.name) || header.size !== entry.bytes)
            throw new Error(
              'Archive contains an unexpected, duplicate, or mismatched entry',
            );
          seen.add(header.name);
          const destination = join(options.stagingDirectory, entry.path);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await pipeline(
            Readable.from(stream),
            checksum(entry),
            createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
            { signal },
          );
        }
      })(),
    );
    // Do not return when tar ends: the full gzip and age streams must reach EOF,
    // including the final authentication tag and any trailing data validation.
    await Promise.all(tasks);
    signal.throwIfAborted();
    if (!manifest || seen.size !== entries.size)
      throw new Error('Archive is missing declared entries');
    success = true;
    return manifest;
  } finally {
    controller.abort(new Error('Archive operation finished'));
    await Promise.allSettled(tasks);
    signal.removeEventListener('abort', abort);
    await source?.close();
    if (!success)
      await rm(options.stagingDirectory, { recursive: true, force: true });
  }
}
