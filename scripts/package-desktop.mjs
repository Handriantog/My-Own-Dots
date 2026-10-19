import { packager } from '@electron/packager';
import { signDesktopApp } from './sign-desktop.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const releaseDirectory = path.resolve(
  root,
  process.env.DOTS_DESKTOP_RELEASE_DIR || 'release',
);
if (process.platform !== 'darwin')
  throw new Error('The first desktop release is macOS only.');
const electronVersion = JSON.parse(
  readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8'),
).version;
const bundles = await packager({
  dir: path.join(root, 'dist/desktop'),
  out: releaseDirectory,
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
  ignore: /^\/dev-source\.json$/,
  asar: false,
  extendInfo: {
    LSUIElement: false,
    LSMinimumSystemVersion: '14.0',
    NSHighResolutionCapable: true,
    NSHumanReadableCopyright: 'My Own Dots',
    NSMicrophoneUsageDescription:
      'Talk with your selected Dot using local speech recognition. The microphone is active only during a call you start.',
  },
});
for (const directory of bundles) {
  const app = path.join(directory, 'My Own Dots.app');
  const signing = signDesktopApp(app);
  const zip = path.join(
    releaseDirectory,
    `My-Own-Dots-macOS-${process.arch}.zip`,
  );
  const archive = spawnSync(
    'ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip],
    { stdio: 'inherit' },
  );
  if (archive.status !== 0) process.exit(archive.status ?? 1);
  writeFileSync(
    path.join(releaseDirectory, 'BUILD.txt'),
    `My Own Dots 0.1.0\nBuilt: ${new Date().toISOString()}\nArchitecture: ${process.arch}\nElectron: ${electronVersion}\nSigning: ${signing}; not notarized\nRuntime: bundled workspace and owned API backend; AI CLIs, Python integrations and Docker remain local prerequisites\nApp: ${app}\nZip: ${zip}\n`,
  );
  console.log(
    `App: ${app}\nArchive: ${zip}\n${signing}; notarization remains a release step.`,
  );
}
