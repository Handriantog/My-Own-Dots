import assert from 'node:assert/strict';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('Ability package smoke requires macOS arm64.');
const { values } = parseArgs({
  options: { app: { type: 'string' }, python: { type: 'string' } },
});
const root = fileURLToPath(new URL('../..', import.meta.url));
const source = resolve(
  values.app || join(root, 'release/My Own Dots-darwin-arm64/My Own Dots.app'),
);
const pythonCommand =
  values.python || process.env.DOTS_ABILITY_TEST_PYTHON || 'python3';
// This is the already selected test interpreter, not the product's picker.
const python = (
  await promisify(execFile)(pythonCommand, [
    '-I',
    '-S',
    '-B',
    '-c',
    'import os, sys; print(os.path.realpath(sys.executable))',
  ])
).stdout.trim();
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), 'dots-sealed-app-')),
);
try {
  const app = join(temporary, 'Relocated Dots.app'),
    cwd = join(temporary, 'unrelated');
  await cp(source, app, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
  });
  await mkdir(cwd);
  const bundle = join(app, 'Contents/Resources/app'),
    node = join(app, 'Contents/MacOS/My Own Dots');
  const bundleFiles = await readdir(bundle);
  assert(!bundleFiles.includes('dev-source.json'));
  assert.match(
    await readFile(join(bundle, 'main.cjs'), 'utf8'),
    /require\(["']\.\/ability-runtime\.cjs["']\)/,
  );
  await promisify(execFile)('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    app,
  ]);
  const sealed = await promisify(execFile)(python, [
    '-I',
    '-S',
    '-B',
    join(root, 'tests/fixtures/abilities/sealed/build.py'),
    join(temporary, 'artifacts'),
  ]);
  const verifiedRuntimes = [];
  for (const artifact of JSON.parse(sealed.stdout)) {
    const result = await promisify(execFile)(
      node,
      [
        join(root, 'scripts/abilities/smoke.mjs'),
        '--bundle',
        bundle,
        '--workspace',
        join(temporary, `workspace-${verifiedRuntimes.length}`),
        '--artifact',
        artifact,
        '--python',
        python,
        '--node',
        node,
      ],
      {
        cwd,
        env: { PATH: '/usr/bin:/bin', HOME: cwd, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 20000,
      },
    );
    verifiedRuntimes.push(JSON.parse(result.stdout).runtime);
  }
  assert.deepEqual(verifiedRuntimes.sort(), ['native', 'node', 'python']);
  console.log(
    JSON.stringify({
      verifiedRuntimes,
      bundleFiles,
      copiedApp: true,
      transport: 'offline-fixture',
      signing: 'verified',
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
