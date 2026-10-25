import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DailyErrorLog } from '../src/shared/error-log.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'dots-errors-'));
  roots.push(root);
  return root;
}

it('appends across restarts and selects a new file at local midnight', async () => {
  const root = await directory();
  let now = new Date(2026, 9, 25, 23, 59, 59);
  const first = new DailyErrorLog(root, 'desktop', () => now);
  first.record('folder_failed', new Error('First'), { requestId: 'request-1' });
  new DailyErrorLog(root, 'backend', () => now).record(
    'backend_failed',
    new Error('Second'),
  );
  now = new Date(2026, 9, 26, 0, 0, 0);
  first.record('voice_failed', new Error('Third'), { callId: 'call-1' });
  expect((await readdir(root)).sort()).toEqual([
    'errors-2026-10-25.jsonl',
    'errors-2026-10-26.jsonl',
  ]);
  const rows = (await readFile(join(root, 'errors-2026-10-25.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
  expect(rows.map((row) => row.error.message)).toEqual(['First', 'Second']);
  expect(rows[0]).toMatchObject({
    source: 'desktop',
    event: 'folder_failed',
    context: { requestId: 'request-1' },
    pid: process.pid,
  });
  expect((await stat(join(root, 'errors-2026-10-25.jsonl'))).mode & 0o777).toBe(
    0o600,
  );
});

it('redacts secrets and rejects arbitrary payload fields while bounding individual records', async () => {
  const root = await directory();
  vi.stubEnv('OWNER_TOKEN', 'private-owner-secret');
  const log = new DailyErrorLog(root, 'backend');
  log.record(
    'failed',
    new Error(
      'Authorization: Bearer bearer-secret OWNER_TOKEN="private-owner-secret" https://user:pass@example.com/a?key=url-secret ' +
        'x'.repeat(15000),
    ),
    {
      requestId: 'safe-id',
      body: 'private conversation',
      headers: { authorization: 'private-header' },
    } as never,
  );
  const raw = await readFile(join(root, (await readdir(root))[0]), 'utf8');
  expect(Buffer.byteLength(raw)).toBeLessThan(8192);
  for (const secret of [
    'bearer-secret',
    'private-owner-secret',
    'user:pass',
    'url-secret',
    'private conversation',
    'private-header',
  ])
    expect(raw).not.toContain(secret);
  expect(JSON.parse(raw).context.requestId).toBe('safe-id');
});

it('does not throw when the log destination is unwritable or is a file', async () => {
  const root = await directory();
  const file = join(root, 'file');
  await writeFile(file, 'unchanged');
  expect(() =>
    new DailyErrorLog(file, 'backend').record('failed', new Error('original')),
  ).not.toThrow();
  expect(await readFile(file, 'utf8')).toBe('unchanged');
});

it('persists a fatal subprocess exception before exit without swallowing the crash', async () => {
  const root = await directory();
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { installErrorLogging } from ${JSON.stringify(resolve('src/shared/error-log.ts'))}; installErrorLogging(${JSON.stringify(root)},'backend'); setImmediate(()=>{throw new TypeError('fatal fixture');});`,
    ],
    { encoding: 'utf8' },
  );
  expect(child.status).toBe(1);
  const row = JSON.parse(
    (await readFile(join(root, (await readdir(root))[0]), 'utf8')).trim(),
  );
  expect(row).toMatchObject({
    event: 'uncaught_exception',
    source: 'backend',
    error: { name: 'TypeError', message: 'fatal fixture' },
  });
  expect(row.error.stack).toContain('TypeError: fatal fixture');
});

it('bounds a daily error storm and resumes the next day', async () => {
  const root = await directory();
  let now = new Date(2026, 9, 25);
  const logger = new DailyErrorLog(root, 'backend', () => now, 1200);
  for (let i = 0; i < 100; i++) logger.record('failed', new Error('repeated'));
  const file = join(root, 'errors-2026-10-25.jsonl');
  const raw = await readFile(file, 'utf8');
  const rows = raw
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
  expect(
    rows.filter((row) => row.event === 'daily_log_limit_reached'),
  ).toHaveLength(1);
  expect(Buffer.byteLength(raw)).toBeLessThan(3248);
  now = new Date(2026, 9, 26);
  expect(logger.record('failed', new Error('new day'))).toBe(true);
});

it('redacts quoted JSON credential keys and Basic authorization without relying on environment values', async () => {
  const root = await directory();
  const logger = new DailyErrorLog(root, 'backend');
  logger.record(
    'failed',
    new Error(
      JSON.stringify({
        api_key: 'fixture-json-secret',
        access_token: 'fixture-token-secret',
        password: 'escaped"password-secret',
      }) + ' Authorization: Basic Zml4dHVyZTpwYXNzd29yZA==',
    ),
  );
  const raw = await readFile(join(root, (await readdir(root))[0]), 'utf8');
  for (const secret of [
    'fixture-json-secret',
    'fixture-token-secret',
    'password-secret',
    'Zml4dHVyZTpwYXNzd29yZA==',
  ])
    expect(raw).not.toContain(secret);
});

it('records content-free delivery diagnostics without inventing an error', async () => {
  const root = await directory();
  const log = new DailyErrorLog(root, 'backend');
  log.record('voice_task_speech', undefined, {
    callId: 'call',
    requestId: 'work',
    status: 'deferred',
    transcript: 'PRIVATE',
  });
  const raw = await readFile(join(root, (await readdir(root))[0]), 'utf8');
  expect(JSON.parse(raw)).toMatchObject({
    event: 'voice_task_speech',
    context: { callId: 'call', requestId: 'work', status: 'deferred' },
  });
  expect(JSON.parse(raw)).not.toHaveProperty('error');
  expect(raw).not.toContain('PRIVATE');
});
