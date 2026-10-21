import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('validates native setup paths, hashes, offline policy and reuse using only local fixtures', () => {
  const result = spawnSync(
    'python3',
    ['-I', '-S', '-B', resolve('scripts/local-voice/test_setup_native.py')],
    { encoding: 'utf8', timeout: 30_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
