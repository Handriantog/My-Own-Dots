import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
