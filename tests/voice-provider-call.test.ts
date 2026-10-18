import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { LocalAgentRunner } from '../src/server/local-runner.js';
import { MemoryStore } from './fixtures/memory-conversations.js';
import { LocalVoiceService } from '../src/server/local-voice/service.js';
import { LocalSpeechWorker } from '../src/server/local-voice/worker.js';
import type { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const python = resolve(
  'node_modules/myown-llm-integrator/python/.venv/bin/python',
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it.skipIf(!existsSync(python))(
  'uses the installed persistent provider in a real governed call, plays saved spans early, reuses it and reaps it',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dots-provider-call-'));
    const fixture = join(root, 'codex');
    await writeFile(
      fixture,
      (
        await readFile(resolve('tests/fixtures/voice-app-server.py'), 'utf8')
      ).replace('#!/usr/bin/env python3', `#!${python}`),
    );
    await chmod(fixture, 0o700);
    await writeFile(join(root, 'options.json'), '{}');
    vi.stubEnv('MYOWN_LLM_PYTHON', python);
    vi.stubEnv('CODEX_BIN', fixture);
    vi.stubEnv('CODEX_LOCK_PATH', join(root, 'request.lock'));
    vi.stubEnv('LOCAL_VOICE_TIMING_LOG', '1');
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const conversations = new MemoryStore();
    const runner = new LocalAgentRunner(conversations);
    const dot = workspace.dots()[0];
    const threadId = 'thread';
    workspace.bindThread(threadId, dot.id, 'Streaming fixture');
    const config = {
      conversationBackend: 'local',
      localDatabaseUrl: 'postgres://unused',
      llmBackend: 'subscription',
      llmProvider: 'codex',
      baseUrl: '',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      webSearchProvider: 'disabled',
    } as PlatformConfig;
    const platform = {
      config,
      store,
      workspace,
      setup: () => ({ missing: [] }),
      requireReady() {},
      memory: { enterForeground: async () => () => {} },
      localConversations: conversations,
      stopVoiceTurn: async () => runner.stop({ threadId }),
    } as unknown as Platform;
    const assets = ['whisper', 'kokoro', 'voices', 'vad'].map((id) => ({
      id,
      filename: id,
      installedBytes: 3,
    }));
    for (const asset of assets)
      await writeFile(join(root, asset.filename), 'abc');
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ assets }));
    vi.spyOn(LocalSpeechWorker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(LocalSpeechWorker.prototype, 'close').mockResolvedValue();
    vi.spyOn(LocalSpeechWorker.prototype, 'reset').mockResolvedValue();
    let probability = 0;
    vi.spyOn(LocalSpeechWorker.prototype, 'detect').mockImplementation(
      async () => probability,
    );
    vi.spyOn(LocalSpeechWorker.prototype, 'transcribe').mockResolvedValue({
      text: 'Hello Dot',
      language: 'en',
      segments: [],
    });
    const synthesis = vi
      .spyOn(LocalSpeechWorker.prototype, 'synthesize')
      .mockImplementation(async (text) => {
        const saved = conversations.snapshot.lastRun!;
        expect(
          saved.events.some(
            (event) =>
              event.type === 'TEXT_MESSAGE_CONTENT' &&
              typeof event.delta === 'string' &&
              event.delta.trim() === text,
          ),
        ).toBe(true);
        expect(saved.status).toBe('running');
        return Buffer.alloc(1920);
      });
    const service = new LocalVoiceService(platform, {
      enabled: true,
      providerSession: true,
      python: '/usr/bin/true',
      assets: root,
      worker: join(root, 'manifest.json'),
      manifest: join(root, 'manifest.json'),
    });
    try {
      expect((await service.status()).inferenceRuntime).toBe(
        'persistent-provider',
      );
      const handle = await service.start(
        threadId,
        dot.id,
        new AbortController().signal,
      );
      const call = service.require(handle.id, handle.token);
      let completed = 0;
      let failure: unknown;
      call.listen(async (event) => {
        if (event.type === 'audio')
          call.played(
            event.generation,
            event.sequence,
            Buffer.from(event.pcm, 'base64').length / 2,
          );
        if (event.type === 'transcript') {
          try {
            expect(event).not.toHaveProperty('timing');
            expect(event.generation).toEqual(expect.any(Number));
            const input = {
              threadId,
              runId: event.messageId,
              messages: [
                {
                  id: event.messageId,
                  role: 'user' as const,
                  content: event.text,
                },
              ],
              state: {},
              context: [],
              tools: [],
              forwardedProps: {},
            };
            const events = await lastValueFrom(
              runner
                .run({
                  threadId,
                  agent: new DotAgent(store, workspace, config, dot.id),
                  input,
                })
                .pipe(toArray()),
            );
            expect(events.filter((e) => e.type === 'RUN_ERROR')).toEqual([]);
            await call.answer(event.messageId);
            completed++;
          } catch (error) {
            failure = error;
          }
        }
      });
      let sequence = 0;
      for (let turn = 1; turn <= 2; turn++) {
        for (let n = 0; n < 32; n++) {
          probability = n < 10 ? 1 : 0;
          await call.frame(sequence++, Buffer.alloc(1024));
        }
        await vi.waitFor(
          () => {
            if (failure) throw failure;
            expect(completed).toBe(turn);
          },
          { timeout: 7000 },
        );
        expect(synthesis).toHaveBeenCalledTimes(turn * 2);
      }
      const rows = (await readFile(join(root, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const starts = rows.filter((row) => row.method === 'thread/start');
      expect(starts).toHaveLength(2);
      expect(new Set(starts.map((row) => row.pid)).size).toBe(1);
      expect(
        rows.filter((row) => row.method === 'thread/unsubscribe'),
      ).toHaveLength(2);
      expect(rows.filter((row) => row.method === 'turn/start')).toHaveLength(2);
      const timings = logs.mock.calls
        .filter(([name]) => name === '[voice-inference]')
        .map(([, timing]) => timing);
      expect(timings).toHaveLength(2);
      expect(
        timings.every(
          (timing) =>
            timing.reusedProvider &&
            timing.delivery === 'incremental' &&
            timing.firstTextMs < timing.totalMs,
        ),
      ).toBe(true);
      const traces = logs.mock.calls
        .filter(([name]) => name === '[voice-timing]')
        .map(([, row]) => JSON.parse(row));
      const summaries = traces.filter((row) => row.event === 'first_playback');
      expect(summaries).toHaveLength(2);
      expect(new Set(summaries.map((row) => row.messageId)).size).toBe(2);
      for (const summary of summaries) {
        expect(summary.callId).toBe(handle.id);
        expect(summary.durations.recognitionMs).toBeGreaterThanOrEqual(0);
        expect(summary.durations.firstSynthesisMs).toBeGreaterThanOrEqual(0);
        expect(summary.durations.providerToFirstTextMs).toBeGreaterThan(0);
        const stages = traces.filter(
          (row) => row.messageId === summary.messageId,
        );
        const phases = stages.find((row) => row.event === 'provider_result')
          .timings.phases;
        expect(phases.firstDeltaMs).toBeGreaterThanOrEqual(0);
        expect(phases.firstValidatedTextMs).toBeGreaterThanOrEqual(
          phases.firstDeltaMs,
        );
        expect(phases.turnCompletedMs).toBeGreaterThan(
          phases.firstValidatedTextMs,
        );
        expect(stages.some((row) => row.stage === 'playback_finished')).toBe(
          true,
        );
        expect(stages.some((row) => row.stage === 'interrupted')).toBe(false);
        expect(
          stages.find((row) => row.stage === 'provider_finished').elapsedMs,
        ).toBeGreaterThan(summary.elapsedMs);
        expect(
          stages.find((row) => row.event === 'provider_result').timings
            .reusedProvider,
        ).toBe(true);
      }
      expect(JSON.stringify(traces)).not.toContain('Hello Dot');
      await call.end();
      expect(() => process.kill(starts[0].pid, 0)).toThrow();
    } finally {
      await service.close();
      await runner.stop({ threadId });
      workspace.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
