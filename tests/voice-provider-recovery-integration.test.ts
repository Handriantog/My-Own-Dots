import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VoiceProviderSession } from '../src/server/local-voice/inference.js';

const python = resolve(
  'node_modules/myown-llm-integrator/python/.venv/bin/python',
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it.skipIf(!existsSync(python))(
  'prewarms the installed provider after a blocked callback is cancelled, without generating another answer',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'voice-recovery-installed-'));
    const fixture = join(root, 'codex');
    await writeFile(
      fixture,
      (await readFile('tests/fixtures/voice-app-server.py', 'utf8')).replace(
        '#!/usr/bin/env python3',
        `#!${python}`,
      ),
    );
    await chmod(fixture, 0o700);
    await writeFile(join(root, 'options.json'), '{}');
    vi.stubEnv('MYOWN_LLM_PYTHON', python);
    vi.stubEnv('CODEX_BIN', fixture);
    vi.stubEnv('CODEX_LOCK_PATH', join(root, 'lock'));
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const session = new VoiceProviderSession('fixture-call');
    const requests = async () =>
      (await readFile(join(root, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    try {
      await session.warm(new AbortController().signal);
      const controller = new AbortController();
      let entered!: () => void;
      const callback = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const pending = session.runDecision({
        prompt: 'hello',
        toolNames: [],
        signal: controller.signal,
        onText: () => {
          entered();
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      });
      await callback;
      controller.abort();
      await expect(pending).rejects.toThrow(/cancel/);
      await vi.waitFor(
        () =>
          expect(
            logs.mock.calls.some(
              ([name, value]) =>
                name === '[voice-inference-recovery]' &&
                value.outcome === 'ready',
            ),
          ).toBe(true),
        { timeout: 5000 },
      );
      expect(
        (await requests()).filter((row) => row.method === 'turn/start'),
      ).toHaveLength(1);
      release(); // A late old callback must not acknowledge the replacement's text.
      const next = await session.runDecision({
        prompt: 'next',
        toolNames: [],
        signal: new AbortController().signal,
      });
      expect(next.timings.reusedProvider).toBe(true);
      expect(next.timings.startupMs).toBe(0);
      expect(next.timings.phases.threadCreateMs).toBeGreaterThanOrEqual(0);
      expect(next.result.text).toBe('First sentence. Second sentence.');
      const turns = (await requests()).filter(
        (row) => row.method === 'turn/start',
      );
      expect(turns).toHaveLength(2);
      expect(turns[1].pid).not.toBe(turns[0].pid);
      await session.close();
      for (const row of (await requests()).filter((row) => row.spawn))
        expect(() => process.kill(row.spawn, 0)).toThrow();
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
