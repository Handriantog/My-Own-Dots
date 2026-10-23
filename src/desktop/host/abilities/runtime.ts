import { constants } from 'node:fs';
import { open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AbilityFailure } from '../../../shared/abilities/bridge.js';
import { DirectoryAnchor } from './package.js';
import { validateRuntime, type AbilityRuntime } from './sandbox.js';
export const runtimeSchema = z.strictObject({
  executable: z.string().min(1).max(4096),
  readRoots: z.array(z.string().min(1).max(4096)).min(1).max(16),
});
/** Inspect only: never run a candidate interpreter, shim or startup script. */
export async function inspectPython(path: string): Promise<AbilityRuntime> {
  let executable = await realpath(path);
  const framework = executable.match(
    /^(.*\/Python\.framework\/Versions\/[^/]+)\//,
  )?.[1];
  const root = framework ?? dirname(dirname(executable));
  // python.org's bin/python is a launcher that re-execs Python.app. Select
  // that inspected interpreter directly; do not grant worker process creation.
  if (
    framework &&
    /^\/bin\/python[0-9.]*$/.test(executable.slice(framework.length))
  ) {
    const interpreter = join(
      framework,
      'Resources/Python.app/Contents/MacOS/Python',
    );
    const resolved = await realpath(interpreter).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (resolved) {
      if (!resolved.startsWith(framework + '/'))
        throw new AbilityFailure('permission_denied');
      executable = resolved;
    }
  }
  if (
    root.split('/').length < 4 ||
    ['/usr', '/usr/local', '/opt/homebrew'].includes(root)
  )
    throw new AbilityFailure('permission_denied');
  const runtime = { executable, readRoots: [root] };
  await validateRuntime(runtime);
  return runtime;
}
export async function loadPython(
  root: string,
): Promise<AbilityRuntime | undefined> {
  await DirectoryAnchor.capture(root);
  const file = await open(
    join(root, 'python.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!file) return;
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > 16384
    )
      throw new AbilityFailure('permission_denied');
    const runtime = runtimeSchema.parse(
      JSON.parse(await file.readFile('utf8')),
    );
    await validateRuntime(runtime);
    return runtime;
  } finally {
    await file.close();
  }
}
export async function savePython(
  root: string,
  runtime: AbilityRuntime,
): Promise<void> {
  const anchor = await DirectoryAnchor.capture(root);
  await validateRuntime(runtime);
  const temporary = join(root, `python-${randomUUID()}.tmp`);
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(runtimeSchema.parse(runtime)));
      await file.sync();
    } finally {
      await file.close();
    }
    await anchor.check();
    await rename(temporary, join(root, 'python.json'));
  } finally {
    await rm(temporary, { force: true });
  }
}
