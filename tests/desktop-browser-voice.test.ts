import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Platform } from '../src/server/platform.js';
import { StorageClient } from '../src/server/storage/storage-client.js';
import type { NativeVoiceSession } from '../src/server/local-voice/native-contract.js';
const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

it('opens a reference from High voice conversation context and saves the browser result in its task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dots-voice-browser-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const storage = await StorageClient.open({
    database: join(root, 'workspace.sqlite'),
    ownerId: randomUUID(),
    engine: 'sqlite',
  });
  cleanup.push(() => storage.close());
  const { store, workspace, voiceDelegations: jobs } = storage.repositories;
  const opened: string[] = [];
  const platform = await Platform.create(
    store,
    workspace,
    {
      conversationBackend: 'local',
      llmBackend: 'subscription',
      llmProvider: 'codex',
      baseUrl: '',
      runtimeUrl: 'http://localhost/api/copilotkit',
      voiceName: 'marin',
      slackUsers: [],
      webSearchProvider: 'disabled',
    },
    {
      storage,
      openWebsite: async (url) => {
        opened.push(url);
        return { url, status: 'opened' };
      },
    },
  );
  cleanup.push(() => platform.stop());
  await platform.start();
  const dot = (await workspace.dots())[0];
  const thread = await platform.createConversation(dot.id, 'Voice references');
  const call = await workspace.createCall(thread.id);
  const native: NativeVoiceSession = {
    warm: async () => {},
    close: async () => {},
    interpret: vi.fn(),
    respond: async () => ({
      text: 'The reference is [the guide](https://example.com/guide).',
      pcm: Buffer.alloc(4),
    }),
    speak: async (text) => ({ text, pcm: Buffer.alloc(4) }),
  };
  const turn = {
    callId: call.id,
    dotId: dot.id,
    threadId: thread.id,
    messageId: randomUUID(),
    audio: Buffer.alloc(4),
    native,
    signal: new AbortController().signal,
  };
  await platform.nativeVoice!.turn({
    ...turn,
    understanding: { route: 'chat', text: 'What is the source?' },
  });
  engine.runAgent
    .mockReset()
    .mockImplementation(async ({ prompt }: { prompt: string }) => {
      const context = JSON.parse(
        prompt.slice(prompt.indexOf('{"systemPrompts":')).split('\n')[0],
      );
      const hasResult = context.messages.some(
        (m: { role: string; content: string }) =>
          m.role === 'tool' && m.content.includes('opened'),
      );
      if (
        !context.systemPrompts.join(' ').includes('https://example.com/guide')
      )
        throw Error('Source missing from parent context');
      return {
        result: hasResult
          ? { text: 'Opened the guide in your browser.', toolCalls: [] }
          : {
              text: '',
              toolCalls: [
                {
                  name: 'open_website',
                  argumentsJson: JSON.stringify({
                    urls: ['https://example.com/guide'],
                  }),
                },
              ],
            },
        usage: {},
      };
    });
  await platform.nativeVoice!.turn({
    ...turn,
    messageId: randomUUID(),
    understanding: {
      route: 'delegate',
      text: 'Show me the reference.',
      tool: {
        name: 'delegate_task',
        arguments: { request: 'Show me the reference.' },
      },
    },
  });
  await vi.waitFor(
    async () => {
      const [job] = await jobs.list({ parentThreadId: thread.id });
      expect(job).toMatchObject({
        status: 'completed',
        result: 'Opened the guide in your browser.',
      });
    },
    { timeout: 2500 },
  );
  expect(opened).toEqual(['https://example.com/guide']);
  const [job] = await jobs.list({ parentThreadId: thread.id });
  const saved = await platform.localConversations!.getSnapshot(
    job.workerThreadId,
  );
  expect(
    saved.messages
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.parse(String(m.content))),
  ).toContainEqual({
    results: [{ url: 'https://example.com/guide', status: 'opened' }],
  });
});

