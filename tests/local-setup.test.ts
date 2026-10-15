import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';

it('preserves quoted existing database credentials and generates a matching connection URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dots-setup-'));
  try {
    writeFileSync(
      join(dir, '.env'),
      'LOCAL_POSTGRES_PASSWORD="test # p@ss"\nLOCAL_POSTGRES_PORT=5439\nLLM_PROVIDER=claude-code\n',
    );
    execFileSync(process.execPath, [resolve('scripts/setup-local.mjs')], {
      cwd: dir,
    });
    const first = readFileSync(join(dir, '.env'), 'utf8');
    const env = parseEnv(first);
    expect(decodeURIComponent(new URL(env.LOCAL_DATABASE_URL!).password)).toBe(
      env.LOCAL_POSTGRES_PASSWORD,
    );
    expect(new URL(env.LOCAL_DATABASE_URL!).port).toBe('5439');
    expect(env.LLM_PROVIDER).toBe('claude-code');
    execFileSync(process.execPath, [resolve('scripts/setup-local.mjs')], {
      cwd: dir,
    });
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
