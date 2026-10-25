import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent } from '@ag-ui/client';
import { Subject, of, lastValueFrom, toArray } from 'rxjs';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { Platform } from '../src/server/platform.js';
import { CodexAgent } from '../src/server/codex-agent.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { codexCoordinator } from '../src/server/codex-runtime.js';
import {
  voiceJobReceipt,
  voiceTaskControl,
} from '../src/server/local-voice/native-runtime.js';
import { evidenceHash } from '../src/server/conversation-memory.js';
import type { NativeVoiceSession } from '../src/server/local-voice/native-contract.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
async function fixture() {
  vi.stubEnv('CODEX_BIN', '/nonexistent/forbidden-live-provider');
  vi.stubEnv(
    'AGENT_COMMAND_JSON',
    JSON.stringify([
      process.execPath,
      resolve('tests/fixtures/subscription-provider.mjs'),
    ]),
  );
  const root = await mkdtemp(join(tmpdir(), 'dots-native-runtime-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const storage = await StorageClient.open({
    database: join(root, 'workspace.sqlite'),
    ownerId: randomUUID(),
    engine: 'sqlite',
  });
  cleanup.push(() => storage.close());
  const { store, workspace } = storage.repositories;
  const platform = await Platform.create(
    store,
    workspace,
    {
      conversationBackend: 'local',
      llmBackend: 'subscription',
      llmProvider: 'claude-code',
      baseUrl: '',
      runtimeUrl: 'http://localhost/api/copilotkit',
      voiceName: 'marin',
      slackUsers: [],
      webSearchProvider: 'disabled',
    },
    { storage },
  );
  cleanup.push(() => platform.stop());
  await platform.start();
  const dot = (await workspace.dots())[0];
  const thread = await platform.createConversation(dot.id, 'Native chat');
  const call = await workspace.createCall(thread.id);
  const native: NativeVoiceSession = {
    warm: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    interpret: vi.fn(async () => ({ route: 'chat' as const, text: 'Hello' })),
    respond: vi.fn(async () => ({
      text: 'Hello from local audio.',
      pcm: Buffer.from([0, 1, 0, 2]),
    })),
    speak: vi.fn(async (text) => ({ text, pcm: Buffer.from([0, 1, 0, 2]) })),
  };
  const turn = {
    callId: call.id,
    dotId: dot.id,
    threadId: thread.id,
    messageId: randomUUID(),
    audio: Buffer.from([2, 3, 4, 5]),
    understanding: { route: 'chat' as const, text: 'Hello' },
    native,
    signal: new AbortController().signal,
  };
  return {
    storage,
    platform,
    dot,
    thread,
    native,
    turn,
    database: join(root, 'workspace.sqlite'),
  };
}
it('sends ordinary High voice conversation through the same task agent in Codex mode', async () => {
  const f = await fixture();
  f.platform.config.agentEngine = 'codex';
  f.platform.config.llmProvider = 'codex';
  const executed = vi
    .spyOn(DotAgent.prototype, 'run')
    .mockImplementation((input) =>
      of(
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: 'answer',
          role: 'assistant',
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: 'answer',
          delta: 'Hello from the shared engine.',
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ),
    );
  const admission = await f.platform.nativeVoice!.turn(f.turn);
  expect(admission).toMatchObject({
    awaitingReply: true,
    text: '',
    pcm: Buffer.alloc(0),
  });
  expect(f.native.speak).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(executed).toHaveBeenCalledTimes(1));
  expect(f.native.respond).not.toHaveBeenCalled();
  const jobs = await f.platform.nativeVoice!.list(f.thread.id);
  expect(jobs[0].request).toBe('Hello');
  await vi.waitFor(async () =>
    expect((await f.platform.nativeVoice!.list(f.thread.id))[0]).toMatchObject({
      status: 'completed',
      result: 'Hello from the shared engine.',
    }),
  );
});

