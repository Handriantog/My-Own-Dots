import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  ARCHIVE_LIMITS,
  type ArchiveEntry,
} from '../../shared/storage-archive.js';
import { validateArchivePaths } from './archive-paths.js';
import { DirectoryAnchor } from '../../shared/abilities/directory.js';

/** directory and remap are host-only staging context, never archive-authored paths. */
export interface AbilitySnapshot {
  version: 1;
  directory: string;
  entries: ArchiveEntry[];
  remap?: Record<string, string>;
}
function statePath(path: string) {
  validateArchivePaths([path]);
  if (
    !/^abilities\/state\/[a-f0-9]{64}\/.+/.test(path) ||
    path.split('/')[3] === 'tmp'
  )
    throw new Error('Invalid Ability state path');
}
async function copy(
  source: string,
  destination: string,
  signal: AbortSignal,
  expected?: ArchiveEntry,
): Promise<ArchiveEntry> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const before = await input.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(ARCHIVE_LIMITS.maxFileBytes)
    )
      throw new Error('Invalid Ability state file');
    output = await open(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > ARCHIVE_LIMITS.maxFileBytes)
        throw new Error('Ability state exceeds limit');
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    const after = await input.stat({ bigint: true }),
      sha256 = hash.digest('hex');
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.nlink !== 1n ||
      BigInt(bytes) !== before.size ||
      (expected && (expected.bytes !== bytes || expected.sha256 !== sha256))
    )
      throw new Error('Ability state changed or failed verification');
    signal.throwIfAborted();
    await output.sync();
    return { path: '', bytes, sha256 };
  } finally {
    await input.close();
    await output?.close();
  }
}
/** Call only after the host has stopped workers and maintenance excludes writes. */
export async function captureAbilityState(
  workspaceRoot: string,
  destination: string,
  signal: AbortSignal,
): Promise<AbilitySnapshot> {
  signal.throwIfAborted();
  const directory = await realpath(workspaceRoot),
    source = join(directory, 'abilities/state');
  const snapshot: AbilitySnapshot = {
    version: 1,
    directory: destination,
    entries: [],
  };
  const existing = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!existing) return snapshot;
  const anchors = [
    await DirectoryAnchor.capture(join(directory, 'abilities')),
    await DirectoryAnchor.capture(source),
  ];
  const paths: string[] = [];
  let directoryCount = 0;
  const visit = async (relative: string) => {
    signal.throwIfAborted();
    if (++directoryCount > ARCHIVE_LIMITS.maxEntries)
      throw new Error('Ability state exceeds directory limit');
    validateArchivePaths([relative + '/.directory-check']);
    anchors.push(await DirectoryAnchor.capture(join(directory, relative)));
    for (const item of await readdir(join(directory, relative), {
      withFileTypes: true,
    })) {
      if (relative.split('/').length === 3 && item.name === 'tmp') continue;
      const path = `${relative}/${item.name}`;
      if (relative === 'abilities/state' && !/^[a-f0-9]{64}$/.test(item.name))
        throw new Error('Invalid Ability state binding');
      if (item.isDirectory()) await visit(path);
      else if (item.isFile()) {
        statePath(path);
        paths.push(path);
        if (paths.length > ARCHIVE_LIMITS.maxEntries)
          throw new Error('Ability state exceeds limit');
      } else
        throw new Error('Ability state cannot contain links or special files');
    }
  };
  await visit('abilities/state');
  paths.sort();
  validateArchivePaths(paths);
  if (!paths.length) return snapshot;
  await mkdir(destination, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    },
  );
  destination = await realpath(destination);
  snapshot.directory = destination;
  await DirectoryAnchor.capture(destination);
  await mkdir(join(destination, 'abilities'), { mode: 0o700 });
  let total = 0;
  try {
    for (const path of paths) {
      signal.throwIfAborted();
      await mkdir(dirname(join(destination, path)), {
        recursive: true,
        mode: 0o700,
      });
      const entry = await copy(
        join(directory, path),
        join(destination, path),
        signal,
      );
      total += entry.bytes;
      if (total > ARCHIVE_LIMITS.maxTotalBytes)
        throw new Error('Ability state exceeds limit');
      snapshot.entries.push({ ...entry, path });
    }
    for (const anchor of anchors) await anchor.check();
    return snapshot;
  } catch (error) {
    await rm(join(destination, 'abilities'), { recursive: true, force: true });
    throw error;
  }
}
export async function restoreAbilityState(
  snapshot: AbilitySnapshot,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (snapshot.version !== 1) throw new Error('Unsupported Ability snapshot');
  const paths = snapshot.entries.map((entry) => entry.path);
  validateArchivePaths(paths);
  for (const path of paths) statePath(path);
  if (!paths.length) return;
  const mapped = paths.map((path) => {
    const parts = path.split('/'),
      key = snapshot.remap?.[parts[2]] ?? parts[2];
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error('Invalid Ability state remapping');
    return [key, ...parts.slice(3)].join('/');
  });
  validateArchivePaths(mapped);
  workspaceRoot = await realpath(workspaceRoot);
  snapshot = { ...snapshot, directory: await realpath(snapshot.directory) };
  const root = await DirectoryAnchor.capture(workspaceRoot),
    source = await DirectoryAnchor.capture(snapshot.directory);
  const parent = join(workspaceRoot, 'abilities');
  await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const anchor = await DirectoryAnchor.capture(parent),
    temporary = join(parent, `.restore-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  let total = 0;
  try {
    for (let index = 0; index < snapshot.entries.length; index++) {
      const entry = snapshot.entries[index];
      signal.throwIfAborted();
      total += entry.bytes;
      if (
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        total > ARCHIVE_LIMITS.maxTotalBytes ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      )
        throw new Error('Invalid Ability state inventory');
      const segments = entry.path.split('/');
      let current = snapshot.directory;
      for (const segment of segments.slice(0, -1)) {
        current = join(current, segment);
        await DirectoryAnchor.capture(current);
      }
      const target = join(temporary, mapped[index]);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copy(join(snapshot.directory, entry.path), target, signal, entry);
    }
    await root.check();
    await anchor.check();
    await source.check();
    signal.throwIfAborted();
    if (
      await lstat(join(parent, 'state')).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      )
    )
      throw new Error('Ability state destination already exists');
    await rename(temporary, join(parent, 'state'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
/** Called within the existing restore/host-change transaction; metadata grants are inert. */
export function invalidateAbilityTrust(db: DatabaseSync): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ability_bindings'",
      )
      .get()
  )
    return;
  db.exec(
    "UPDATE ability_bindings SET enabled=0,restored=1,revision=revision+1; UPDATE ability_receipts SET state='settled',outcome='{\"status\":\"uncertain\"}',settledAt=coalesce(settledAt,createdAt) WHERE state='running'",
  );
}

export function abilityStateRemap(
  db: DatabaseSync,
  fromWorkspace: string,
  toWorkspace: string,
): Record<string, string> {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ability_bindings'",
      )
      .get()
  )
    return {};
  const cleanup = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ability_cleanup'",
    )
    .get()
    ? ' UNION SELECT bindingId AS id FROM ability_cleanup'
    : '';
  return Object.fromEntries(
    db
      .prepare('SELECT id FROM ability_bindings' + cleanup)
      .all()
      .map((row) =>
        [fromWorkspace, toWorkspace].map((workspace) =>
          createHash('sha256')
            .update(JSON.stringify([workspace, String(row.id)]))
            .digest('hex'),
        ),
      ),
  );
}
