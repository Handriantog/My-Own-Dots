import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { localVoiceConfig } from '../../src/server/local-voice/service.js';
// Import a JavaScript build helper exercised against a tiny dependency fixture.
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it('resolves speech sidecars from the runtime rather than the selected data directory', () => {
  const config = localVoiceConfig({ DOTS_RUNTIME_ROOT: '/packaged/runtime' });
  expect(config.worker).toBe('/packaged/runtime/scripts/local-voice/worker.py');
  expect(config.manifest).toBe(
    '/packaged/runtime/scripts/local-voice/manifest.json',
  );
});
it('stages production dependency closure with Python sources and without developer state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dots-package-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'node_modules/engine/python/.venv/bin'), {
    recursive: true,
  });
  await mkdir(path.join(root, 'node_modules/engine/python/pkg'), {
    recursive: true,
  });
  await mkdir(path.join(root, 'node_modules/engine/node_modules/helper'), {
    recursive: true,
  });
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      dependencies: { engine: '1.0.0' },
      devDependencies: { dev: '1.0.0' },
    }),
  );
  await writeFile(
    path.join(root, 'node_modules/engine/package.json'),
    JSON.stringify({
      name: 'engine',
      version: '1.0.0',
      dependencies: { helper: '1.0.0' },
    }),
  );
  for (const name of [
    'pyproject.toml',
    'uv.lock',
    'bridge.py',
    'pkg/engine.py',
  ])
    await writeFile(
      path.join(root, 'node_modules/engine/python', name),
      'runtime',
    );
  for (const name of ['.env', 'live.sqlite', 'python/.venv/bin/python'])
    await writeFile(path.join(root, 'node_modules/engine', name), 'secret');
  await writeFile(
    path.join(root, 'node_modules/engine/node_modules/helper/package.json'),
    JSON.stringify({ name: 'helper', version: '1.0.0' }),
  );
  await writeFile(
    path.join(root, 'node_modules/engine/node_modules/helper/index.js'),
    'export const value=42',
  );
  const helper = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/desktop-runtime.mjs')).href
  );
  await helper.stageProductionDependencies(root, path.join(root, 'out'));
  expect(
    await readFile(
      path.join(root, 'out/node_modules/engine/python/bridge.py'),
      'utf8',
    ),
  ).toBe('runtime');
  expect(
    await readFile(
      path.join(root, 'out/node_modules/engine/python/pkg/engine.py'),
      'utf8',
    ),
  ).toBe('runtime');
  expect(
    await readFile(
      path.join(root, 'out/node_modules/engine/node_modules/helper/index.js'),
      'utf8',
    ),
  ).toContain('42');
  for (const name of ['.env', 'live.sqlite', 'python/.venv/bin/python'])
    await expect(
      readFile(path.join(root, 'out/node_modules/engine', name)),
    ).rejects.toThrow();
});

it.skipIf(process.platform !== 'darwin')(
  'runs the shipped integration setup with a native PATH and preserves an explicit uv override',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dots-setup-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const support = path.join(root, 'support');
    const workspace = path.join(root, 'workspace');
    const bin = path.join(root, '.local/bin');
    const python = path.join(root, 'node_modules/myown-llm-integrator/python');
    for (const directory of [support, workspace, bin, python])
      await mkdir(directory, { recursive: true });
    for (const name of [
      'setup-desktop-integrations.mjs',
      'native-executable-environment.mjs',
    ])
      await cp(
        path.join(process.cwd(), 'scripts', name),
        path.join(support, name),
      );
    await writeFile(path.join(python, 'pyproject.toml'), '[project]');
    for (const name of ['uv', 'explicit-uv'])
      await writeFile(
        path.join(bin, name),
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.SETUP_LOG,'${name}');`,
        { mode: 0o755 },
      );
    const log = path.join(root, 'setup-log');
    const execute = () =>
      promisify(execFile)(
        process.execPath,
        [path.join(support, 'setup-desktop-integrations.mjs'), workspace],
        {
          env: {
            HOME: root,
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            SETUP_LOG: log,
          },
        },
      );
    await writeFile(
      path.join(workspace, '.env'),
      'MYOWN_LLM_PYTHON=/kept/python\n',
    );
    await execute();
    expect(await readFile(log, 'utf8')).toBe('uv');
    await writeFile(
      path.join(workspace, '.env'),
      `MYOWN_LLM_PYTHON=/kept/python\nUV_BIN=${path.join(bin, 'explicit-uv')}\n`,
    );
    await execute();
    expect(await readFile(log, 'utf8')).toBe('explicit-uv');
    expect(await readFile(path.join(workspace, '.env'), 'utf8')).toContain(
      'MYOWN_LLM_PYTHON=/kept/python',
    );
  },
);
