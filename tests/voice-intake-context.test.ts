import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { Platform } from '../src/server/platform.js';
import { codexCoordinator } from '../src/server/codex-runtime.js';
import { evidenceHash } from '../src/server/conversation-memory.js';
import type { NativeTurn } from '../src/server/local-voice/native-runtime.js';
import type { Message } from '@ag-ui/core';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'voice-intake-context-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const storage = await StorageClient.open({
    database: join(root, 'test.sqlite'),
    ownerId: randomUUID(),
    engine: 'sqlite',
  });
  cleanup.push(() => storage.close());
  const { store, workspace, voiceDelegations: jobs } = storage.repositories;
  const platform = await Platform.create(
    store,
    workspace,
    {
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
    },
    { storage },
  );
  cleanup.push(() => platform.stop());
  await platform.start();
  const dot = (await workspace.dots())[0];
  const thread = await platform.createConversation(dot.id, 'Privacy fixture');
  const call = await workspace.createCall(thread.id);
  const release = await codexCoordinator(workspace).acquire(
    dot.id,
    'held',
    new AbortController().signal,
    'other',
  );
  cleanup.push(release);
  const guard = { originDotId: dot.id, pageIds: [], spaceIds: [] };
  const speak = vi.fn(async (text: string) => ({ text, pcm: Buffer.alloc(0) }));
  const turn: NativeTurn = {
    callId: call.id,
    dotId: dot.id,
    threadId: thread.id,
    messageId: randomUUID(),
    audio: Buffer.alloc(0),
    understanding: { route: 'chat', text: 'How are you?' },
    signal: new AbortController().signal,
    native: {
      warm: async () => {},
      close: async () => {},
      interpret: vi.fn(),
      respond: vi.fn(),
      speak,
    },
  };
  const save = async (messages: Message[]) => {
    const runId = randomUUID();
    const lease = (await platform.localConversations!.acquireThread(
      thread.id,
    ))!;
    await lease.beginRun(
      {
        threadId: thread.id,
        runId,
        messages,
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      guard,
    );
    await lease.finishRun(messages, {}, 'finished');
    await lease.release();
    return runId;
  };
  const suppress = async (runId: string, message: Message) => {
    await workspace.memory.history.suppress(
      [
        {
          threadId: thread.id,
          runId,
          messageIds: [message.id],
          contentHash: evidenceHash(message),
          guard,
        },
      ],
      'fixture',
    );
  };
  return {
    workspace,
    platform,
    jobs,
    dot,
    thread,
    call,
    turn,
    speak,
    save,
    suppress,
  };
}

it('withholds a forgotten source caption from intake task summaries', async () => {
  const f = await fixture();
  const secret = 'private-cobalt-852';
  const source: Message = {
    id: randomUUID(),
    role: 'user',
    content: `Inspect ${secret}.`,
  };
  const runId = await f.save([source]);
  await f.jobs.enqueue(
    {
      id: 'private-task',
      dotId: f.dot.id,
      callId: f.call.id,
      parentThreadId: f.thread.id,
      workerThreadId: 'private-worker',
      utteranceId: source.id,
      sourceMessageId: source.id,
      sourceText: String(source.content),
      request: String(source.content),
    },
    true,
  );
  await f.suppress(runId, source);
  const intake = vi.fn(async () => ({ reply: 'Hello.', needsTask: false }));
  await f.platform.nativeVoice!.turn({ ...f.turn, intake });
  expect(intake).toHaveBeenCalledOnce();
  expect(JSON.stringify(intake.mock.calls)).not.toContain(secret);
});

