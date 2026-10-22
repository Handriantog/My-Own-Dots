import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error(
    'Ability acceptance requires macOS arm64; unsupported is not a passing skip.',
  );
const root = fileURLToPath(new URL('../..', import.meta.url));
const python = process.env.DOTS_ABILITY_TEST_PYTHON || 'python3';
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const profile of ['0', '1'])
  run(python, ['-I', '-S', '-B', 'scripts/abilities/test_sandbox.py'], {
    ...process.env,
    DOTS_ABILITY_APPLICATION_PROFILE: profile,
  });
const desktop = readdirSync(new URL('../../tests/desktop/', import.meta.url))
  .filter((name) => name.startsWith('abilities-') && name.endsWith('.test.ts'))
  .map((name) => 'tests/desktop/' + name);
run(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', 'tests/abilities', ...desktop],
  { ...process.env, DO_NOT_TRACK: '1' },
);
