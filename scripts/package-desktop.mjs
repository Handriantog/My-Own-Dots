import { packager } from '@electron/packager';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.platform !== 'darwin')
  throw new Error('The first desktop release is macOS only.');
const electronVersion = JSON.parse(
  readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8'),
).version;
const bundles = await packager({
  dir: path.join(root, 'dist/desktop'),
  out: path.join(root, 'release'),
  name: 'My Own Dots',
  executableName: 'My Own Dots',
  appBundleId: 'com.myownstack.dots.desktop',
  appCategoryType: 'public.app-category.productivity',
  electronVersion,
  platform: 'darwin',
  arch: process.arch,
  icon: path.join(root, 'dist/desktop/icon.icns'),
  overwrite: true,
  prune: false,
  asar: false,
  extendInfo: {
    LSUIElement: true,
    LSMinimumSystemVersion: '14.0',
    NSHighResolutionCapable: true,
    NSHumanReadableCopyright: 'My Own Dots',
  },
});
for (const directory of bundles) {
  const app = path.join(directory, 'My Own Dots.app');
  // Local ad-hoc signature validates the assembled bundle. This is not Developer ID
  // signing or notarization, and does not claim public Gatekeeper distribution.
  const sign = spawnSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', app],
    { stdio: 'inherit' },
  );
  if (sign.status !== 0) process.exit(sign.status ?? 1);
  const verify = spawnSync(
    'codesign',
    ['--verify', '--deep', '--strict', app],
    { stdio: 'inherit' },
  );
  if (verify.status !== 0) process.exit(verify.status ?? 1);
  const zip = path.join(
    root,
    'release',
    `My-Own-Dots-macOS-${process.arch}.zip`,
  );
  const archive = spawnSync(
    'ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip],
    { stdio: 'inherit' },
  );
  if (archive.status !== 0) process.exit(archive.status ?? 1);
  writeFileSync(
    path.join(root, 'release/BUILD.txt'),
    `My Own Dots 0.1.0\nBuilt: ${new Date().toISOString()}\nArchitecture: ${process.arch}\nElectron: ${electronVersion}\nSigning: local ad-hoc only; not notarized\nRuntime: bundled; no Node/Python/Docker/backend required\nApp: ${app}\nZip: ${zip}\n`,
  );
  console.log(
    `App: ${app}\nArchive: ${zip}\nLocal ad-hoc build; public signing and notarization remain a release step.`,
  );
}
