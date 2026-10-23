import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function codesign(arguments_, target, operation) {
  const result = spawnSync('codesign', [...arguments_, target], {
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(
      `Desktop signing failed: ${operation} (${path.basename(target)}).`,
    );
  return `${result.stdout}\n${result.stderr}`;
}
function isMachO(file) {
  const descriptor = openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(4);
    if (readSync(descriptor, bytes, 0, 4, 0) !== 4) return false;
    return [
      'feedface',
      'feedfacf',
      'cefaedfe',
      'cffaedfe',
      'cafebabe',
      'bebafeca',
      'cafebabf',
      'bfbafeca',
    ].includes(bytes.toString('hex'));
  } finally {
    closeSync(descriptor);
  }
}
function nestedCode(directory) {
  const components = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    // Framework aliases must retain their symlink structure, not be signed twice.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      components.push(...nestedCode(file));
      if (/\.(app|framework|xpc|appex)$/.test(entry.name))
        components.push(file);
    } else if (entry.isFile() && isMachO(file)) components.push(file);
  }
  return components;
}
export function signDesktopApp(
  app,
  configuredIdentity = process.env.DOTS_CODESIGN_IDENTITY,
) {
  if (process.platform !== 'darwin')
    throw new Error('Desktop signing requires macOS.');
  const identity = configuredIdentity?.trim() || '-';
  const observer = path.join(
    app,
    'Contents/Resources/app/native/desktop-observer',
  );
  if (
    !app.endsWith('.app') ||
    !existsSync(path.join(app, 'Contents/Info.plist')) ||
    !existsSync(observer) ||
    !existsSync(
      path.join(app, 'Contents/Resources/app/native/ability-launcher'),
    )
  )
    throw new Error(
      'Desktop signing failed: expected the assembled app, observer and Ability launcher.',
    );
  const components = [...nestedCode(app), app];
  // Sign inside out, including the observer under Resources (which codesign's
  // automatic nested-code discovery does not treat as a conventional helper).
  for (const component of components)
    codesign(
      ['--force', '--sign', identity, '--timestamp=none'],
      component,
      'could not sign component',
    );
  for (const component of components) {
    codesign(
      ['--verify', '--strict'],
      component,
      'component verification failed',
    );
    if (identity !== '-') {
      const signature = codesign(
        ['--display', '-r-'],
        component,
        'could not inspect identity',
      );
      const requirement = signature.match(/^designated => (.+)$/m)?.[1];
      if (
        !requirement ||
        /\bcdhash\b/.test(requirement) ||
        !/\b(anchor|certificate)\b/.test(requirement)
      )
        throw new Error(
          'Desktop signing failed: certificate signing must produce a stable designated requirement.',
        );
    }
  }
  codesign(
    ['--verify', '--deep', '--strict'],
    app,
    'bundle verification failed',
  );
  return identity === '-'
    ? 'local ad-hoc; permission may need renewal after rebuilds'
    : 'certificate; stable code identity';
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      `Desktop signing: ${signDesktopApp(path.resolve(process.argv[2] || ''))}; not notarized.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
