import { mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'dist/desktop');
mkdirSync(path.join(out, 'native'), { recursive: true });
if (process.platform !== 'darwin')
  throw new Error('The desktop observer currently builds on macOS only.');
const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const compile = spawnSync(
  'swiftc',
  [
    '-O',
    '-target',
    `${architecture}-apple-macosx14.0`,
    path.join(root, 'native/desktop-observer/main.swift'),
    '-o',
    path.join(out, 'native/desktop-observer'),
  ],
  { stdio: 'inherit' },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);
console.log(`Built macOS ${process.arch} geometry observer.`);
await build({
  entryPoints: [path.join(root, 'src/desktop/main.ts')],
  outfile: path.join(out, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
});
await build({
  entryPoints: [path.join(root, 'src/desktop/preload.ts')],
  outfile: path.join(out, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
});
const renderer = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    'build',
    '--config',
    path.join(root, 'vite.desktop.config.ts'),
  ],
  { cwd: root, stdio: 'inherit' },
);
if (renderer.status !== 0) process.exit(renderer.status ?? 1);
cpSync(
  path.join(root, 'public/desktop-dot'),
  path.join(out, 'renderer/desktop-dot'),
  { recursive: true },
);
cpSync(
  path.join(root, 'public/dots/blue.png'),
  path.join(out, 'renderer/desktop-dot/icon.png'),
);
writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'my-own-dots-desktop',
      productName: 'My Own Dots',
      version: '0.1.0',
      main: 'main.cjs',
      description: 'A plush desktop companion',
      author: 'My Own Dots',
      license: 'MIT',
    },
    null,
    2,
  ),
);
console.log(`Built desktop app in ${out}`);