it('keeps the next voice request queued durably until the first task releases execution', async () => {
  const f = await fixture();
  f.platform.config.agentEngine = 'codex';
  f.platform.config.llmProvider = 'codex';
  const first = new Subject<BaseEvent>();
  let preceding: Promise<unknown> | undefined;
  const executed = vi
    .spyOn(DotAgent.prototype, 'run')
    .mockImplementation((input) => {
      preceding = f.platform.localConversations!.getSnapshot(f.thread.id);
      return of(
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      );
    })
    .mockImplementationOnce((input) => {
      queueMicrotask(() =>
        first.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        }),
      );
      return first;
    });
  await f.platform.nativeVoice!.turn(f.turn);
  await vi.waitFor(() => expect(executed).toHaveBeenCalledTimes(1));
  await f.platform.nativeVoice!.turn({
    ...f.turn,
    messageId: randomUUID(),
    understanding: { route: 'chat', text: 'Then inspect the second test.' },
  });
  const jobs = await f.platform.nativeVoice!.list(f.thread.id);
  expect(jobs).toHaveLength(2);
  expect(jobs[1]).toMatchObject({
    status: 'queued',
    request: 'Then inspect the second test.',
  });
  expect(executed).toHaveBeenCalledTimes(1);
  const run = executed.mock.calls[0][0];
  first.next({
    type: EventType.TEXT_MESSAGE_START,
    messageId: 'prior-answer',
    role: 'assistant',
  });
  first.next({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: 'prior-answer',
    delta: 'The first result is amber fox.',
  });
  first.next({ type: EventType.TEXT_MESSAGE_END, messageId: 'prior-answer' });
  first.next({
    type: EventType.RUN_FINISHED,
    threadId: run.threadId,
    runId: run.runId,
  });
  first.complete();
  await vi.waitFor(() => expect(executed).toHaveBeenCalledTimes(2));
  expect(JSON.stringify(await preceding)).toContain(
    'The first result is amber fox.',
  );
});
it('answers status locally and cancels a queued voice request without dispatching it', async () => {
  const f = await fixture();
  f.platform.config.agentEngine = 'codex';
  f.platform.config.llmProvider = 'codex';
  const executed = vi.spyOn(DotAgent.prototype, 'run');
  let release!: () => void;
  const active = codexCoordinator(f.platform.workspace).run(
    f.dot.id,
    'typed-run',
    new AbortController().signal,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    'typed-thread',
  );
  try {
    await f.platform.nativeVoice!.turn(f.turn);
    await f.platform.nativeVoice!.turn({
      ...f.turn,
      messageId: randomUUID(),
      understanding: { route: 'chat', text: 'Task status.' },
    });
    expect(f.native.speak).toHaveBeenLastCalledWith(
      expect.stringMatching(/running/i),
      expect.any(AbortSignal),
    );
    const jobs = await f.platform.nativeVoice!.list(f.thread.id);
    expect(jobs).toHaveLength(1);
    await f.platform.nativeVoice!.cancel(jobs[0].id);
    await vi.waitFor(() =>
      expect(
        codexCoordinator(f.platform.workspace).status(f.dot.id).queued,
      ).toBe(0),
    );
    expect(executed).not.toHaveBeenCalled();
  } finally {
    release();
    await active;
  }
});

it('speaks the authoritative answer without claiming a blocked task succeeded', () => {
  const job = {
    id: 'job',
    dotId: 'dot',
    workerThreadId: 'thread',
    status: 'completed',
    leaseGeneration: 1,
    result: 'I could not start the mouse mover because setup is required.',
  } as Parameters<typeof voiceJobReceipt>[0];
  expect(voiceJobReceipt(job, true).spoken).toBe(job.result);
  expect(voiceJobReceipt(job, true).text).not.toMatch(/task.*finished/);
});

it('recognizes the observed local ASR stop phrasing without treating stop-speaking as task cancellation', () => {
  expect(voiceTaskControl('Canceled a current task.')).toBe('stop');
  expect(voiceTaskControl('Cancel the current task.')).toBe('stop');
  expect(voiceTaskControl('Stop speaking.')).toBeUndefined();
  expect(voiceTaskControl('Explain how to cancel a task.')).toBeUndefined();
});

