import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';
import { AbilityFailure } from '../../../shared/abilities/bridge.js';

export type AbilityRuntime = { executable: string; readRoots: string[] };
const inside = (path: string, root: string) =>
  path === root || path.startsWith(root + '/');
function absolute(path: string): void {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path === '/' ||
    [...path].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new AbilityFailure('permission_denied');
}
export function buildSandboxProfile(input: {
  packageRoot: string;
  stateRoot: string;
  temporaryRoot: string;
  executable: string;
  runtimeReadRoots: string[];
}): string {
  for (const path of [
    input.packageRoot,
    input.stateRoot,
    input.temporaryRoot,
    input.executable,
    ...input.runtimeReadRoots,
  ])
    absolute(path);
  if (
    input.temporaryRoot !== input.stateRoot + '/tmp' ||
    inside(input.packageRoot, input.stateRoot) ||
    inside(input.stateRoot, input.packageRoot) ||
    input.runtimeReadRoots.some(
      (root) =>
        root.split('/').length < 3 ||
        inside(input.stateRoot, root) ||
        inside(input.packageRoot, root),
    )
  )
    throw new AbilityFailure('permission_denied');
  const reads = [
    ...new Set([
      '/System/Library',
      '/usr/lib',
      '/private/var/db/dyld',
      input.packageRoot,
      ...input.runtimeReadRoots,
    ]),
  ];
  const ancestors = new Set<string>();
  for (const path of [...reads, input.executable, input.stateRoot]) {
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      ancestors.add(parent);
      if (parent === '/') break;
    }
  }
  const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
  return [
    '(version 1)',
    '(deny default)',
    '(allow sysctl-read)',
    '(allow signal (target self))',
    '(allow file-read-data (literal "/"))',
    `(allow file-read-metadata ${[...ancestors].sort().map(literal).join(' ')})`,
    ...reads.map(
      (path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`,
    ),
    `(allow file-read* ${literal(input.executable)})`,
    `(allow file-read* file-write* (subpath ${JSON.stringify(input.stateRoot)}))`,
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
    `(allow process-exec ${literal(input.executable)})`,
  ].join('\n');
}

/** Inspect binaries without executing an interpreter or package startup hook. */
export async function validateExecutable(
  path: string,
  confined = false,
): Promise<void> {
  absolute(path);
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new AbilityFailure('unsupported_platform');
  if ((await realpath(path)) !== path)
    throw new AbilityFailure('permission_denied');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      !(info.mode & 0o111) ||
      info.mode & (confined ? 0o002 : 0o022) ||
      (info.uid !== 0 && info.uid !== process.getuid?.())
    )
      throw new AbilityFailure('permission_denied');
    const header = Buffer.alloc(4096);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const arm64 = (offset: number) =>
      offset + 16 <= bytesRead &&
      header.readUInt32LE(offset) === 0xfeedfacf &&
      header.readUInt32LE(offset + 4) === 0x0100000c &&
      header.readUInt32LE(offset + 12) === 2;
    if (arm64(0)) return;
    const magic = header.readUInt32BE(0),
      count = header.readUInt32BE(4);
    if (![0xcafebabe, 0xcafebabf].includes(magic) || count < 1 || count > 16)
      throw new AbilityFailure('unsupported_platform');
    const stride = magic === 0xcafebabe ? 20 : 32;
    for (let index = 0; index < count; index++) {
      const start = 8 + index * stride;
      if (
        start + stride > bytesRead ||
        header.readUInt32BE(start) !== 0x0100000c
      )
        continue;
      const offset =
        stride === 20
          ? header.readUInt32BE(start + 8)
          : Number(header.readBigUInt64BE(start + 8));
      if (
        !Number.isSafeInteger(offset) ||
        offset < 8 + count * stride ||
        offset + 16 > info.size
      )
        continue;
      const slice = Buffer.alloc(16);
      await file.read(slice, 0, slice.length, offset);
      if (
        slice.readUInt32LE(0) === 0xfeedfacf &&
        slice.readUInt32LE(4) === 0x0100000c &&
        slice.readUInt32LE(12) === 2
      )
        return;
    }
    throw new AbilityFailure('unsupported_platform');
  } finally {
    await file.close();
  }
}
export async function validateRuntime(runtime: AbilityRuntime): Promise<void> {
  // Selected interpreters (including admin-writable Python frameworks) run
  // inside confinement. The trusted watchdog retains the stricter file check.
  await validateExecutable(runtime.executable, true);
  if (runtime.readRoots.length > 16)
    throw new AbilityFailure('permission_denied');
  for (const root of runtime.readRoots) {
    absolute(root);
    const info = await lstat(root);
    if (
      (await realpath(root)) !== root ||
      !info.isDirectory() ||
      info.mode & 0o002 ||
      (info.uid !== 0 && info.uid !== process.getuid?.())
    )
      throw new AbilityFailure('permission_denied');
  }
}
