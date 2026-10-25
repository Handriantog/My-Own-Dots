import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function databaseIdentity(value) {
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    url.search ||
    url.hash
  )
    throw Error('Invalid database URL.');
  const host = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ? 'loopback'
    : url.hostname;
  return {
    key: `${host}:${url.port || '5432'}${decodeURIComponent(url.pathname)}`,
    name: decodeURIComponent(url.pathname.slice(1)),
  };
}

function requireTestDatabase(env) {
  let test;
  try {
    test = databaseIdentity(env.LOCAL_TEST_DATABASE_URL);
    if (!/(^|[_-])tests?([_-]|$)/i.test(test.name)) throw Error();
  } catch {
    throw Error(
      'Set LOCAL_TEST_DATABASE_URL to a dedicated test database with a test or tests name segment and no URL query overrides. Never use owner data.',
    );
  }
  if (env.LOCAL_DATABASE_URL) {
    let application;
    try {
      application = databaseIdentity(env.LOCAL_DATABASE_URL);
    } catch {
      throw Error(
        'Cannot validate the configured application database identity.',
      );
    }
    if (test.key === application.key)
      throw Error(
        'The test database must differ from the application database.',
      );
  }
}

export function verificationSteps(
  profile,
  { env = process.env, platform = process.platform, arch = process.arch } = {},
) {
  if (profile === 'core') {
    requireTestDatabase(env);
    return [
      ['npm', 'run', 'check-format'],
      ['npm', 'run', 'lint'],
      ['npm', 'run', 'typecheck'],
      ['npm', 'test'],
      [
        'python3',
        '-I',
        '-S',
        '-B',
        '-m',
        'unittest',
        'discover',
        '-s',
        'scripts/local-voice',
        '-p',
        'test_*.py',
      ],
      ['npm', 'run', 'build'],
    ];
  }
  if (profile === 'macos') {
    if (platform !== 'darwin' || arch !== 'arm64')
      throw Error(
        'Native verification requires macOS arm64; unsupported is not a passing skip.',
      );
    return [
      ['npm', 'run', 'abilities:acceptance'],
      ['npm', 'run', 'desktop:package'],
      ['npm', 'run', 'abilities:package:smoke'],
    ];
  }
  throw Error('Choose a verification profile: core or macos.');
}

export function runSteps(steps, { cwd = root, env = process.env } = {}) {
  for (const [command, ...args] of steps) {
    const result = spawnSync(command, args, {
      cwd,
      env: { ...env, DO_NOT_TRACK: '1' },
      stdio: 'inherit',
      shell: false,
    });
    if (result.error || result.status !== 0)
      throw Error(
        `Verification stopped: ${command} (exit ${result.status ?? result.signal ?? 'unavailable'}). Later checks did not run.`,
      );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3)
      throw Error('Usage: node scripts/verify-reliability.mjs core|macos');
    const profile = process.argv[2];
    runSteps(verificationSteps(profile));
    console.log(
      `${profile} automated checks passed. Live model, OS permissions and user-journey acceptance remain separate.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