it('persists and answers voice status/stop while a typed run owns the same conversation', async () => {
  const f = await fixture();
  f.platform.config.agentEngine = 'codex';
  f.platform.config.llmProvider = 'codex';
  const events = new Subject<BaseEvent>();
  vi.spyOn(DotAgent.prototype, 'run').mockImplementation((input) => {
    queueMicrotask(() =>
      events.next({
        type: EventType.RUN_STARTED,
        runId: input.runId,
        threadId: input.threadId,
      }),
    );
    return events;
  });
  const input = {
    threadId: f.thread.id,
    runId: randomUUID(),
    messages: [
      { id: randomUUID(), role: 'user' as const, content: 'Long typed task' },
    ],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
  const typed = lastValueFrom(
    f.platform['localRunner']!.run({
      threadId: f.thread.id,
      agent: new DotAgent(
        f.platform.store,
        f.platform.workspace,
        f.platform.config,
        f.dot.id,
      ),
      input,
    }).pipe(toArray()),
  );
  await vi.waitFor(async () =>
    expect(
      (await f.platform.localConversations!.getSnapshot(f.thread.id)).lastRun
        ?.status,
    ).toBe('running'),
  );
  const status = await f.platform.nativeVoice!.turn({
    ...f.turn,
    messageId: randomUUID(),
    understanding: { route: 'chat', text: 'Task status.' },
  });
  expect(status.text).toMatch(/running/);
  const stopped = await f.platform.nativeVoice!.turn({
    ...f.turn,
    messageId: randomUUID(),
    understanding: { route: 'chat', text: 'Cancel the current task.' },
  });
  expect(stopped.text).toMatch(/Stop requested/);
  await typed;
  expect(
    (await f.platform.localConversations!.getSnapshot(f.thread.id)).lastRun
      ?.status,
  ).toBe('stopped');
  expect(
    (await f.storage.repositories.voiceDelegations.pendingInputs()).map(
      (row) => row.kind,
    ),
  ).toEqual(['status', 'stop']);
});

it('durably receives ordinary voice while typed work owns the parent, then dispatches it after release', async () => {
  const f = await fixture();
  f.platform.config.agentEngine = 'codex';
  f.platform.config.llmProvider = 'codex';
  const first = new Subject<BaseEvent>();
  const executed = vi
    .spyOn(DotAgent.prototype, 'run')
    .mockImplementation((input) =>
      of(
        {
          type: EventType.RUN_STARTED,
          runId: input.runId,
          threadId: input.threadId,
        },
        {
          type: EventType.RUN_FINISHED,
          runId: input.runId,
          threadId: input.threadId,
        },
      ),
    )
    .mockImplementationOnce((input) => {
      queueMicrotask(() =>
        first.next({
          type: EventType.RUN_STARTED,
          runId: input.runId,
          threadId: input.threadId,
        }),
      );
      return first;
    });
  const input = {
    threadId: f.thread.id,
    runId: randomUUID(),
    messages: [
      { id: randomUUID(), role: 'user' as const, content: 'Typed work' },
    ],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
  const typed = lastValueFrom(
    f.platform['localRunner']!.run({
      threadId: f.thread.id,
      agent: new DotAgent(
        f.platform.store,
        f.platform.workspace,
        f.platform.config,
        f.dot.id,
      ),
      input,
    }).pipe(toArray()),
  );
  await vi.waitFor(() => expect(executed).toHaveBeenCalledTimes(1));
  const received = await f.platform.nativeVoice!.turn(f.turn);
  expect(received).toMatchObject({
    awaitingReply: true,
    text: '',
    pcm: Buffer.alloc(0),
  });
  expect(f.native.speak).not.toHaveBeenCalled();
  expect(await f.storage.repositories.voiceDelegations.pendingInputs()).toEqual(
    [expect.objectContaining({ kind: 'request', caption: 'Hello' })],
  );
  first.next({
    type: EventType.RUN_FINISHED,
    runId: input.runId,
    threadId: input.threadId,
  });
  first.complete();
  await typed;
  await vi.waitFor(() => expect(executed).toHaveBeenCalledTimes(2), {
    timeout: 3500,
  });
});
it('keeps casual conversation local, sends the original waveform and persists canonical text', async () => {
  const provider = vi.spyOn(DotAgent.prototype, 'run');
  const f = await fixture();
  const result = await f.platform.nativeVoice!.turn(f.turn);
  expect(result.text).toBe('Hello from local audio.');
  expect(f.native.respond).toHaveBeenCalledWith(
    f.turn.audio,
    {
      caption: 'Hello',
      instructions: expect.stringContaining(`You are ${f.dot.name}.`),
      history: [],
    },
    expect.any(AbortSignal),
  );
  expect(provider).not.toHaveBeenCalled();
  const saved = await f.platform.localConversations!.getSnapshot(f.thread.id);
  expect(saved.messages.map((m) => m.content)).toEqual([
    'Hello',
    'Hello from local audio.',
  ]);
  expect(saved.lastRun?.status).toBe('finished');
  await f.platform.nativeVoice!.turn({
    ...f.turn,
    messageId: randomUUID(),
    understanding: { route: 'clarify', text: 'How about you?' },
  });
  expect(f.native.respond).toHaveBeenLastCalledWith(
    f.turn.audio,
    {
      caption: 'How about you?',
      instructions: expect.stringContaining(`You are ${f.dot.name}.`),
      history: [
        { role: 'user', text: 'Hello' },
        { role: 'assistant', text: 'Hello from local audio.' },
      ],
    },
    expect.any(AbortSignal),
  );
  expect(f.native.speak).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
});
it('runs delegated work on a linked thread while local conversation can continue', async () => {
  const events = new Subject<BaseEvent>();
  const provider = vi
    .spyOn(DotAgent.prototype, 'run')
    .mockImplementation((input) => {
      queueMicrotask(() =>
        events.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        }),
      );
      return events;
    });
  const f = await fixture();
  const understanding = {
    route: 'delegate' as const,
    text: 'Fix the login bug.',
    tool: {
      name: 'delegate_task' as const,
      arguments: { request: 'Fix the login bug.' },
    },
  };
  const result = await f.platform.nativeVoice!.turn({
    ...f.turn,
    understanding,
  });
  expect(result.text).toContain('queued');
  await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
  const job = (await f.storage.repositories.voiceDelegations.list())[0];
  expect(job).toMatchObject({
    parentThreadId: f.thread.id,
    dotId: f.dot.id,
    status: 'running',
  });
  expect(job.workerThreadId).not.toBe(f.thread.id);
  expect(provider.mock.calls[0][0].tools.map((t) => t.name)).toContain(
    'request_connection_action',
  );
  await f.platform.nativeVoice!.turn({ ...f.turn, messageId: randomUUID() });
  expect(f.native.respond).toHaveBeenCalledOnce();
  await f.platform.nativeVoice!.cancel(job.id);
  expect(
    await f.storage.repositories.voiceDelegations.get(job.id),
  ).toMatchObject({ status: 'cancelled' });
});
it.each([true, false])(
  'handles folder waits without queuing phantom work (expired: %s)',
  async (expired) => {
    const f = await fixture();
    await f.platform.nativeVoice!.turn(f.turn);
    const jobs = f.storage.repositories.voiceDelegations;
    const worker = randomUUID();
    await jobs.enqueue({
      id: 'expired',
      dotId: f.dot.id,
      callId: f.turn.callId,
      parentThreadId: f.thread.id,
      workerThreadId: worker,
      utteranceId: f.turn.messageId,
      sourceMessageId: f.turn.messageId,
      sourceText: 'Hello',
      request: 'Open Project Notes',
    });
    const request = await f.storage.repositories.workspace.folders.request(
      f.dot.id,
      worker,
      {
        reason: 'Read project notes',
        folderHint: 'Project Notes',
        access: 'read',
      },
    );
    const runId = randomUUID();
    const jobLease = (await jobs.claim('expired', runId, 60000))!;
    const thread =
      (await f.platform.localConversations!.acquireThread(worker))!;
    const messages: import('@ag-ui/client').Message[] = [
      {
        id: 'approval',
        role: 'assistant',
        toolCalls: [
          {
            id: 'folder-call',
            type: 'function',
            function: {
              name: 'review_local_folder_access',
              arguments: JSON.stringify({ requestId: request.id }),
            },
          },
        ],
      },
    ];
    await thread.beginRun({
      threadId: worker,
      runId,
      messages: [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    });
    await thread.appendEvent({ type: EventType.MESSAGES_SNAPSHOT, messages });
    await thread.finishRun(messages, {}, 'finished');
    await thread.release();
    await jobs.settle(jobLease, { status: 'approval' });
    if (!expired) {
      const result = await f.platform.nativeVoice!.turn({
        ...f.turn,
        messageId: randomUUID(),
        understanding: {
          route: 'delegate',
          text: 'Please open my folder again.',
          tool: {
            name: 'delegate_task',
            arguments: { request: 'Please open my folder again.' },
          },
        },
      });
      expect(result).toMatchObject({ reviewFolders: true });
      expect(result.text).toMatch(/waiting for approval/i);
      expect(result.text).not.toMatch(/queued/i);
      expect(await jobs.list({ active: true })).toHaveLength(1);
      const otherThread = await f.platform.createConversation(
        f.dot.id,
        'Another call',
      );
      const otherCall = await f.platform.workspace.createCall(otherThread.id);
      await f.platform.nativeVoice!.turn({
        ...f.turn,
        threadId: otherThread.id,
        callId: otherCall.id,
        messageId: randomUUID(),
      });
      const context = vi.mocked(f.native.respond).mock.calls.at(-1)![1];
      expect(context.instructions).toContain('Current task status: approval.');
      return;
    }
    const db = new DatabaseSync(f.database);
    try {
      db.prepare(
        "UPDATE folder_requests SET value=json_set(value,'$.request.expiresAt',?) WHERE id=?",
      ).run(Date.now() - 1000, request.id);
    } finally {
      db.close();
    }
    await vi.waitFor(
      async () =>
        expect(await jobs.get('expired')).toMatchObject({
          status: 'interrupted',
          error: 'Folder approval expired. Please ask again.',
          deliveredAt: expect.any(Number),
        }),
      { timeout: 4000 },
    );
    expect(await jobs.list({ active: true })).toEqual([]);
    const snapshot = await f.platform.localConversations!.getSnapshot(
      f.thread.id,
    );
    expect(
      snapshot.messages.some(
        (m) =>
          typeof m.content === 'string' &&
          m.content.includes('Folder approval expired. Please ask again.'),
      ),
    ).toBe(true);
  },
);

it('rejects forged model delegation and cross-Dot call bindings before queuing', async () => {
  const provider = vi.spyOn(DotAgent.prototype, 'run').mockReturnValue(of());
  const f = await fixture();
  await expect(
    f.platform.nativeVoice!.turn({
      ...f.turn,
      understanding: {
        route: 'delegate',
        text: 'Hello',
        tool: {
          name: 'delegate_task',
          arguments: { request: 'Different request' },
        },
      },
    }),
  ).rejects.toThrow(/request|caption/);
  await expect(
    f.platform.nativeVoice!.turn({ ...f.turn, dotId: 'wrong' }),
  ).rejects.toThrow();
  expect(await f.storage.repositories.voiceDelegations.list()).toEqual([]);
  expect(provider).not.toHaveBeenCalled();
});

it('provides bounded authorized routing history and rejects a different call scope', async () => {
  const f = await fixture();
  await f.platform.nativeVoice!.turn(f.turn);
  const runtime = f.platform.nativeVoice!;
  expect(await runtime.context(f.turn)).toEqual({
    history: [
      { role: 'user', text: 'Hello' },
      { role: 'assistant', text: 'Hello from local audio.' },
    ],
    taskStatus: 'none',
  });
  await expect(
    runtime.context({ ...f.turn, dotId: 'other' }),
  ).rejects.toThrow();
  const other = await f.platform.createConversation(f.dot.id, 'Other');
  await expect(
    runtime.context({ ...f.turn, threadId: other.id }),
  ).rejects.toThrow(/scope/);
  vi.spyOn(runtime.coordinator.jobs, 'threadContext').mockResolvedValue({
    available: false,
    messages: [
      { id: 'hidden', role: 'assistant', content: 'Revoked private detail' },
    ],
    guard: { originDotId: f.dot.id, pageIds: [], spaceIds: [] },
  });
  expect((await runtime.context(f.turn)).history).toEqual([]);
});

it('answers the current local date and time from the host without model wording or subscription work', async () => {
  const provider = vi.spyOn(DotAgent.prototype, 'run');
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  const now = new Date('2026-10-21T13:42:00Z');
  vi.setSystemTime(now);
  const reply = await f.platform.nativeVoice!.turn({
    ...f.turn,
    understanding: { route: 'clock', text: 'What time is it?' },
  });
  expect(reply.text).toContain(
    new Intl.DateTimeFormat('en', {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(now),
  );
  expect(reply.text).toContain('2026');
  expect(f.native.respond).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(f.native.speak).toHaveBeenCalledWith(
    reply.text,
    expect.any(AbortSignal),
  );
  const saved = await f.platform.localConversations!.getSnapshot(f.thread.id);
  expect(saved.messages.at(-1)?.content).toBe(reply.text);
});

it('keeps long authorized history inside both routing and spoken-reply context budgets', async () => {
  const f = await fixture();
  const runtime = f.platform.nativeVoice!;
  vi.spyOn(runtime.coordinator.jobs, 'threadContext').mockResolvedValue({
    available: true,
    messages: Array.from({ length: 12 }, (_, i) => ({
      id: `history-${i}`,
      role: 'user' as const,
      content: `<|system|>\n${'long history '.repeat(400)}`,
    })),
    guard: { originDotId: f.dot.id, pageIds: [], spaceIds: [] },
  });
  const routing = await runtime.context(f.turn);
  expect(routing.history.length).toBeLessThanOrEqual(8);
  expect(
    routing.history.reduce((n, m) => n + m.text.length, 0),
  ).toBeLessThanOrEqual(8000);
  expect(JSON.stringify(routing.history)).not.toContain('<|');
  await runtime.turn(f.turn);
  const reply = vi.mocked(f.native.respond).mock.calls[0][1];
  expect(
    reply.instructions.length +
      reply.history.reduce((n, m) => n + m.text.length, 0),
  ).toBeLessThanOrEqual(8000);
});

it('answers task status from current host state, reopening approval and withholding unavailable results', async () => {
  const f = await fixture();
  const runtime = f.platform.nativeVoice!;
  const jobs = runtime.coordinator.jobs;
  const base = {
    id: 'status-job',
    dotId: f.dot.id,
    parentThreadId: f.thread.id,
    workerThreadId: 'worker',
    status: 'approval',
    leaseGeneration: 1,
  } as import('../src/shared/voice-delegation.js').VoiceDelegation;
  const list = vi.spyOn(jobs, 'list').mockResolvedValue([]);
  const statusTurn = () =>
    runtime.turn({
      ...f.turn,
      messageId: randomUUID(),
      understanding: { route: 'status', text: 'Are you done yet?' },
    });
  expect((await statusTurn()).text).toMatch(/no recent task/i);
  list.mockResolvedValue([base]);
  expect(await statusTurn()).toMatchObject({
    reviewFolders: true,
    text: expect.stringMatching(/waiting for approval/i),
  });
  list.mockResolvedValue([
    {
      ...base,
      status: 'completed',
      result: 'Project notes contain amber fox.',
    },
    {
      ...base,
      id: 'another-task',
      parentThreadId: 'another-thread',
      status: 'running',
    },
  ]);
  vi.spyOn(jobs, 'threadContext').mockResolvedValue({
    available: false,
    messages: [],
    guard: { originDotId: f.dot.id, pageIds: [], spaceIds: [] },
  });
  expect((await runtime.context(f.turn)).taskStatus).toBe('completed');
  const hidden = await statusTurn();
  expect(hidden.text).not.toContain('amber fox');
  expect(hidden.text).toMatch(/finished/i);
  expect(f.native.respond).not.toHaveBeenCalled();
});

it.each([false, true])(
  'does not speak suppressed canonical task results (legacy generic receipt: %s)',
  async (legacy) => {
    const f = await fixture();
    await f.platform.nativeVoice!.turn(f.turn);
    const jobs = f.storage.repositories.voiceDelegations;
    const worker = randomUUID();
    await jobs.enqueue({
      id: 'forgotten-task',
      dotId: f.dot.id,
      callId: f.turn.callId,
      parentThreadId: f.thread.id,
      workerThreadId: worker,
      utteranceId: f.turn.messageId,
      sourceMessageId: f.turn.messageId,
      sourceText: 'Hello',
      request: 'Read the notes',
    });
    const runId = randomUUID();
    const lease = (await jobs.claim('forgotten-task', runId, 60000))!;
    const thread =
      (await f.platform.localConversations!.acquireThread(worker))!;
    const guard = { originDotId: f.dot.id, pageIds: [], spaceIds: [] };
    const answer = {
      id: 'private-answer',
      role: 'assistant' as const,
      content: 'The private label is amber-fox-178.',
    };
    await thread.beginRun(
      {
        threadId: worker,
        runId,
        messages: [],
        tools: [],
        state: {},
        context: [],
        forwardedProps: {},
      },
      guard,
    );
    await thread.appendEvent({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [answer],
    });
    await thread.finishRun([answer], {}, 'finished');
    await thread.release();
    await jobs.settle(lease, {
      status: 'completed',
      result: legacy
        ? 'The task finished. Review its conversation for details.'
        : answer.content,
    });
    const visible = await f.platform.nativeVoice!.turn({
      ...f.turn,
      messageId: randomUUID(),
      understanding: { route: 'status', text: 'What did you find?' },
    });
    expect(visible.text).toContain('amber-fox-178');
    await f.storage.repositories.workspace.memory.history.suppress(
      [
        {
          threadId: worker,
          runId,
          messageIds: [answer.id],
          contentHash: evidenceHash(answer),
          guard,
        },
      ],
      'fixture',
    );
    expect(await jobs.threadContext(worker, f.dot.id)).toMatchObject({
      available: true,
      messages: [{ content: '[Memory content withheld]' }],
    });
    const status = await f.platform.nativeVoice!.turn({
      ...f.turn,
      messageId: randomUUID(),
      understanding: { route: 'status', text: 'What did you find?' },
    });
    expect(status.text).not.toContain('amber-fox-178');
    expect(status.text).toMatch(/finished/i);
  },
);

it.skipIf(
  !existsSync(
    resolve('node_modules/myown-llm-integrator/python/.venv/bin/python'),
  ),
)(
  'delegates permitted prior discussion and returns the actual result to the parent',
  async () => {
    vi.stubEnv(
      'MYOWN_LLM_PYTHON',
      resolve('node_modules/myown-llm-integrator/python/.venv/bin/python'),
    );
    vi.stubEnv(
      'AGENT_COMMAND_JSON',
      JSON.stringify([
        process.execPath,
        resolve('tests/fixtures/subscription-provider.mjs'),
      ]),
    );
    const f = await fixture();
    vi.mocked(f.native.respond).mockResolvedValue({
      text: 'The diagnostic label is amber fox.',
      pcm: Buffer.alloc(20),
    });
    await f.platform.nativeVoice!.turn(f.turn);
    const text = 'voice-context-fixture: summarize what we discussed';
    await f.platform.nativeVoice!.turn({
      ...f.turn,
      messageId: randomUUID(),
      understanding: {
        route: 'delegate',
        text,
        tool: { name: 'delegate_task', arguments: { request: text } },
      },
    });
    await vi.waitFor(
      async () => {
        const jobs = await f.storage.repositories.voiceDelegations.list();
        expect(jobs[0]).toMatchObject({
          status: 'completed',
          result: 'Context received: amber fox.',
        });
      },
      { timeout: 10000 },
    );
    await vi.waitFor(
      async () => {
        expect(
          (
            await f.platform.localConversations!.getSnapshot(f.thread.id)
          ).messages.some(
            (m) =>
              typeof m.content === 'string' &&
              m.content.includes('Context received: amber fox.'),
          ),
        ).toBe(true);
      },
      { timeout: 4000 },
    );
  },
  15000,
);

it('speaks a bounded actual result and keeps code in the task conversation', async () => {
  const { voiceJobReceipt } =
    await import('../src/server/local-voice/native-runtime.js');
  const f = await fixture();
  await f.platform.nativeVoice!.turn(f.turn);
  const job = {
    id: 'job',
    dotId: f.dot.id,
    workerThreadId: 'worker',
    status: 'completed' as const,
    leaseGeneration: 1,
    result: 'The diagnostic label is amber fox.\n```js\nconst hidden = 1;\n```',
  } as import('../src/shared/voice-delegation.js').VoiceDelegation;
  const receipt = voiceJobReceipt(job);
  expect(receipt.text).toContain('const hidden = 1');
  expect(receipt.spoken).toContain('amber fox');
  expect(receipt.spoken).not.toContain('const hidden');
  expect(receipt.spoken.length).toBeLessThanOrEqual(400);
});

it('keeps the outer Dot run open through timeout until native cancellation is confirmed', async () => {
  const f = await fixture();
  f.platform.config.agentEngine = 'codex';
  f.platform.config.llmProvider = 'codex';
  f.platform.config.storageEngine = 'sqlite';
  f.platform.config.agentRunTimeoutMs = 700;
  const native = new Subject<BaseEvent>();
  let current!: Parameters<CodexAgent['run']>[0];
  const executed = vi
    .spyOn(CodexAgent.prototype, 'run')
    .mockImplementation((input) => {
      current = input;
      queueMicrotask(() =>
        native.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        }),
      );
      return native;
    });
  const aborted = vi
    .spyOn(CodexAgent.prototype, 'abortRun')
    .mockImplementation(() => {});
  const input = {
    threadId: f.thread.id,
    runId: randomUUID(),
    messages: [
      {
        id: randomUUID(),
        role: 'user' as const,
        content: 'Inspect runtime status',
      },
    ],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
  let done = false;
  const run = lastValueFrom(
    f.platform['localRunner']!.run({
      threadId: f.thread.id,
      agent: new DotAgent(
        f.platform.store,
        f.platform.workspace,
        f.platform.config,
        f.dot.id,
      ),
      input,
    }).pipe(toArray()),
  ).then((events) => {
    done = true;
    return events;
  });
  await vi.waitFor(() => expect(executed).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(aborted).toHaveBeenCalled(), { timeout: 1500 });
  expect(done).toBe(false);
  expect(
    (await f.platform.localConversations!.getSnapshot(f.thread.id)).lastRun
      ?.status,
  ).toBe('running');
  native.next({
    type: EventType.RUN_ERROR,
    code: 'EXECUTION_UNCERTAIN',
    message: 'Native process ended without confirmed cancellation.',
  });
  native.complete();
  const events = await run;
  expect(events.at(-1)).toMatchObject({
    type: EventType.RUN_ERROR,
    code: 'EXECUTION_UNCERTAIN',
  });
  expect(
    (await f.platform.localConversations!.getSnapshot(f.thread.id)).lastRun
      ?.status,
  ).toBe('interrupted');
  expect(current.runId).toBe(input.runId);
});

it('speaks short plain-text result blocks while leaving programming code in chat', () => {
  const job = {
    id: 'job',
    dotId: 'dot',
    workerThreadId: 'thread',
    status: 'completed',
    leaseGeneration: 1,
    result: 'The label is:\n```text\nmaple token\n```',
  } as Parameters<typeof voiceJobReceipt>[0];
  expect(voiceJobReceipt(job, true).spoken).toContain('maple token');
  expect(
    voiceJobReceipt({ ...job, result: '```js\nexport const a = 1;\n```' }, true)
      .spoken,
  ).toContain('Code is in the task conversation');
});
