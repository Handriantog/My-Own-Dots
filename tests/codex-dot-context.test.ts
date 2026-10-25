import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EventType } from '@ag-ui/client';
import { lastValueFrom, toArray } from 'rxjs';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { Platform } from '../src/server/platform.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { codexCoordinator } from '../src/server/codex-runtime.js';
import { evidenceHash } from '../src/server/conversation-memory.js';
const provider = vi.hoisted(() => ({ create: vi.fn(), run: vi.fn() }));
vi.mock('myown-llm-integrator', async (original) => ({
  ...(await original<object>()),
  createExecutionSession: provider.create,
}));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dot-context-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const storage = await StorageClient.open({
    database: join(root, 'workspace.sqlite'),
    ownerId: randomUUID(),
    engine: 'sqlite',
  });
  cleanup.push(() => storage.close());
  const { workspace, store, voiceDelegations: jobs } = storage.repositories;
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
  const parent = await platform.createConversation(dot.id, 'Fixture');
  const call = await workspace.createCall(parent.id);
  const lease = (await platform.localConversations!.acquireThread(parent.id))!;
  const user = {
    id: 'voice-caption',
    role: 'user' as const,
    content: 'Find the label',
  };
  await lease.beginRun(
    {
      threadId: parent.id,
      runId: 'caption',
      messages: [user],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    },
    { originDotId: dot.id, pageIds: [], spaceIds: [] },
  );
  await lease.finishRun([user], {}, 'finished');
  await lease.release();
  const queued = await jobs.enqueue(
    {
      id: 'task',
      dotId: dot.id,
      callId: call.id,
      parentThreadId: parent.id,
      workerThreadId: 'worker',
      utteranceId: user.id,
      sourceMessageId: user.id,
      sourceText: user.content,
      request: user.content,
    },
    true,
  );
  const jobLease = (await jobs.claim(queued.job.id, 'worker-run', 60000))!;
  const answer = {
    id: 'worker-answer',
    role: 'assistant' as const,
    content: 'The label is amber fox.',
  };
  const guard = { originDotId: dot.id, pageIds: [], spaceIds: [] };
  const complete = async () => {
    const worker =
      (await platform.localConversations!.acquireThread('worker'))!;
    await worker.beginRun(
      {
        threadId: 'worker',
        runId: 'worker-run',
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      guard,
    );
    await worker.appendEvent({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [answer],
    });
    await worker.finishRun([answer], {}, 'finished');
    await worker.release();
    return jobs.settle(jobLease, {
      status: 'completed',
      result: answer.content,
    });
  };
  return {
    root,
    storage,
    workspace,
    store,
    platform,
    jobs,
    dot,
    parent,
    call,
    answer,
    guard,
    complete,
  };
}
it.each([false, true])(
  'supplies authorized task context at execution admission (trashed: %s)',
  async (trashed) => {
    const f = await fixture();
    provider.run.mockResolvedValue({
      status: 'completed',
      text: 'amber fox',
      evidence: [],
    });
    provider.create.mockReturnValue({
      warm: async () => ({ version: 'fixture', nativeExecution: false }),
      run: provider.run,
      interrupt: async () => {},
      close: async () => {},
    });
    let release!: () => void;
    const held = codexCoordinator(f.workspace).run(
      f.dot.id,
      'worker-run',
      new AbortController().signal,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      'worker',
    );
    const input = {
      threadId: f.parent.id,
      runId: randomUUID(),
      messages: [
        {
          id: randomUUID(),
          role: 'user' as const,
          content: 'What was the label you found?',
        },
      ],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    const typed = lastValueFrom(
      f.platform['localRunner']!.run({
        threadId: f.parent.id,
        agent: new DotAgent(
          f.store,
          f.workspace,
          f.platform.config,
          f.dot.id,
          false,
          undefined,
          f.platform.memory,
          f.jobs,
        ),
        input,
      }).pipe(toArray()),
    );
    try {
      await vi.waitFor(() =>
        expect(codexCoordinator(f.workspace).status(f.dot.id).queued).toBe(1),
      );
      await f.complete();
      if (trashed) await f.workspace.deleteConversation('worker');
      release();
      await held;
      await typed;
      expect(
        provider.create.mock.calls
          .at(-1)![0]
          .instructions.includes('The label is amber fox.'),
      ).toBe(!trashed);
      expect(provider.run.mock.calls.at(-1)![0].input).toContain(
        'What was the label you found?',
      );
    } finally {
      release?.();
      await held;
      await typed;
    }
  },
);
it('invalidates a queued speech receipt when its canonical source is forgotten', async () => {
  const f = await fixture();
  const job = await f.complete();
  const valid = await f.platform.nativeVoice!.receiptValidator(job);
  expect(await valid()).toBe(true);
  await f.workspace.memory.history.suppress(
    [
      {
        threadId: 'worker',
        runId: 'worker-run',
        messageIds: [f.answer.id],
        contentHash: evidenceHash(f.answer),
        guard: f.guard,
      },
    ],
    'fixture',
  );
  expect(await valid()).toBe(false);
});
it('invalidates queued speech when execution access is revoked or its canonical job changes', async () => {
  const f = await fixture();
  const job = await f.complete();
  const request = await f.workspace.folders.request(f.dot.id, f.parent.id, {
    reason: 'Fixture',
    folderHint: f.root,
    access: 'execute',
  });
  const selected = await f.workspace.folders.select(
    f.parent.id,
    request.id,
    f.root,
  );
  const decision = await f.workspace.folders.decide(f.parent.id, request.id, {
    approve: true,
    access: 'execute',
    selectionId: selected.id,
    toolCallId: 'approved',
  });
  const valid = await f.platform.nativeVoice!.receiptValidator(job);
  expect(await valid()).toBe(true);
  await f.workspace.folders.revoke(f.dot.id, decision.grantId!);
  expect(await valid()).toBe(false);
  const canonical = await f.platform
    .nativeVoice!.receiptValidator({
      ...job,
      leaseGeneration: job.leaseGeneration + 1,
    })
    .catch(() => async () => false);
  expect(await canonical()).toBe(false);
});
