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
import { VoiceTurnTiming } from '../src/server/local-voice/timing.js';
import { logDiagnostic } from '../src/shared/error-log.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'dots-voice-diagnostics-'));
  roots.push(root);
  vi.stubEnv('DOTS_ERROR_LOG_DIR', root);
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', undefined);
  return root;
}
async function readRows(root: string) {
  const files = await readdir(root);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^errors-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const path = join(root, files[0]);
  const raw = await readFile(path, 'utf8');
  return {
    path,
    raw,
    rows: raw
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row)),
  };
}

it('persists voice phases by default when a packaged-style child ignores stdout', async () => {
  const root = await directory();
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { VoiceTurnTiming } from ${JSON.stringify(resolve('src/server/local-voice/timing.ts'))}; const trace = new VoiceTurnTiming('call','message',100,{now:()=>125,quality:'high'}); trace.mark('recognition_started');`,
    ],
    { env: process.env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 },
  );
  expect(child.status, child.stderr?.toString()).toBe(0);
  const { path, rows } = await readRows(root);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    source: 'backend',
    event: 'voice_timing',
    context: {
      callId: 'call',
      messageId: 'message',
      quality: 'high',
      operation: 'stage',
      stage: 'recognition_started',
      step: 0,
      elapsedMs: 25,
    },
  });
  expect(rows[0]).not.toHaveProperty('error');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('honors explicit disable and leaves unconfigured source runs quiet', async () => {
  const root = await directory();
  const consoleOutput = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '0');
  new VoiceTurnTiming('call', 'message').mark('speech_end_detected');
  expect(await readdir(root)).toEqual([]);
  vi.stubEnv('DOTS_ERROR_LOG_DIR', undefined);
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', undefined);
  new VoiceTurnTiming('call', 'message').mark('speech_end_detected');
  expect(consoleOutput).not.toHaveBeenCalled();
});

it('retains explicitly requested console traces alongside daily diagnostics', async () => {
  const root = await directory();
  vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
  const consoleOutput = vi.spyOn(console, 'info').mockImplementation(() => {});
  new VoiceTurnTiming('call', 'message', 0, { now: () => 42 }).mark(
    'first_audio_queued',
  );
  expect(consoleOutput).toHaveBeenCalledWith(
    '[voice-timing]',
    expect.any(String),
  );
  const { rows } = await readRows(root);
  expect(rows[0].context).toMatchObject({
    stage: 'first_audio_queued',
    elapsedMs: 42,
  });
});

it('persists bounded phases and fixed outcomes without provider payloads, token counts or secrets', async () => {
  const root = await directory();
  vi.stubEnv('FIXTURE_API_TOKEN', 'owner-secret-fixture');
  const consoleOutput = vi.spyOn(console, 'info').mockImplementation(() => {});
  const trace = new VoiceTurnTiming(
    'call-owner-secret-fixture',
    'Bearer header-secret',
    0,
    { now: () => 100 },
  );
  trace.recognitionResult('rejected', {
    audioMs: 500,
    contextChars: 42,
    reason: 'invalid_timestamp',
    fallbackReason: 'invalid_timestamp',
    text: 'PRIVATE',
    pcm: 'PRIVATE',
  });
  trace.providerResult(
    {
      timings: {
        startupMs: 10,
        prompt: 'PRIVATE',
        phases: { private: 'PRIVATE' },
      },
      usage: { inputTokens: 42, token: 'PRIVATE' },
      result: { text: 'PRIVATE' },
      toolArgs: 'PRIVATE',
    },
    1,
  );
  trace.mark('PRIVATE' as never);
  for (let step = 0; step < 300; step++) trace.mark('provider_started', step);
  const { raw, rows } = await readRows(root);
  expect(rows).toHaveLength(256);
  expect(rows[0].context).toMatchObject({
    operation: 'recognition_result',
    status: 'rejected',
    code: 'invalid_timestamp',
    elapsedMs: 100,
  });
  expect(rows[1].context).toMatchObject({
    operation: 'provider_result',
    step: 1,
  });
  for (const secret of [
    'PRIVATE',
    'owner-secret-fixture',
    'header-secret',
    'inputTokens',
    'toolArgs',
  ])
    expect(raw).not.toContain(secret);
  expect(consoleOutput).not.toHaveBeenCalled();
});

it('restricts diagnostic timing values to finite nonnegative numbers', async () => {
  const root = await directory();
  logDiagnostic('voice_timing', {
    elapsedMs: 'PRIVATE',
    step: Infinity,
    transcript: 'PRIVATE',
  });
  logDiagnostic('voice_timing', { elapsedMs: -1, step: -1 });
  logDiagnostic('voice_timing', { elapsedMs: 12.5, step: 1 });
  const { raw, rows } = await readRows(root);
  expect(rows.map((row) => row.context)).toEqual([
    {},
    {},
    { elapsedMs: 12.5, step: 1 },
  ]);
  expect(raw).not.toContain('PRIVATE');
});

it('preserves governed execution identifiers with shared secret redaction', async () => {
  const root = await directory();
  vi.stubEnv('FIXTURE_API_TOKEN', 'private-execution-secret');
  logDiagnostic('execution_timing', {
    runId: 'run-1',
    dotId: 'dot-private-execution-secret',
    stage: 'provider_start',
    elapsedMs: 123,
    prompt: 'PRIVATE',
    toolParams: 'PRIVATE',
  });
  const { raw, rows } = await readRows(root);
  expect(rows[0].context).toEqual({
    runId: 'run-1',
    dotId: 'dot-[redacted]',
    stage: 'provider_start',
    elapsedMs: 123,
  });
  expect(raw).not.toContain('PRIVATE');
  expect(raw).not.toContain('private-execution-secret');
});

it('does not disrupt a call when the configured diagnostic destination is a file', async () => {
  const root = await directory();
  const path = join(root, 'blocked');
  await writeFile(path, 'unchanged');
  vi.stubEnv('DOTS_ERROR_LOG_DIR', path);
  expect(() =>
    new VoiceTurnTiming('call', 'message').mark('speech_end_detected'),
  ).not.toThrow();
  expect(await readFile(path, 'utf8')).toBe('unchanged');
});