it('keeps pending receipts as host status without copying their unprojected captions into intake', async () => {
  const f = await fixture();
  const secret = 'private-pending-417';
  const parentLease = (await f.platform.localConversations!.acquireThread(
    f.thread.id,
  ))!;
  cleanup.push(() => parentLease.release());
  await f.jobs.receiveInput({
    id: 'pending-caption',
    dotId: f.dot.id,
    callId: f.call.id,
    parentThreadId: f.thread.id,
    caption: `Inspect ${secret}.`,
    kind: 'request',
    reply: 'Queued.',
  });
  const intake = vi.fn(async () => ({ reply: 'Hello.', needsTask: false }));
  await f.platform.nativeVoice!.turn({ ...f.turn, intake });
  expect(intake).toHaveBeenCalledOnce();
  expect(JSON.stringify(intake.mock.calls)).not.toContain(secret);
  expect(intake).toHaveBeenCalledWith(
    expect.objectContaining({
      context: expect.objectContaining({
        pending: [{ status: 'received', kind: 'request' }],
      }),
    }),
  );
});

it('does not replay a saved quick reply after its source and reply were forgotten', async () => {
  const f = await fixture();
  const secret = 'private-amber-193';
  const intake = vi.fn(async () => ({
    reply: `The label is ${secret}.`,
    needsTask: false,
  }));
  const turn = {
    ...f.turn,
    understanding: { route: 'chat' as const, text: `Remember ${secret}.` },
    intake,
  };
  await f.platform.nativeVoice!.turn(turn);
  await vi.waitFor(
    async () =>
      expect((await f.jobs.inputReceipt(turn.messageId))?.deliveredAt).toEqual(
        expect.any(Number),
      ),
    { timeout: 3000 },
  );
  const snapshot = await f.platform.localConversations!.getSnapshot(
    f.thread.id,
  );
  for (const message of snapshot.messages.filter(
    (message) =>
      message.id === turn.messageId ||
      message.id === `voice-input:${turn.messageId}`,
  ))
    await f.suppress(snapshot.lastRun!.runId, message);
  f.speak.mockClear();
  const replay = await f.platform.nativeVoice!.turn(turn);
  expect(replay.text).not.toContain(secret);
  expect(replay.text).toMatch(
    /withheld|forgot|context|unavailable|no longer available/i,
  );
  expect(JSON.stringify(f.speak.mock.calls)).not.toContain(secret);
  expect(intake).toHaveBeenCalledOnce();
});

it('mirrors a saved conversational reply after recovery without inference, speech or task replay', async () => {
  const f = await fixture();
  const parentLease = (await f.platform.localConversations!.acquireThread(
    f.thread.id,
  ))!;
  cleanup.push(() => parentLease.release());
  const text = 'I am here and ready to chat.';
  const intake = vi.fn(async () => ({ reply: text, needsTask: false }));
  const turn = { ...f.turn, intake };
  expect((await f.platform.nativeVoice!.turn(turn)).text).toBe(text);
  expect((await f.jobs.inputReceipt(turn.messageId))?.deliveredAt).toBeNull();
  await f.jobs.recover();
  await parentLease.release();
  await vi.waitFor(
    async () =>
      expect((await f.jobs.inputReceipt(turn.messageId))?.deliveredAt).toEqual(
        expect.any(Number),
      ),
    { timeout: 3000 },
  );
  const messages = (
    await f.platform.localConversations!.getSnapshot(f.thread.id)
  ).messages;
  expect(
    messages.filter((m) => m.id === `voice-input:${turn.messageId}`),
  ).toEqual([expect.objectContaining({ content: text })]);
  expect(intake).toHaveBeenCalledOnce();
  expect(f.speak).toHaveBeenCalledOnce();
  expect(await f.jobs.list()).toEqual([]);
});

