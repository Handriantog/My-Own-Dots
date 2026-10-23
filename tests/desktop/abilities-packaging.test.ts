import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'sealed Ability runtime distribution',
  () => {
    it('installs and runs independent JS, Python and native artifacts from a relocated production bundle', async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), 'ability-distribution-')),
      );
      roots.push(root);
      const built = join(root, 'built'),
        bundle = join(root, 'relocated'),
        cwd = join(root, 'unrelated');
      await mkdir(cwd);
      const builder = await import(
        pathToFileURL(resolve('scripts/abilities/build.mjs')).href
      );
      await builder.buildAbilityRuntime(process.cwd(), built);
      await cp(built, bundle, { recursive: true });
      await rm(built, { recursive: true });
      const bundleFiles = await readdir(bundle);
      expect(bundleFiles).not.toContain('dev-source.json');
      expect(bundleFiles).toEqual(
        expect.arrayContaining(['ability-runtime.cjs', 'native', 'abilities']),
      );
      const python =
        process.env.DOTS_ABILITY_TEST_PYTHON ||
        '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3';
      const artifactDirectory = join(root, 'artifacts');
      const { stdout } = await promisify(execFile)(python, [
        '-I',
        '-S',
        '-B',
        resolve('tests/fixtures/abilities/sealed/build.py'),
        artifactDirectory,
      ]);
      const artifacts: string[] = JSON.parse(stdout);
      const verifiedRuntimes: string[] = [];
      for (const artifact of artifacts) {
        const result = await promisify(execFile)(
          process.execPath,
          [
            resolve('scripts/abilities/smoke.mjs'),
            '--bundle',
            bundle,
            '--workspace',
            join(root, `workspace-${verifiedRuntimes.length}`),
            '--artifact',
            artifact,
            '--python',
            python,
          ],
          { cwd, env: { PATH: '/usr/bin:/bin', HOME: cwd }, timeout: 15000 },
        );
        verifiedRuntimes.push(JSON.parse(result.stdout).runtime);
      }
      expect(verifiedRuntimes.sort()).toEqual(['native', 'node', 'python']);
    }, 60000);
  },
);
