import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
