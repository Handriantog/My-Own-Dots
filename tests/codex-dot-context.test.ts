import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type Message } from '@ag-ui/client';
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
async function fixture(sourceText = 'Find the label') {
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
    content: sourceText,
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
  const complete = async (messages: Message[] = [answer]) => {
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
      messages,
    });
    await worker.finishRun(messages, {}, 'finished');
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

async function enqueueContextTurn(
  f: Awaited<ReturnType<typeof fixture>>,
  text: string,
  answer?: string,
) {
  const user = { id: randomUUID(), role: 'user' as const, content: text };
  const parent = (await f.platform.localConversations!.getSnapshot(f.parent.id))
    .messages;
  const messages = [...parent, user];
  const lease = (await f.platform.localConversations!.acquireThread(
    f.parent.id,
  ))!;
  await lease.beginRun(
    {
      threadId: f.parent.id,
      runId: randomUUID(),
      messages,
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    },
    f.guard,
  );
  await lease.finishRun(messages, {}, 'finished');
  await lease.release();
  const id = randomUUID();
  const queued = await f.jobs.enqueue(
    {
      id,
      dotId: f.dot.id,
      callId: f.call.id,
      parentThreadId: f.parent.id,
      workerThreadId: `worker-${id}`,
      utteranceId: user.id,
      sourceMessageId: user.id,
      sourceText: text,
      request: text,
    },
    true,
  );
  if (answer !== undefined) {
    const runId = randomUUID();
    const jobLease = (await f.jobs.claim(id, runId, 60000))!;
    const worker = (await f.platform.localConversations!.acquireThread(
      queued.job.workerThreadId,
    ))!;
    const replies: Message[] = [
      { id: `voice-task:${id}`, role: 'user', content: text },
      { id: randomUUID(), role: 'assistant', content: answer },
    ];
    await worker.beginRun(
      {
        threadId: queued.job.workerThreadId,
        runId,
        messages: replies,
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      },
      f.guard,
    );
    await worker.finishRun(replies, {}, 'finished');
    await worker.release();
    await f.jobs.settle(jobLease, { status: 'completed', result: answer });
  }
  return queued.job;
}

