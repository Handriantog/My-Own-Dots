import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lastValueFrom, toArray } from 'rxjs';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { DotAgent } from '../src/server/dot-agent.js';
import type { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type { ConversationSnapshot } from '../src/server/local-conversations.js';
import { LocalVoiceService } from '../src/server/local-voice/service.js';
import { LocalSpeechWorker } from '../src/server/local-voice/worker.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const python = resolve(
  'node_modules/myown-llm-integrator/python/.venv/bin/python',
);

it.skipIf(!existsSync(python))(
  'reuses the installed Integrator in governed voice turns, preserves tools and typed chat, and reaps it at call end',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dots-voice-session-'));
    const observations = join(root, 'provider-runs.jsonl');
    const provider = join(root, 'provider.mjs');
    await writeFile(
      provider,
      `
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
// The provider's immediate parent is a fresh cancellation supervisor. Its
// parent is the Integrator runtime whose reuse is under test.
const runtime = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(process.ppid)], {encoding: 'utf8'}).trim());
appendFileSync(${JSON.stringify(observations)}, JSON.stringify({runtime}) + '\\n');
await import(${JSON.stringify(new URL('./fixtures/subscription-provider.mjs', import.meta.url).href)});
`,
    );
    vi.stubEnv('MYOWN_LLM_PYTHON', python);
    vi.stubEnv(
      'AGENT_COMMAND_JSON',
      JSON.stringify([process.execPath, provider]),
    );
    vi.stubEnv('AGENT_LOCK_PATH', join(root, 'request.lock'));
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const dot = workspace.dots()[0];
    const threadId = '11111111-1111-4111-8111-111111111111';
    workspace.bindThread(threadId, dot.id, 'Session fixture');
    const config: PlatformConfig = {
      conversationBackend: 'local',
      localDatabaseUrl: 'postgres://unused',
      llmBackend: 'subscription',
      llmProvider: 'pi',
      baseUrl: '',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      webSearchProvider: 'disabled',
    };
    let snapshot: ConversationSnapshot = { messages: [], state: {} };
    const platform = {
      config,
      store,
      workspace,
      setup: () => ({ missing: [] }),
      requireReady() {},
      memory: { enterForeground: async () => () => {} },
      localConversations: { getSnapshot: async () => snapshot },
      stopVoiceTurn: async () => {},
    } as unknown as Platform;
    const assets = ['whisper', 'kokoro', 'voices', 'vad'].map((id) => ({
      id,
      filename: id,
      installedBytes: 3,
    }));
    await Promise.all(
      assets.map((asset) => writeFile(join(root, asset.filename), 'abc')),
    );
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ assets }));
    vi.spyOn(LocalSpeechWorker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(LocalSpeechWorker.prototype, 'close').mockResolvedValue();
    vi.spyOn(LocalSpeechWorker.prototype, 'reset').mockResolvedValue();
    let probability = 0;
    vi.spyOn(LocalSpeechWorker.prototype, 'detect').mockImplementation(
      async () => probability,
    );
    let spoken = 'save-fixture';
    vi.spyOn(LocalSpeechWorker.prototype, 'transcribe').mockImplementation(
      async () => ({ text: spoken, language: 'en', segments: [] }),
    );
    const synthesis = vi
      .spyOn(LocalSpeechWorker.prototype, 'synthesize')
      .mockResolvedValue(Buffer.alloc(1920));
    const service = new LocalVoiceService(platform, {
      enabled: true,
      inferenceSession: true,
      python: '/usr/bin/true',
      assets: root,
      worker: join(root, 'manifest.json'),
      manifest: join(root, 'manifest.json'),
    });
    const run = async (messageId: string, text: string) => {
      const user = { id: messageId, role: 'user' as const, content: text };
      const input = {
        threadId,
        runId: messageId,
        messages: [user],
        context: [],
        state: {},
        tools: [],
        forwardedProps: {},
      };
      const events = await lastValueFrom(
        new DotAgent(store, workspace, config, dot.id)
          .run(input)
          .pipe(toArray()),
      );
      expect(events.filter((event) => event.type === 'RUN_ERROR')).toEqual([]);
      const content = events
        .filter(
          (event) =>
            event.type === 'TEXT_MESSAGE_CONTENT' ||
            event.type === 'TEXT_MESSAGE_CHUNK',
        )
        .map((event) => event.delta)
        .join('');
      expect(content, JSON.stringify(events)).not.toBe('');
      snapshot = {
        messages: [
          user,
          { id: `answer-${messageId}`, role: 'assistant', content },
        ],
        state: {},
        lastRun: { runId: messageId, status: 'finished', input, events },
      };
      return content;
    };
    try {
      const handle = await service.start(
        threadId,
        dot.id,
        new AbortController().signal,
      );
      const call = await service.require(handle.id, handle.token);
      const completed: string[] = [];
      let failure: unknown;
      call.listen(async (event) => {
        if (event.type === 'transcript') {
          try {
            completed.push(await run(event.messageId, event.text));
            await call.answer(event.messageId);
          } catch (error) {
            failure = error;
          }
        }
        if (event.type === 'audio')
          await call.played(
            event.generation,
            event.sequence,
            Buffer.from(event.pcm, 'base64').length / 2,
          );
      });
      let sequence = 0;
      for (let turn = 1; turn <= 2; turn++) {
        spoken = turn === 1 ? 'save-fixture' : 'Hello again';
        for (let n = 0; n < 32; n++) {
          probability = n < 10 ? 1 : 0;
          await call.frame(sequence++, Buffer.alloc(1024));
        }
        await vi.waitFor(
          () => {
            if (failure) throw failure;
            expect(completed).toHaveLength(turn);
            expect(synthesis.mock.calls.length).toBeGreaterThanOrEqual(turn);
          },
          { timeout: 5000 },
        );
      }
      expect(
        workspace.pages
          .list(dot.spaceId)
          .some((page) => page.title === 'Offline fixture note'),
      ).toBe(true);
      const rows = (await readFile(observations, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(rows.length).toBeGreaterThanOrEqual(3); // Tool decision, result, second turn.
      expect(new Set(rows.map((row) => row.runtime)).size).toBe(1);
      const runtime = rows[0].runtime;
      const timings = logs.mock.calls
        .filter(([name]) => name === '[voice-inference]')
        .map(([, value]) => value);
      expect(timings.length).toBe(rows.length);
      expect(
        timings.every(
          (timing) => timing.reusedRuntime && timing.startupMs === 0,
        ),
      ).toBe(true);
      expect(JSON.stringify(timings)).not.toContain('save-fixture');
      // Typed chat during a call must not borrow its session or voice context.
      expect(await run('typed-message', 'Typed fixture')).toContain(
        'Offline provider completed',
      );
      const allRows = (await readFile(observations, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(allRows.at(-1).runtime).not.toBe(runtime);
      await call.end();
      expect(() => process.kill(runtime, 0)).toThrow();
    } finally {
      await service.close();
      workspace.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
