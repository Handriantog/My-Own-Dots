import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { Platform } from '../src/server/platform.js';
import { DotAgent } from '../src/server/dot-agent.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type { createExecutionSession } from 'myown-llm-integrator';
type ExecutionSessionOptions = NonNullable<
  Parameters<typeof createExecutionSession>[0]
>;

const provider = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('myown-llm-integrator', async (original) => ({
  ...(await original<object>()),
  createExecutionSession: provider.create,
}));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

it.each(['text', 'voice'] as const)(
  'completes ordinary %s with the desktop browser tool enabled',
  async (channel) => {
    const root = await mkdtemp(join(tmpdir(), 'codex-desktop-tools-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const storage = await StorageClient.open({
      database: join(root, 'workspace.sqlite'),
      ownerId: randomUUID(),
      engine: 'sqlite',
    });
    cleanup.push(() => storage.close());
    const { store, workspace, voiceDelegations: jobs } = storage.repositories;
    const opened: string[] = [];
    const config: PlatformConfig = {
      conversationBackend: 'local',
      storageEngine: 'sqlite',
      llmBackend: 'subscription',
      llmProvider: 'codex',
      agentEngine: 'codex',
      baseUrl: '',
      runtimeUrl: 'http://localhost',
      voiceName: 'marin',
      slackUsers: [],
      webSearchProvider: 'disabled',
    };
    const platform = await Platform.create(store, workspace, config, {
      storage,
      openWebsite: async (url) => {
        opened.push(url);
        return { url, status: 'opened' };
      },
    });
    cleanup.push(() => platform.stop());
    await platform.start();
    const dot = (await workspace.dots())[0];
    const thread = await platform.createConversation(dot.id, 'Desktop hello');
    provider.create.mockImplementation((options: ExecutionSessionOptions) => {
      expect(
        options.tools?.find((t) => t.name === 'open_website')?.inputSchema,
      ).toMatchObject({
        properties: { urls: { type: 'array', items: { type: 'string' } } },
      });
      return {
        warm: async () => ({ version: 'fixture', nativeExecution: false }),
        run: async () => ({
          status: 'completed',
          text: 'Hello from the desktop.',
          evidence: [],
        }),
        interrupt: async () => {},
        close: async () => {},
      };
    });
    let threadId = thread.id;
    if (channel === 'text') {
      await lastValueFrom(
        platform['localRunner']!.run({
          threadId,
          agent: new DotAgent(
            store,
            workspace,
            config,
            dot.id,
            false,
            platform.setupTelemetry,
            platform.memory,
            jobs,
            platform.openWebsite,
            platform.abilities,
          ),
          input: {
            threadId,
            runId: randomUUID(),
            messages: [{ id: randomUUID(), role: 'user', content: 'Hello' }],
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          },
        }).pipe(toArray()),
      );
    } else {
      const call = await workspace.createCall(thread.id);
      await platform.nativeVoice!.turn({
        callId: call.id,
        dotId: dot.id,
        threadId,
        messageId: randomUUID(),
        audio: Buffer.alloc(4),
        understanding: { route: 'chat', text: 'Hello' },
        signal: new AbortController().signal,
        native: {
          warm: async () => {},
          close: async () => {},
          interpret: vi.fn(),
          respond: async () => {
            throw Error('Local reasoning must not run');
          },
          speak: async (text) => ({ text, pcm: Buffer.alloc(4) }),
        },
      });
      await vi.waitFor(
        async () => {
          const [job] = await jobs.list({ parentThreadId: thread.id });
          expect(job?.status).toBe('completed');
          threadId = job.workerThreadId;
        },
        { timeout: 2500 },
      );
    }
    const saved = await platform.localConversations!.getSnapshot(threadId);
    expect(saved.lastRun?.events.filter((e) => e.type === 'RUN_ERROR')).toEqual(
      [],
    );
    expect(
      saved.messages
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content),
    ).toContain('Hello from the desktop.');
    expect(opened).toEqual([]);
  },
);