it('keeps tool-backed task requests and outcomes across chatter without future input or raw tool payloads', async () => {
  const f = await fixture('Write the Cedar README.');
  await f.complete([
    { id: 'voice-task:task', role: 'user', content: 'Write the Cedar README.' },
    {
      id: 'write-action',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'write-call',
          type: 'function',
          function: {
            name: 'inspect_note',
            arguments: '{"content":"tool argument secret"}',
          },
        },
      ],
    },
    {
      id: 'write-result',
      role: 'tool',
      toolCallId: 'write-call',
      content: '{"private":"tool result secret"}',
    },
    {
      id: 'write-answer',
      role: 'assistant',
      content: 'Created Cedar/README.md and checked its contents.',
    },
  ]);
  for (let i = 0; i < 15; i++)
    await enqueueContextTurn(f, `Small talk ${i}`, `Casual reply ${i}`);
  const current = await enqueueContextTurn(f, 'How is it going?');
  await enqueueContextTurn(
    f,
    'Future queued request private text',
    'Future completed result private text',
  );
  provider.run.mockResolvedValue({
    status: 'completed',
    text: 'The README is ready.',
    evidence: [],
  });
  provider.create.mockReturnValue({
    warm: async () => ({ version: 'fixture', nativeExecution: false }),
    run: provider.run,
    interrupt: async () => {},
    close: async () => {},
  });
  await lastValueFrom(
    f.platform['localRunner']!.run({
      threadId: current.workerThreadId,
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
      input: {
        threadId: current.workerThreadId,
        runId: randomUUID(),
        messages: [
          {
            id: `voice-task:${current.id}`,
            role: 'user',
            content: current.request,
          },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    }).pipe(toArray()),
  );
  const instructions: string =
    provider.create.mock.calls.at(-1)![0].instructions;
  expect(instructions).toContain('Write the Cedar README.');
  expect(instructions).toContain(
    'Created Cedar/README.md and checked its contents.',
  );
  expect(instructions).not.toContain('Future queued request private text');
  expect(instructions).not.toContain('Future completed result private text');
  expect(instructions).not.toContain('tool argument secret');
  expect(instructions).not.toContain('tool result secret');
  expect(provider.run.mock.calls.at(-1)![0].input).toContain(
    'How is it going?',
  );
});
it.each(['available', 'trashed', 'forgotten', 'revoked'])(
  'supplies authorized task context at execution admission (%s)',
  async (access) => {
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
      const page = await f.workspace.pages.create(f.dot.spaceId, {
        title: 'Task evidence',
        content: 'amber fox',
      });
      Object.assign(f.guard, { spaceIds: [f.dot.spaceId], pageIds: [page.id] });
      await f.complete();
      if (access === 'trashed') await f.workspace.deleteConversation('worker');
      if (access === 'revoked')
        await f.workspace.pages.delete(f.dot.spaceId, page.id);
      if (access === 'forgotten')
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
      release();
      await held;
      await typed;
      expect(
        provider.create.mock.calls
          .at(-1)![0]
          .instructions.includes('The label is amber fox.'),
      ).toBe(access === 'available');
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
it('speaks with a valid task replacement despite a revoked parent, then suppresses revoked task speech', async () => {
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
  await f.workspace.folders.revoke(f.dot.id, decision.grantId!);
  const replacement = await f.workspace.folders.request(
    f.dot.id,
    'worker',
    { reason: 'Replacement project', folderHint: f.root, access: 'execute' },
    f.parent.id,
  );
  const selectedReplacement = await f.workspace.folders.select(
    'worker',
    replacement.id,
    f.root,
  );
  const approvedReplacement = await f.workspace.folders.decide(
    'worker',
    replacement.id,
    {
      approve: true,
      access: 'execute',
      selectionId: selectedReplacement.id,
      toolCallId: 'replacement',
    },
  );
  const valid = await f.platform.nativeVoice!.receiptValidator(job);
  expect(await valid()).toBe(true);
  await f.workspace.folders.revoke(f.dot.id, approvedReplacement.grantId!);
  expect(await valid()).toBe(false);
  const canonical = await f.platform
    .nativeVoice!.receiptValidator({
      ...job,
      leaseGeneration: job.leaseGeneration + 1,
    })
    .catch(() => async () => false);
  expect(await canonical()).toBe(false);
});

it('snapshots a delegated project so another folder approval cannot redirect or interrupt it', async () => {
  const f = await fixture();
  await f.complete();
  const approve = async (threadId: string, path: string) => {
    const request = await f.workspace.folders.request(
      f.dot.id,
      threadId,
      { reason: 'Inspect project', folderHint: path, access: 'execute' },
      f.parent.id,
    );
    const selected = await f.workspace.folders.select(
      threadId,
      request.id,
      path,
    );
    return f.workspace.folders.decide(threadId, request.id, {
      toolCallId: randomUUID(),
      approve: true,
      access: 'execute',
      selectionId: selected.id,
    });
  };
  await approve(f.parent.id, f.root);
  let finish!: () => void;
  const interrupt = vi.fn(async () => {});
  provider.run.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            status: 'completed',
            text: 'Inspected the project.',
            evidence: [],
          });
      }),
  );
  provider.create.mockReturnValue({
    warm: async () => ({ version: 'fixture', nativeExecution: true }),
    run: provider.run,
    interrupt,
    close: async () => {},
  });
  await f.platform.nativeVoice!.turn({
    callId: f.call.id,
    dotId: f.dot.id,
    threadId: f.parent.id,
    messageId: randomUUID(),
    audio: Buffer.alloc(4),
    understanding: { route: 'chat', text: 'Inspect my current project' },
    native: {
      warm: async () => {},
      close: async () => {},
      interpret: vi.fn(),
      respond: vi.fn(),
      speak: vi.fn(),
    },
    signal: new AbortController().signal,
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'), {
    timeout: 4000,
  });
  const job = (await f.jobs.list({ parentThreadId: f.parent.id })).find(
    (j) => j.status === 'running',
  )!;
  try {
    expect(provider.create.mock.calls.at(-1)![0].scope.cwd).toBe(
      await realpath(f.root),
    );
    const other = await f.platform.createConversation(
      f.dot.id,
      'Pending unrelated project',
    );
    const replacement = join(f.root, 'Project Maple');
    await mkdir(replacement);
    await approve(other.id, replacement);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(interrupt).not.toHaveBeenCalled();
    expect(
      await f.workspace.folders.executionScope(f.dot.id, job.workerThreadId),
    ).toMatchObject({ path: await realpath(f.root) });
    expect(
      await f.workspace.folders.executionScope(f.dot.id, other.id),
    ).toMatchObject({ path: await realpath(replacement) });
  } finally {
    finish();
  }
  await vi.waitFor(async () =>
    expect(await f.jobs.get(job.id)).toMatchObject({ status: 'completed' }),
  );
});
