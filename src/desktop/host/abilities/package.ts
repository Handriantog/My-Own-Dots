import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import { validateArchivePaths } from '../../../server/storage/archive-paths.js';
import { abilityLimits } from '../../../shared/abilities/limits.js';
import {
  parseManifest,
  parseReleaseDescriptor,
} from '../../../shared/abilities/manifest.js';
import { canonicalJson } from '../../../shared/abilities/permissions.js';
import type {
  InstallReview,
  VerifiedPackage,
} from '../../../shared/abilities/types.js';

/** Parents are host-private: never choose an Ability-writable state directory. */
export class DirectoryAnchor {
  private constructor(
    readonly path: string,
    private readonly device: number,
    private readonly inode: number,
  ) {}
  static async capture(path: string): Promise<DirectoryAnchor> {
    if (!isAbsolute(path) || (await realpath(path)) !== path)
      throw new Error('Unsafe Ability directory');
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.mode & 0o022 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Ability directory must be host-private');
    return new DirectoryAnchor(path, stat.dev, stat.ino);
  }
  async check(): Promise<void> {
    const current = await DirectoryAnchor.capture(this.path);
    if (current.device !== this.device || current.inode !== this.inode)
      throw new Error('Ability directory changed');
  }
}
async function directories(
  root: DirectoryAnchor,
  relative: string,
): Promise<void> {
  let path = root.path;
  for (const part of relative.split('/').slice(0, -1)) {
    await root.check();
    path = join(path, part);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path)
      throw new Error('Ability parent replaced');
  }
  await root.check();
}
type PackageFile = VerifiedPackage['files'][number];
async function scan(
  file: FileHandle,
  review: InstallReview,
  signal: AbortSignal,
  destination?: DirectoryAnchor,
): Promise<PackageFile[]> {
  const descriptor = review.descriptor;
  const expected = descriptor.asset;
  const controller = new AbortController();
  const abort = AbortSignal.any([signal, controller.signal]);
  const parser = extract();
  const files: PackageFile[] = [];
  const names = new Map<
    string,
    { spelling: string; file: boolean; explicit: boolean }
  >();
  const executablePaths = new Set(
    [
      descriptor.manifest.entrypoint,
      ...descriptor.manifest.helpers.map((h) => h.entrypoint),
    ].map((e) => e.path),
  );
  let entries = 0,
    total = 0,
    compressed = 0,
    inflated = 0;
  const archiveHash = createHash('sha256');
  let manifestSeen = false;
  const tasks: Promise<void>[] = [];
  parser.on('entry', (header, stream, next) => {
    const task = (async () => {
      abort.throwIfAborted();
      if (
        ++entries > abilityLimits.archiveEntries ||
        !['file', 'directory'].includes(header.type ?? 'file')
      )
        throw new Error('Unsupported Ability archive entry');
      const name =
        header.type === 'directory' && header.name.endsWith('/')
          ? header.name.slice(0, -1)
          : header.name;
      validateArchivePaths([name], {
        maxPathBytes: 1024,
        maxEntries: abilityLimits.archiveEntries,
      });
      const parts = name.split('/');
      for (let i = 0; i < parts.length; i++) {
        const spelling = parts.slice(0, i + 1).join('/');
        const key = spelling.normalize('NFC').toUpperCase().toLowerCase();
        const leaf = i === parts.length - 1,
          isFile = leaf && header.type !== 'directory';
        const previous = names.get(key);
        if (
          previous &&
          (previous.spelling !== spelling ||
            previous.file ||
            isFile ||
            (leaf && previous.explicit))
        )
          throw new Error('Aliased Ability archive path');
        names.set(key, {
          spelling,
          file: isFile,
          explicit: leaf || previous?.explicit === true,
        });
      }
      const size = header.size ?? 0;
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > expected.extractedBytes ||
        (header.mode ?? 0) & 0o7000
      )
        throw new Error('Invalid Ability archive size or mode');
      if (header.type === 'directory') {
        if (size !== 0) throw new Error('Invalid Ability directory');
        stream.resume();
        next();
        return;
      }
      total += size;
      if (total > expected.extractedBytes || files.length >= expected.fileCount)
        throw new Error('Ability archive exceeds declared limits');
      const executable = Boolean((header.mode ?? 0) & 0o111);
      if (executable && !executablePaths.has(name))
        throw new Error('Undeclared Ability executable');
      if (name === 'ability.json' && size > abilityLimits.descriptorBytes)
        throw new Error('Ability manifest exceeds limit');
      let output: FileHandle | undefined;
      if (destination) {
        await directories(destination, name);
        output = await open(
          join(destination.path, name),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
      }
      const hash = createHash('sha256'),
        manifest: Buffer[] = [];
      let bytes = 0;
      try {
        for await (const raw of stream as unknown as Readable) {
          abort.throwIfAborted();
          const chunk = Buffer.from(raw);
          bytes += chunk.length;
          if (bytes > size)
            throw new Error('Ability file exceeds declared size');
          hash.update(chunk);
          if (name === 'ability.json') manifest.push(chunk);
          if (output) {
            let offset = 0;
            while (offset < chunk.length) {
              const written = await output.write(chunk.subarray(offset));
              if (!written.bytesWritten)
                throw new Error('Incomplete Ability write');
              offset += written.bytesWritten;
            }
          }
        }
        if (bytes !== size) throw new Error('Truncated Ability file');
        if (name === 'ability.json') {
          if (
            canonicalJson(
              parseManifest(
                JSON.parse(Buffer.concat(manifest).toString('utf8')),
              ),
            ) !== canonicalJson(descriptor.manifest)
          )
            throw new Error('Ability manifest differs from review');
          manifestSeen = true;
        }
        if (output) {
          await output.chmod(executable ? 0o555 : 0o444);
          await output.sync();
        }
        files.push({
          path: name,
          size,
          sha256: hash.digest('hex'),
          executable,
        });
      } finally {
        await output?.close();
      }
      next();
    })();
    tasks.push(task);
    void task.catch((error: unknown) => {
      controller.abort(error);
      parser.destroy(error as Error);
    });
  });
  const boundCompressed = new Transform({
    transform(chunk: Buffer, _encoding, next) {
      compressed += chunk.length;
      if (compressed > expected.compressedBytes)
        return next(new Error('Ability compressed limit exceeded'));
      archiveHash.update(chunk);
      next(null, chunk);
    },
  });
  const boundInflated = new Transform({
    transform(chunk: Buffer, _encoding, next) {
      inflated += chunk.length;
      if (
        inflated >
        Math.min(abilityLimits.extractedBytes, expected.extractedBytes) +
          (abilityLimits.archiveEntries + 2) * 1024
      )
        return next(new Error('Ability inflated limit exceeded'));
      next(null, chunk);
    },
  });
  try {
    await pipeline(
      file.createReadStream({ start: 0, autoClose: false }),
      boundCompressed,
      createGunzip(),
      boundInflated,
      parser,
      { signal: abort },
    );
    await Promise.all(tasks);
    if (
      !manifestSeen ||
      total !== expected.extractedBytes ||
      files.length !== expected.fileCount ||
      compressed !== expected.compressedBytes ||
      archiveHash.digest('hex') !== expected.sha256
    )
      throw new Error('Ability artifact differs from review');
    validateArchivePaths(
      files.map((entry) => entry.path),
      { maxEntries: abilityLimits.archiveEntries },
    );
    for (const entrypoint of [
      descriptor.manifest.entrypoint,
      ...descriptor.manifest.helpers.map((h) => h.entrypoint),
    ]) {
      const entry = files.find((f) => f.path === entrypoint.path);
      if (!entry || (entrypoint.runtime === 'native' && !entry.executable))
        throw new Error('Missing Ability entrypoint');
    }
    return files.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  } finally {
    controller.abort();
    await Promise.allSettled(tasks);
  }
}

