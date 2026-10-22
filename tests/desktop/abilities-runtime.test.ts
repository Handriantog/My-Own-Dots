import { afterEach, describe, expect, it } from 'vitest';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  inspectPython,
  loadPython,
  savePython,
} from '../../src/desktop/host/abilities/runtime.ts';
const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function root() {
  const path = await realpath(
    await mkdtemp(join(tmpdir(), 'ability-runtime-')),
  );
  paths.push(path);
  return path;
}
describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'private runtime selection',
  () => {
    it('inspects the chosen binary without executing scripts and preserves only the approved canonical read roots', async () => {
      const home = await root(),
        script = join(home, 'python3');
      await writeFile(
        script,
        '#!/bin/sh\ntouch "' + join(home, 'executed') + '"',
        { mode: 0o700 },
      );
      await expect(inspectPython(script)).rejects.toThrow();
      await expect(readFile(join(home, 'executed'))).rejects.toThrow();
      const binary = await realpath(process.execPath),
        runtime = await inspectPython(binary);
      expect(runtime).toEqual({
        executable: binary,
        readRoots: [dirname(dirname(binary))],
      });
      await savePython(home, runtime);
      expect(await loadPython(home)).toEqual(runtime);
      await chmod(join(home, 'python.json'), 0o666);
      await expect(loadPython(home)).rejects.toThrow();
    });
    it('rejects redirected preference files and unsupported broad interpreter roots', async () => {
      const home = await root(),
        other = await root();
      await writeFile(join(other, 'outside'), '{}');
      await symlink(join(other, 'outside'), join(home, 'python.json'));
      await expect(loadPython(home)).rejects.toThrow();
      await expect(inspectPython('/usr/bin/python3')).rejects.toThrow();
    });
    it('recognizes the versioned Python framework read root without probing the interpreter', async () => {
      const home = await root(),
        framework = join(home, 'Python.framework/Versions/3.14');
      await mkdir(join(framework, 'Resources/Python.app/Contents/MacOS'), {
        recursive: true,
      });
      const binary = join(
        framework,
        'Resources/Python.app/Contents/MacOS/Python',
      );
      await copyFile(await realpath(process.execPath), binary);
      await chmod(binary, 0o700);
      expect((await inspectPython(binary)).readRoots).toEqual([framework]);
    });
  },
);