it('does not mirror a recovered quick reply after its supporting source was forgotten', async () => {
  const f = await fixture();
  const secret = 'private-silver-304';
  const source: Message = {
    id: randomUUID(),
    role: 'user',
    content: `My label is ${secret}.`,
  };
  const runId = await f.save([source]);
  const parentLease = (await f.platform.localConversations!.acquireThread(
    f.thread.id,
  ))!;
  cleanup.push(() => parentLease.release());
  const intake = vi.fn(async () => ({
    reply: `Your label is ${secret}.`,
    needsTask: false,
  }));
  const turn = {
    ...f.turn,
    understanding: { route: 'chat' as const, text: 'What is my label?' },
    intake,
  };
  await f.platform.nativeVoice!.turn(turn);
  expect((await f.jobs.inputReceipt(turn.messageId))?.deliveredAt).toBeNull();
  await f.jobs.recover();
  await f.suppress(runId, source);
  await parentLease.release();
  await vi.waitFor(
    async () =>
      expect((await f.jobs.inputReceipt(turn.messageId))?.deliveredAt).toEqual(
        expect.any(Number),
      ),
    { timeout: 3000 },
  );
  const reply = (
    await f.platform.localConversations!.getSnapshot(f.thread.id)
  ).messages.find((message) => message.id === `voice-input:${turn.messageId}`);
  expect(JSON.stringify(reply ?? null)).not.toContain(secret);
});

it('rechecks a deferred task reply when forgetting races with parent admission', async () => {
  const f = await fixture();
  const secret = 'private-racing-918';
  const source: Message = {
    id: randomUUID(),
    role: 'user',
    content: `My label is ${secret}.`,
  };
  const runId = await f.save([source]);
  const parentLease = (await f.platform.localConversations!.acquireThread(
    f.thread.id,
  ))!;
  cleanup.push(() => parentLease.release());
  const turn = {
    ...f.turn,
    understanding: {
      route: 'chat' as const,
      text: 'Write a file with my label.',
    },
    intake: vi.fn(async () => ({
      reply: `I will write ${secret}.`,
      needsTask: true,
    })),
  };
  await f.platform.nativeVoice!.turn(turn);
  expect((await f.jobs.inputReceipt(turn.messageId))?.deliveredAt).toBeNull();
  const requireThread = f.workspace.requireThread;
  const gate = vi
    .spyOn(f.workspace, 'requireThread')
    .mockImplementationOnce(async (...args) => {
      await f.suppress(runId, source);
      return requireThread(...args);
    });
  await parentLease.release();
  await vi.waitFor(
    async () =>
      expect((await f.jobs.inputReceipt(turn.messageId))?.deliveredAt).toEqual(
        expect.any(Number),
      ),
    { timeout: 3000 },
  );
  gate.mockRestore();
  const reply = (
    await f.platform.localConversations!.getSnapshot(f.thread.id)
  ).messages.find((message) => message.id === `voice-input:${turn.messageId}`);
  expect(JSON.stringify(reply ?? null)).not.toContain(secret);
  expect(await f.jobs.list()).toEqual([
    expect.objectContaining({ sourceText: turn.understanding.text }),
  ]);
});

it('rechecks pending request status when cancellation races with intake', async () => {
  const f = await fixture();
  const parentLease = (await f.platform.localConversations!.acquireThread(
    f.thread.id,
  ))!;
  cleanup.push(() => parentLease.release());
  await f.jobs.receiveInput({
    id: 'pending-request',
    dotId: f.dot.id,
    callId: f.call.id,
    parentThreadId: f.thread.id,
    caption: 'Review my draft.',
    kind: 'request',
    reply: '',
  });
  const reply = await f.platform.nativeVoice!.turn({
    ...f.turn,
    understanding: { route: 'chat', text: 'Is my draft review queued?' },
    intake: async () => {
      await f.jobs.cancelInput('pending-request');
      return {
        reply: 'Your draft review is queued.',
        needsTask: false,
        usesTaskStatus: true,
      };
    },
  });
  expect((await f.jobs.inputReceipt('pending-request'))?.status).toBe(
    'interrupted',
  );
  expect(reply.text).not.toContain('is queued');
  expect(reply.text).toMatch(/stopped|cancelled|canceled/i);
});
