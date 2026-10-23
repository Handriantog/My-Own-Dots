import { mkdir, cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { build } from 'esbuild';

export async function buildAbilityRuntime(root, out) {
  if (process.platform !== 'darwin')
    throw new Error('Ability packaging requires macOS.');
  await mkdir(join(out, 'native'), { recursive: true });
  await promisify(execFile)('/usr/bin/xcrun', [
    'clang',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-Wno-deprecated-declarations',
    '-O2',
    '-mmacosx-version-min=14.0',
    join(root, 'native/ability-launcher/main.c'),
    '-o',
    join(out, 'native/ability-launcher'),
  ]);
  await promisify(execFile)('/usr/bin/xcrun', [
    'clang',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fobjc-arc',
    '-fblocks',
    '-O2',
    '-mmacosx-version-min=14.0',
    '-framework',
    'Foundation',
    '-framework',
    'AppKit',
    '-framework',
    'Carbon',
    join(root, 'native/spotify-control/main.m'),
    '-o',
    join(out, 'native/spotify-control'),
  ]);
  await build({
    entryPoints: [join(root, 'src/desktop/host/abilities/distribution.ts')],
    outfile: join(out, 'ability-runtime.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
  });
  await cp(join(root, 'docs/abilities'), join(out, 'abilities'), {
    recursive: true,
  });
}

// Controller loads the same production bundle that sealed-artifact tests use.
export const abilityRuntimePlugin = {
  name: 'ability-runtime',
  setup(builder) {
    builder.onResolve({ filter: /^\.\/host\.js$/ }, (args) =>
      args.importer.endsWith('/src/desktop/host/abilities/controller.ts')
        ? { path: './ability-runtime.cjs', external: true }
        : undefined,
    );
  },
};