export async function verifyAbilityPackage(
  archivePath: string,
  review: InstallReview,
  stagingRoot: string,
  signal: AbortSignal,
): Promise<VerifiedPackage> {
  parseReleaseDescriptor(review.descriptor);
  signal.throwIfAborted();
  const parent = await DirectoryAnchor.capture(stagingRoot);
  const archive = await open(
    archivePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let staging: string | undefined;
  try {
    const stat = await archive.stat();
    if (!stat.isFile() || stat.size !== review.descriptor.asset.compressedBytes)
      throw new Error('Invalid Ability archive');
    // Validate all names, types, sizes, manifest and bytes before creating files.
    const files = await scan(archive, review, signal);
    await parent.check();
    staging = await mkdtemp(join(stagingRoot, 'package-'));
    await parent.check();
    const destination = await DirectoryAnchor.capture(staging);
    const extracted = await scan(archive, review, signal, destination);
    await parent.check();
    await destination.check();
    if (canonicalJson(files) !== canonicalJson(extracted))
      throw new Error('Ability archive changed during extraction');
    return {
      digest: review.descriptor.asset.sha256,
      descriptor: review.descriptor,
      manifest: review.descriptor.manifest,
      root: staging,
      files,
    };
  } catch (error) {
    if (staging) {
      // Do not traverse a parent that has been substituted during the operation.
      try {
        await parent.check();
        await rm(staging, { recursive: true, force: true });
      } catch {
        /* Leave detached staging for host recovery. */
      }
    }
    throw error;
  } finally {
    await archive.close();
  }
}

export async function verifyInstalledPackage(
  pkg: VerifiedPackage,
): Promise<void> {
  const root = await DirectoryAnchor.capture(pkg.root);
  const found: string[] = [];
  async function walk(relative: string): Promise<void> {
    await root.check();
    for (const entry of await readdir(join(root.path, relative), {
      withFileTypes: true,
    })) {
      const path = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
      else throw new Error('Ability package contains a link or special file');
    }
  }
  await walk('');
  if (
    canonicalJson(found.sort()) !==
    canonicalJson(pkg.files.map((f) => f.path).sort())
  )
    throw new Error('Ability package file set changed');
  for (const entry of pkg.files) {
    const path = join(root.path, entry.path);
    if ((await realpath(path)) !== path)
      throw new Error('Ability package path changed');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size !== entry.size ||
        stat.mode & 0o222 ||
        Boolean(stat.mode & 0o111) !== entry.executable
      )
        throw new Error('Ability package file changed');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        hash.update(chunk);
      if (hash.digest('hex') !== entry.sha256)
        throw new Error('Ability package checksum changed');
    } finally {
      await handle.close();
    }
  }
  await root.check();
}