it('does not reopen a website when Realtime retries a compute call after its answer failed', async () => {
  const { VoiceService } = await import('../src/server/voice.js');
  const { createApp } = await import('../src/server/app.js');
  const { Runner } = await import('../src/server/runner.js');
  const { DesktopBrowserOpener } =
    await import('../src/desktop/host/browser-opener.js');
  const root = await mkdtemp(join(tmpdir(), 'dots-realtime-browser-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const storage = await StorageClient.open({
    database: join(root, 'workspace.sqlite'),
    ownerId: randomUUID(),
    engine: 'sqlite',
  });
  cleanup.push(() => storage.close());
  const { store, workspace } = storage.repositories;
  const opened: string[] = [];
  const host = new DesktopBrowserOpener(
    async (url) => {
      opened.push(url);
    },
    () => true,
  );
  const config = {
    conversationBackend: 'local' as const,
    llmBackend: 'subscription' as const,
    llmProvider: 'codex' as const,
    baseUrl: 'http://localhost',
    runtimeUrl: 'http://localhost/api/copilotkit',
    voiceName: 'marin',
    slackUsers: [],
    webSearchProvider: 'disabled' as const,
    voiceKey: 'fixture',
    voiceModel: 'fixture',
  };
  const platform = await Platform.create(store, workspace, config, {
    storage,
    openWebsite: async (url, id) =>
      (await host.handle({
        type: 'dots:open-website',
        url,
        id,
        expiresAt: Date.now() + 10000,
      }))!.result,
  });
  cleanup.push(() => platform.stop());
  await platform.start();
  const appConfig = { mode: 'sample' as const, baseUrl: 'http://localhost' };
  const app = createApp({
    store,
    runner: new Runner(store, appConfig),
    config: appConfig,
    platform,
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) =>
    app.request(String(url), init),
  );
  const voice = new VoiceService(
    {
      store,
      workspace,
      config,
      requireReady: () => platform.requireReady(),
      setup: () => ({ ...platform.setup(), voice: true }),
      history: (threadId) => platform.history(threadId),
      turn: (...args) => platform.turn(...args),
    },
    async () =>
      new Response('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111', {
        headers: { location: '/v1/realtime/calls/rtc_fixture' },
      }),
  );
  const dot = (await workspace.dots())[0];
  const thread = await platform.createConversation(dot.id, 'Realtime browser');
  const call = await voice.begin(
    thread.id,
    'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111',
    new AbortController().signal,
  );
  await voice.activate(call.id);
  const open = {
    result: {
      text: '',
      toolCalls: [
        {
          name: 'open_website',
          argumentsJson: JSON.stringify({
            urls: ['https://example.com/guide'],
          }),
        },
      ],
    },
    usage: {},
  };
  const answer = {
    result: { text: 'Opened the guide.', toolCalls: [] },
    usage: {},
  };
  engine.runAgent
    .mockReset()
    .mockResolvedValueOnce(open)
    .mockRejectedValueOnce(Error('Response failed after opening'))
    .mockResolvedValueOnce(open)
    .mockResolvedValueOnce(answer)
    .mockResolvedValueOnce(open)
    .mockResolvedValueOnce(answer);
  try {
    await expect(
      voice.compute(call.id, 'same-request', 'Open the guide.'),
    ).rejects.toThrow();
    expect(opened).toEqual(['https://example.com/guide']);
    await expect(
      voice.compute(call.id, 'same-request', 'Open the guide.'),
    ).resolves.toBe('Opened the guide.');
    expect(opened).toEqual(['https://example.com/guide']);
    await expect(
      voice.compute(call.id, 'new-owner-request', 'Open the guide again.'),
    ).resolves.toBe('Opened the guide.');
    expect(opened).toEqual([
      'https://example.com/guide',
      'https://example.com/guide',
    ]);
  } finally {
    await voice.end(call.id, '');
  }
}, 10000);
