import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dots-worker-runtime-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const storage = await StorageClient.open({
    database: join(root, 'workspace.sqlite'),
    ownerId: randomUUID(),
  });
  cleanup.push(() => storage.close());
  const { store, workspace } = storage.repositories;
  const config = {
    conversationBackend: 'local' as const,
    llmBackend: 'subscription' as const,
    llmProvider: 'claude-code',
    baseUrl: '',
    runtimeUrl: 'http://localhost/api/copilotkit',
    voiceName: 'marin',
    slackUsers: [],
    webSearchProvider: 'disabled' as const,
  };
  const platform = await Platform.create(store, workspace, config, { storage });
  cleanup.push(() => platform.stop());
  const dot = (await workspace.dots())[0];
  return { storage, store, workspace, platform, config, dot };
}
it('runs local chat and durable page writes through the worker without PostgreSQL', async () => {
  vi.stubEnv(
    'AGENT_COMMAND_JSON',
    JSON.stringify([
      process.execPath,
      resolve('tests/fixtures/subscription-provider.mjs'),
    ]),
  );
  const f = await fixture();
  await f.platform.start();
  const thread = await f.platform.createConversation(
    f.dot.id,
    'Worker conversation',
  );
  const agent = new ProxiedCopilotRuntimeAgent({
    runtimeUrl: f.config.runtimeUrl,
    agentId: f.dot.id,
    threadId: thread.id,
    runtimeMode: 'sse',
    transport: 'rest',
    fetch: (url, init) => f.platform.handle(new Request(url, init)),
  });
  agent.addMessage({ id: 'user', role: 'user', content: 'save-fixture' });
  await agent.runAgent();
  expect(
    (await f.platform.localConversations!.getEvents(thread.id)).filter(
      (event) => event.type === 'RUN_ERROR',
    ),
  ).toEqual([]);
  expect(
    agent.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content)
      .join('\n'),
  ).toContain('Offline provider completed');
  expect(
    (await f.workspace.pages.list(f.dot.spaceId)).some(
      (page) => page.title === 'Offline fixture note',
    ),
  ).toBe(true);
  expect(await f.platform.history(thread.id)).toContain(
    'Offline provider completed',
  );
  await f.platform.stop();
  expect(
    (await f.platform.localConversations!.getSnapshot(thread.id))?.lastRun
      ?.status,
  ).toBe('finished');
}, 60000);
it('serves manual pages and memory settings over owner-authenticated worker routes', async () => {
  const f = await fixture();
  const config = { mode: 'sample' as const, baseUrl: '' };
  const runner = new Runner(f.store, config);
  const app = createApp({
    store: f.store,
    runner,
    config,
    platform: f.platform,
    ownerToken: 'owner',
  });
  const request = (path: string, body?: unknown) =>
    app.request('/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: 'Bearer owner',
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const response = await request(`/spaces/${f.dot.spaceId}/pages`, {
    title: 'Durable worker page',
  });
  expect(response.status).toBe(201);
  const page = await response.json();
  expect((await f.workspace.pages.get(f.dot.spaceId, page.id)).title).toBe(
    'Durable worker page',
  );
  const memory = await request('/memory-items', {
    scope: { kind: 'dot', id: f.dot.id },
    title: 'Preference',
    text: 'I prefer short answers.',
  });
  expect(memory.status).toBe(201);
  expect((await f.workspace.memory.listOwner()).items).toHaveLength(1);
  expect((await request(`/dots/${f.dot.id}/memory-settings`)).status).toBe(200);
});
it.each(['read', 'create'] as const)(
  'reauthorizes page %s after a delayed worker dispatch',
  async (operation) => {
    const f = await fixture();
    const thread = await f.platform.createConversation(
      f.dot.id,
      'Permission check',
    );
    const page = await f.workspace.pages.create(f.dot.spaceId, {
      title: 'Private page',
      content: 'Private content',
    });
    const { pageAccess } = await import('../src/server/page-tools.js');
    const access = await pageAccess(
      f.workspace,
      f.dot.spaceId,
      thread.id,
      () => {},
    );
    const call = f.storage.call.bind(f.storage);
    let resume!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const spy = vi
      .spyOn(f.storage, 'call')
      .mockImplementation(async (method, args, options) => {
        if (
          (operation === 'create' && method.endsWith('.create')) ||
          (operation === 'read' &&
            (method === 'pages.get' || method === 'policy.readPage'))
        ) {
          started();
          await held;
        }
        return call(method, args, options);
      });
    const result = (
      operation === 'create'
        ? access.create({ title: 'Unauthorized page' })
        : access.read(page.id)
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await waiting;
      const space = await f.workspace.createSpace(
        'Other',
        'Revoked original access',
      );
      await f.workspace.updateDot(f.dot.id, {
        ...f.dot,
        spaceId: space.id,
        spaceIds: [space.id],
      });
      resume();
      expect(await result).toHaveProperty('error');
      expect(
        (await f.workspace.pages.list(f.dot.spaceId)).map((page) => page.title),
      ).toEqual(['Private page']);
    } finally {
      resume();
      await result;
      spy.mockRestore();
    }
  },
);
it('drains unawaited scheduled progress writes before recording task completion', async () => {
  const f = await fixture();
  const task = await f.store.createTask('Scheduled worker task');
  const runner = new Runner(
    f.store,
    { mode: 'sample', baseUrl: '' },
    async (_claim, _memories, _signal, progress) => {
      void progress('Durable progress');
      return { text: 'Finished', sources: [], sample: true };
    },
    undefined,
    f.platform.maintenance,
  );
  cleanup.push(() => runner.stop());
  await runner.tick();
  const detail = (await f.store.detail(task.id))!;
  expect(detail.runs[0].result?.text).toBe('Finished');
  expect(detail.events.map((event) => event.text).slice(-2)).toEqual([
    'Durable progress',
    'Fictional sample brief ready.',
  ]);
});
it('persists and flushes setup telemetry through the worker', async () => {
  const f = await fixture();
  const { SetupTelemetry } = await import('../src/server/setup-telemetry.js');
  const delivered: unknown[] = [];
  const telemetry = await SetupTelemetry.create(
    f.store,
    {},
    async (_identity, body) => {
      delivered.push(body);
    },
    () => {},
    f.platform.maintenance,
  );
  cleanup.push(() => telemetry.stop());
  await telemetry.capture({ kind: 'step_viewed', step: 'ready' });
  expect(JSON.parse((await f.store.setupTelemetryState())!).queue).toHaveLength(
    1,
  );
  await telemetry.flush();
  expect(delivered).toHaveLength(1);
  expect(JSON.parse((await f.store.setupTelemetryState())!).queue).toEqual([]);
});
it.each(['basic', 'medium'] as const)(
  'holds backup admission until %s voice delivery and the final call receipt are durable',
  async (quality) => {
    const f = await fixture();
    const { LiveVoiceCall } = await import('../src/server/local-voice/live.js');
    const thread = await f.platform.createConversation(
      f.dot.id,
      'Voice receipt',
    );
    const receipt = await f.workspace.createCall(thread.id);
    const release = await f.platform.maintenance.enterWrite(
      new AbortController().signal,
    );
    const voice = new LiveVoiceCall(
      {
        id: receipt.id,
        token: 'fixture-token',
        threadId: thread.id,
        dotId: f.dot.id,
        quality,
      },
      {
        requireThread: () => f.workspace.requireThread(thread.id, f.dot.id),
        paused: async () => (await f.store.settings()).paused,
        foreground: (signal) =>
          f.platform.memory!.enterForeground(signal, thread.id),
        snapshot: () => f.platform.localConversations!.getSnapshot(thread.id),
        stop: async () => {},
        receipt: async (state, text, error) => {
          await f.workspace.setCall(receipt.id, state, text, error);
        },
        delivery: async (rows) => {
          await f.workspace.saveVoiceDelivery(receipt.id, rows);
        },
        closed: release,
      },
      () => ({
        recognition: {
          warm: async () => {},
          close: async () => {},
          transcribe: async () => ({ text: '', language: 'en', segments: [] }),
        },
        vad: {
          warm: async () => {},
          close: async () => {},
          detect: async () => 0,
          reset: async () => {},
        },
        ...(quality === 'medium'
          ? {
              synthesis: {
                warm: async () => {},
                close: async () => {},
                synthesize: async () => Buffer.alloc(0),
              },
            }
          : {}),
      }),
    );
    cleanup.push(() => voice.end());
    await voice.start();
    const dispatch = f.storage.call.bind(f.storage);
    let resume!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const spy = vi
      .spyOn(f.storage, 'call')
      .mockImplementation(async (method, args, options) => {
        if (method === 'workspace.setCall' && args[1] === 'ended') {
          started();
          await held;
        }
        return dispatch(method, args, options);
      });
    const ending = voice.end();
    await waiting;
    let acquired = false;
    const backup = f.platform.maintenance
      .acquire({ origin: 'automatic', signal: new AbortController().signal })
      .then((lease) => {
        acquired = true;
        return lease;
      });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(acquired).toBe(false);
      expect(
        (await f.workspace.calls()).find((call) => call.id === receipt.id)
          ?.status,
      ).toBe('active');
    } finally {
      resume();
      await ending;
      (await backup).release();
      spy.mockRestore();
    }
    expect(
      (await f.workspace.calls()).find((call) => call.id === receipt.id)
        ?.status,
    ).toBe('ended');
  },
);
it.each([false, true])(
  'publishes or cancels a queued Dream publication through the worker (cancel=%s)',
  async (cancel) => {
    const f = await fixture();
    const { MemoryMaintenance } =
      await import('../src/server/memory-maintenance.js');
    const thread = await f.platform.createConversation(f.dot.id, 'Preference');
    const messages = [
      {
        id: 'preference',
        role: 'user' as const,
        content: 'I prefer concise reports.',
      },
    ];
    const lease = (await f.platform.localConversations!.acquireThread(
      thread.id,
    ))!;
    try {
      await lease.beginRun(
        {
          threadId: thread.id,
          runId: 'preference-run',
          messages,
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        },
        { originDotId: f.dot.id, spaceIds: [], pageIds: [] },
      );
      await lease.finishRun(messages, {}, 'finished');
    } finally {
      await lease.release();
    }
    let sources: string[] = [];
    const invoke = vi.fn(async () => ({
      result: {
        kind: 'proposal',
        noChangeReason: null,
        changes: [
          {
            kind: 'create',
            title: 'Report style',
            text: messages[0].content,
            sourceIds: sources,
            support: 'explicit_user',
            justification: 'Direct preference',
            retention: 'stable',
            expiresAt: null,
          },
        ],
      },
      usage: {},
    }));
    const memory = await MemoryMaintenance.create(
      f.store,
      f.workspace,
      f.config,
      {
        repositories: f.storage.repositories,
        maintenance: f.platform.maintenance,
        invoke,
      },
    );
    cleanup.push(() => memory.stop());
    const job = await memory.requestDream(f.dot.id, [thread.id]);
    sources = job.sourceIds;
    expect(sources).toHaveLength(1);
    let resume!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const dispatch = f.storage.call.bind(f.storage);
    const spy = vi
      .spyOn(f.storage, 'call')
      .mockImplementation(async (method, args, options) => {
        if (cancel && method === 'jobs.publishDream') {
          started();
          await held;
        }
        return dispatch(method, args, options);
      });
    cleanup.push(async () => {
      resume();
      spy.mockRestore();
    });
    await memory.tick();
    if (cancel) {
      await waiting;
      memory.pause();
      resume();
      await memory.stop();
      expect((await memory.jobs.get(job.id))?.state).toBe('cancelled');
      expect(await f.workspace.memory.history.receipt(job.id)).toBeUndefined();
      expect((await f.workspace.memory.listOwner()).items).toEqual([]);
      return;
    }
    await vi.waitFor(async () =>
      expect((await memory.jobs.get(job.id))?.state).toBe('succeeded'),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    const receipt = await f.workspace.memory.history.receipt(job.id);
    expect(receipt?.changes[0].after).toMatchObject({
      text: messages[0].content,
      status: 'pending',
    });
    expect(
      await memory.repository.pendingSources({
        dotId: f.dot.id,
        since: 0,
        threadIds: [thread.id],
        cursor: '',
      }),
    ).toEqual([]);
    await memory.tick();
    expect(invoke).toHaveBeenCalledTimes(1);
  },
);
it('rejects an external computer action revoked during endpoint discovery', async () => {
  const f = await fixture();
  const { ComputerService } = await import('../src/server/computer-service.js');
  await f.workspace.computers.patch(f.dot.id, { enabled: true, shell: true });
  let resume!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const transport = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/computers')) {
      started();
      await held;
      return Response.json({
        computers: [
          {
            botId: f.dot.id,
            container: `opendots-computer-${f.dot.id}`,
            status: 'running',
          },
        ],
      });
    }
    return Response.json({ success: true });
  });
  const service = new ComputerService(
    f.workspace,
    {
      ...f.config,
      computerSupervisorUrl: 'http://supervisor:3000',
      computerSupervisorToken: 'fixture-supervisor',
      computerToken: 'fixture-computer',
    },
    async () => (await f.store.settings()).paused,
    transport,
  );
  const result = service
    .action(f.dot.id, 'exec', { command: 'fixture-command' }, 'agent')
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  try {
    await waiting;
    await f.workspace.computers.patch(f.dot.id, { shell: false });
  } finally {
    resume();
  }
  expect(await result).toHaveProperty('error');
  expect(transport).toHaveBeenCalledTimes(1);
  expect((await f.workspace.computers.audit(f.dot.id))[0]).toMatchObject({
    action: 'exec',
    outcome: 'failed',
  });
});
