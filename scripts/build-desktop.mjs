import {
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { buildDesktopRuntime } from './desktop-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'dist/desktop');
mkdirSync(path.join(out, 'native'), { recursive: true });
await buildDesktopRuntime(root, path.join(out, 'app'));
writeFileSync(
  path.join(out, 'dev-source.json'),
  JSON.stringify({ sourceRoot: root }),
);
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
await build({
  entryPoints: [path.join(root, 'src/desktop/menu-preload.ts')],
  outfile: path.join(out, 'menu-preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
});
await build({
  entryPoints: [path.join(root, 'src/desktop/chat-preload.ts')],
  outfile: path.join(out, 'chat-preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
});
await build({
  entryPoints: [path.join(root, 'src/desktop/settings-preload.ts')],
  outfile: path.join(out, 'settings-preload.cjs'),
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
const workspaceRenderer = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    'build',
    '--config',
    path.join(root, 'vite.workspace.config.ts'),
  ],
  { cwd: root, stdio: 'inherit' },
);
if (workspaceRenderer.status !== 0) process.exit(workspaceRenderer.status ?? 1);
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
      description: 'A local AI desktop workspace and companion',
      author: 'My Own Dots',
      license: 'MIT',
    },
    null,
    2,
  ),
);
const audioDirectory = path.join(root, 'docs/demos/desktop-dot-audio');
mkdirSync(path.join(out, 'renderer/audio'), { recursive: true });
for (const name of readdirSync(audioDirectory))
  if (/^[a-z_-]+-\d{2}\.wav$/.test(name) || name === 'manifest.json')
    cpSync(
      path.join(audioDirectory, name),
      path.join(out, 'renderer/audio', name),
    );
// Wrap the existing 512px PNG unchanged in an ICNS ic09 entry; no bitmap resampling.
const png = readFileSync(path.join(root, 'public/dots/blue.png'));
const icon = Buffer.alloc(16 + png.length);
icon.write('icns', 0);
icon.writeUInt32BE(icon.length, 4);
icon.write('ic09', 8);
icon.writeUInt32BE(png.length + 8, 12);
png.copy(icon, 16);
writeFileSync(path.join(out, 'icon.icns'), icon);
console.log(`Built desktop app in ${out}`);
