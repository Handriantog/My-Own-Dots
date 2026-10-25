import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { verificationSteps, runSteps } = await import(
  pathToFileURL(path.join(process.cwd(), 'scripts/verify-reliability.mjs')).href
);
const temporary: string[] = [];
afterEach(() => {
  for (const folder of temporary.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
const options = {
  env: { LOCAL_TEST_DATABASE_URL: 'postgresql://localhost/dots_test' },
  platform: 'darwin',
  arch: 'arm64',
};

it('blocks a core run that would silently skip database coverage', () => {
  expect(() => verificationSteps('core', { ...options, env: {} })).toThrow(
    /dedicated test database/,
  );
});

it.each([
  'postgresql://localhost/owner',
  'https://localhost/dots_test',
  'postgresql://localhost/dots_test?dbname=owner',
  'postgresql:/dots_test',
  'postgresql://localhost/dots_test/owner',
])('rejects unsafe database configuration without disclosing it', (url) => {
  expect(() =>
    verificationSteps('core', {
      ...options,
      env: { LOCAL_TEST_DATABASE_URL: url },
    }),
  ).toThrow(/dedicated test database/);
});

it('rejects the same application database despite credentials and loopback aliases', () => {
  expect(() =>
    verificationSteps('core', {
      ...options,
      env: {
        LOCAL_TEST_DATABASE_URL: 'postgresql://test:secret@localhost/dots_test',
        LOCAL_DATABASE_URL: 'postgres://owner:private@127.0.0.1:5432/dots_test',
      },
    }),
  ).toThrow(/application database/);
});

it('includes full tests and both speech protocols in core verification', () => {
  const steps = verificationSteps('core', options) as string[][];
  expect(steps).toContainEqual(['npm', 'test']);
  expect(steps).toContainEqual([
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
  ]);
  expect(steps).toContainEqual(['npm', 'run', 'build']);
});

it('includes native acceptance and packaging on the supported platform', () => {
  expect(verificationSteps('macos', options)).toEqual([
    ['npm', 'run', 'abilities:acceptance'],
    ['npm', 'run', 'desktop:package'],
    ['npm', 'run', 'abilities:package:smoke'],
  ]);
});

it('does not call an unsupported native platform a passing skip', () => {
  expect(() =>
    verificationSteps('macos', { ...options, platform: 'linux' }),
  ).toThrow(/macOS arm64/);
  expect(() => verificationSteps('typo', options)).toThrow(/profile/);
});

it('stops after a failed command instead of running later checks', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'dots-verification-'));
  temporary.push(folder);
  const marker = path.join(folder, 'should-not-exist');
  expect(() =>
    runSteps(
      [
        [process.execPath, '-e', 'process.exit(7)'],
        [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        ],
      ],
      { cwd: folder },
    ),
  ).toThrow(/7/);
  expect(existsSync(marker)).toBe(false);
});

it('rejects an unstartable command and runs valid commands', () => {
  expect(() =>
    runSteps([['/nonexistent/dots-verification-command']]),
  ).toThrow();
  expect(() =>
    runSteps([[process.execPath, '-e', 'process.exit(0)']]),
  ).not.toThrow();
});
