import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

it('reports bounded recent turns, including interrupted turns, without mixing provider steps or printing content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voice-report-'));
  try {
    const file = join(root, 'log');
    const row = (messageId: string, data: object) =>
      '[voice-timing] ' +
      JSON.stringify({
        version: 1,
        at: '2026-10-18T12:00:00Z',
        callId: 'call',
        messageId,
        ...data,
      });
    await writeFile(
      file,
      [
        'unrelated private log line',
        row('old', {
          event: 'stage',
          stage: 'speech_end_detected',
          step: 0,
          elapsedMs: 700,
        }),
        row('played', {
          event: 'stage',
          stage: 'speech_end_detected',
          step: 0,
          elapsedMs: 700,
        }),
        row('played', {
          event: 'stage',
          stage: 'first_playback_ack',
          step: 0,
          elapsedMs: 6200,
        }),
        row('played', {
          event: 'first_playback',
          elapsedMs: 6200,
          durations: { recognitionMs: 300, providerToFirstTextMs: 5000 },
        }),
        row('interrupted', {
          event: 'stage',
          stage: 'speech_end_detected',
          step: 0,
          elapsedMs: 700,
        }),
        row('interrupted', {
          event: 'stage',
          stage: 'interrupted',
          step: 0,
          elapsedMs: 1500,
        }),
        row('interrupted', {
          event: 'recognition_result',
          outcome: 'rejected',
          audioMs: 896,
          reason: 'invalid_timestamp',
          fallbackReason: 'invalid_timestamp',
          text: 'PRIVATE',
        }),
        row('played', {
          event: 'provider_result',
          step: 2,
          elapsedMs: 7000,
          timings: {
            totalMs: 5500,
            startupMs: 20,
            firstTextMs: 5000,
            reusedProvider: false,
            delivery: 'incremental',
            phases: {
              lockWaitMs: 200,
              preparationMs: 300,
              accountReadMs: 100,
              threadCreateMs: 150,
              turnStartAckMs: 10,
              firstDeltaMs: 4000,
              firstValidatedTextMs: 4500,
              turnCompletedMs: 4900,
              textCallbackMs: 30,
              cleanupMs: 100,
              totalMs: 5500,
              secret: 'PRIVATE',
            },
          },
          prompt: 'PRIVATE',
        }),
        '[voice-timing] {unfinished',
        row('old', {
          event: 'stage',
          stage: 'provider_cancelled',
          step: 1,
          elapsedMs: 12000,
        }),
      ].join('\n'),
    );
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/voice-timings.mjs'), '--file', file, '--last', '2'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Recognition: rejected');
    expect(result.stdout).toContain('invalid_timestamp');
    expect(result.stdout).toContain('audio=0.896 s');
    expect(result.stdout).toContain('retry after invalid_timestamp');
    expect(result.stdout).toContain('played');
    expect(result.stdout).toContain('6.200 s');
    expect(result.stdout).toContain('Provider to first validated text');
    expect(result.stdout).toContain('5.000 s');
    expect(result.stdout).toContain('step 2');
    expect(result.stdout).toContain('reused=false');
    expect(result.stdout).toContain('Internal lock wait: 0.200 s');
    expect(result.stdout).toContain(
      'Account check (within preparation): 0.100 s',
    );
    expect(result.stdout).toContain(
      'Thread creation (within preparation): 0.150 s',
    );
    expect(result.stdout).toContain('Raw delta to validated text: 0.500 s');
    expect(result.stdout).toContain('interrupted');
    expect(result.stdout).toContain('No playback acknowledgement');
    expect(result.stdout).not.toContain('old');
    expect(result.stdout).not.toContain('PRIVATE');
    expect(result.stdout).not.toContain('unrelated private');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
