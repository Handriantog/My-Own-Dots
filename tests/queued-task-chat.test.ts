import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from '@ag-ui/client';
import { lastValueFrom, of, toArray } from 'rxjs';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { SQLiteConversations } from '../src/server/storage/sqlite-conversations.js';
import { LocalAgentRunner } from '../src/server/local-runner.js';
import { VoiceDelegationCoordinator } from '../src/server/local-voice/delegation.js';
import { workspaceRoutes } from '../src/server/workspace-routes.js';
import type { Platform } from '../src/server/platform.js';
import type { VoiceService } from '../src/server/voice.js';
import type { VoiceDelegationStatus } from '../src/shared/voice-delegation.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'queued-task-chat-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const ownerId = randomUUID();
  const storage = await StorageClient.open({
    database: join(directory, 'test.sqlite'),
    ownerId,
    engine: 'sqlite',
  });
  cleanup.push(() => storage.close());
  const { workspace, voiceDelegations: jobs } = storage.repositories;
  const dot = (await workspace.dots())[0];
  const conversations = new SQLiteConversations(storage);
  cleanup.push(() => conversations.close());
  await conversations.createThread({
    threadId: 'parent',
    agentId: dot.id,
    userId: ownerId,
  });
  await workspace.bindThread('parent', dot.id, 'Conversation');
  const source = { id: 'source', role: 'user' as const, content: 'Fix login.' };
  const parentLease = (await conversations.acquireThread('parent'))!;
  await parentLease.beginRun(input('parent', 'source-run', [source]));
  await parentLease.finishRun([source], {}, 'finished');
  await parentLease.release();
  const call = await workspace.createCall('parent');
  await jobs.enqueue({
    id: 'job',
    dotId: dot.id,
    callId: call.id,
    parentThreadId: 'parent',
    workerThreadId: 'worker',
    utteranceId: source.id,
    sourceMessageId: source.id,
    sourceText: source.content,
    request: source.content,
  });
  const runner = new LocalAgentRunner(
    conversations,
    undefined,
    undefined,
    new VoiceDelegationCoordinator(jobs, conversations),
  );
  cleanup.push(() => runner.close());
  const routes = workspaceRoutes(
    { workspace, voiceDelegations: jobs } as unknown as Platform,
    {} as VoiceService,
  );
  return { workspace, jobs, dot, conversations, runner, routes };
}

function input(
  threadId: string,
  runId: string,
  messages: RunAgentInput['messages'],
): RunAgentInput {
  return { threadId, runId, messages, state: {}, tools: [], context: [] };
}
class Agent extends AbstractAgent {
  inputs: RunAgentInput[] = [];
  constructor(dotId: string) {
    super({ agentId: dotId });
  }
  run(request: RunAgentInput) {
    this.inputs.push(structuredClone(request));
    const events: BaseEvent[] = [
      {
        type: EventType.RUN_STARTED,
        threadId: request.threadId,
        runId: request.runId,
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: `answer:${request.runId}`,
        role: 'assistant',
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: `answer:${request.runId}`,
        delta: 'Hello.',
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: `answer:${request.runId}`,
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: request.threadId,
        runId: request.runId,
      },
    ];
    return of(...events);
  }
}
const collect = (
  runner: LocalAgentRunner,
  agent: Agent,
  request: RunAgentInput,
) =>
  lastValueFrom(
    runner
      .run({ threadId: request.threadId, agent, input: request })
      .pipe(toArray()),
  );

it('keeps the queued request immutable while resolving fresh owner chat to its parent', async () => {
  const f = await fixture();
  const accepted = await f.jobs.get('job');
  const agent = new Agent(f.dot.id);
  const typed = { id: 'typed', role: 'user' as const, content: 'How are you?' };
  // This is the existing failure: the task view submits an ordinary chat input
  // to an execution-only worker. Its authority check must remain intact.
  const rejected = await collect(
    f.runner,
    agent,
    input('worker', 'wrong-target', [typed]),
  );
  expect(rejected).toContainEqual(
    expect.objectContaining({
      type: EventType.RUN_ERROR,
      message: 'Delegated task request mismatch.',
    }),
  );
  expect(agent.inputs).toHaveLength(0);
  expect((await f.conversations.getSnapshot('worker')).messages).toEqual([]);
  expect(await f.jobs.get('job')).toEqual(accepted);

  const response = await f.routes.request(
    '/conversations/worker/chat-target?parentThreadId=forged',
  );
  expect(response.status).toBe(200);
  const target = await response.json();
  expect(target).toMatchObject({
    threadId: 'parent',
    dotId: f.dot.id,
    taskId: 'job',
  });
  const reply = await collect(
    f.runner,
    agent,
    input(target.threadId, 'typed-chat', [typed]),
  );
  expect(reply.some((event) => event.type === EventType.RUN_ERROR)).toBe(false);
  expect(agent.inputs[0].messages).toContainEqual(typed);
  expect(await f.jobs.get('job')).toEqual(accepted);
  expect((await f.conversations.getSnapshot('worker')).messages).toEqual([]);

  await collect(
    f.runner,
    agent,
    input('worker', 'accepted-task', [
      { id: 'voice-task:job', role: 'user', content: 'Fix login.' },
    ]),
  );
  expect(agent.inputs[1].messages).toEqual([
    { id: 'voice-task:job', role: 'user', content: 'Fix login.' },
  ]);
  expect(await f.jobs.get('job')).toMatchObject({
    status: 'completed',
    request: 'Fix login.',
    leaseGeneration: 1,
  });
});

it.each<VoiceDelegationStatus>([
  'queued',
  'running',
  'approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])(
  'resolves %s task chat without changing task state or acquiring its lease',
  async (status) => {
    const f = await fixture();
    if (status !== 'queued') {
      const lease = (await f.jobs.claim('job', 'task-run', 60000))!;
      if (status !== 'running') await f.jobs.settle(lease, { status });
    }
    const accepted = await f.jobs.get('job');
    const lease = (await f.conversations.acquireThread('worker'))!;
    try {
      const response = await f.routes.request(
        '/conversations/worker/chat-target',
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        threadId: 'parent',
        dotId: f.dot.id,
        taskId: 'job',
      });
      expect(await f.jobs.get('job')).toEqual(accepted);
      expect(await f.conversations.isRunning('worker')).toBe(true);
    } finally {
      await lease.release();
    }
  },
);

it('leaves ordinary chat targeting unchanged and refuses a missing conversation', async () => {
  const f = await fixture();
  const response = await f.routes.request('/conversations/parent/chat-target');
  expect(response.status).toBe(200);
  expect(await response.json()).toBeNull();
  expect(
    (await f.routes.request('/conversations/missing/chat-target')).status,
  ).not.toBe(200);
});

it('refuses an unavailable or differently bound parent rather than selecting a fallback', async () => {
  const f = await fixture();
  // The route still crosses the real worker lookup. A changed binding is the
  // only substituted boundary, representing a stale or corrupted relation.
  for (const mode of ['missing', 'foreign']) {
    const routes = workspaceRoutes(
      {
        workspace: {
          ...f.workspace,
          requireThread: async (id: string, dotId?: string) => {
            if (id === 'parent') {
              if (mode === 'missing') throw Error('Conversation not found.');
              if (dotId !== 'another-dot')
                throw Error('Conversation does not belong to this Dot.');
            }
            return f.workspace.requireThread(id, dotId);
          },
        },
        voiceDelegations: f.jobs,
      } as unknown as Platform,
      {} as VoiceService,
    );
    expect(
      (await routes.request('/conversations/worker/chat-target')).status,
    ).not.toBe(200);
  }
});
