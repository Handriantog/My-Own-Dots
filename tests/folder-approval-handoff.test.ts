import { randomUUID } from 'node:crypto';
import type { RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { folderApprovalTool } from '../src/shared/folder-access.js';
import { replayRun } from '../src/server/local-conversations.js';
import { pageReviewTool } from '../src/shared/page-review.js';

const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanups.push(
    () => store.close(),
    () => workspace.close(),
  );
  const dot = workspace.dots()[0];
  const threadId = randomUUID();
  workspace.bindThread(threadId, dot.id, 'Folder request');
  const agent = new DotAgent(
    store,
    workspace,
    {
      conversationBackend: 'local',
      localDatabaseUrl: 'postgres://unused',
      llmBackend: 'subscription',
      llmProvider: 'codex',
      baseUrl: '',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      webSearchProvider: 'disabled',
    },
    dot.id,
  );
  engine.runAgent
    .mockReset()
    .mockRejectedValue(new Error('Unnecessary provider round trip'));
  const input: RunAgentInput = {
    threadId,
    runId: randomUUID(),
    messages: [
      {
        id: randomUUID(),
        role: 'user' as const,
        content: 'Read my project folder.',
      },
    ],
    context: [],
    state: {},
    tools: [folderApprovalTool],
    forwardedProps: {},
  };
  const requestDecision = (count = 1) => ({
    result: {
      text: '',
      toolCalls: Array.from({ length: count }, (_, i) => ({
        name: 'request_local_folder_access',
        argumentsJson: JSON.stringify({
          reason: 'Read the requested project',
          folderHint: `Project ${i}`,
          access: 'read',
        }),
      })),
    },
    usage: {},
  });
  return { workspace, dot, agent, input, requestDecision };
}

it.each([1, 2])(
  'surfaces %i saved folder request(s) without a follow-up model call or granting access',
  async (count) => {
    const f = fixture();
    engine.runAgent.mockResolvedValueOnce(f.requestDecision(count));
    const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(events.filter((e) => e.type === 'RUN_ERROR')).toEqual([]);
    const reviews = events.filter(
      (e) =>
        e.type === 'TOOL_CALL_START' &&
        e.toolCallName === folderApprovalTool.name,
    );
    expect(reviews).toHaveLength(count);
    for (const review of reviews) {
      const args = events.find(
        (e) =>
          e.type === 'TOOL_CALL_ARGS' && e.toolCallId === review.toolCallId,
      );
      const { requestId } = JSON.parse(args!.delta as string);
      expect(
        f.workspace.folders.getRequest(f.input.threadId, requestId).request,
      ).toMatchObject({
        dotId: f.dot.id,
        status: 'pending',
        requestedAccess: 'read',
      });
      expect(events).toContainEqual({
        type: 'TOOL_CALL_END',
        toolCallId: review.toolCallId,
      });
    }
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    expect(f.workspace.folders.list(f.dot.id)).toEqual([]);
    expect(engine.runAgent).toHaveBeenCalledOnce();
  },
);

it('does not show a review when saving the request fails', async () => {
  const f = fixture();
  engine.runAgent
    .mockResolvedValueOnce(f.requestDecision())
    .mockResolvedValueOnce({
      result: { text: 'Could not request access.', toolCalls: [] },
      usage: {},
    });
  vi.spyOn(f.workspace.folders, 'request').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(
    events.some(
      (e) =>
        e.type === 'TOOL_CALL_START' &&
        e.toolCallName === folderApprovalTool.name,
    ),
  ).toBe(false);
  expect(f.workspace.folders.list(f.dot.id)).toEqual([]);
});

it.each([false, true])(
  'keeps approval continuation valid with mixed page review: %s',
  async (mixed) => {
    const f = fixture();
    const first = f.requestDecision(2);
    if (mixed) {
      f.input.tools.push(pageReviewTool);
      first.result.toolCalls.push({
        name: pageReviewTool.name,
        argumentsJson: JSON.stringify({
          title: 'Notes',
          content: 'Draft',
          spaceId: f.dot.spaceId,
        }),
      });
    }
    engine.runAgent.mockResolvedValueOnce(first);
    const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    const replayed = await replayRun(f.input, events);
    const reviews = replayed.messages.filter(
      (message) =>
        message.role === 'assistant' &&
        message.toolCalls?.some(
          (call) => call.function.name === folderApprovalTool.name,
        ),
    );
    // Chat Completions requires all tool results before the next assistant.
    // Separate review assistants followed by both results would be invalid.
    expect(reviews).toHaveLength(1);
    const calls =
      reviews[0].role === 'assistant'
        ? reviews[0].toolCalls!.filter(
            (call) => call.function.name === folderApprovalTool.name,
          )
        : [];
    expect(calls).toHaveLength(2);
    const decisions = await Promise.all(
      calls.map(async (call) => ({
        id: randomUUID(),
        role: 'tool' as const,
        toolCallId: call.id,
        content: JSON.stringify(
          await f.workspace.folders.decide(
            f.input.threadId,
            JSON.parse(call.function.arguments).requestId,
            { toolCallId: call.id, approve: false },
          ),
        ),
      })),
    );
    expect(
      decisions.map((decision) => JSON.parse(decision.content).approved),
    ).toEqual([false, false]);
    for (const message of replayed.messages) {
      if (message.role !== 'assistant') continue;
      for (const call of message.toolCalls ?? []) {
        if (call.function.name === pageReviewTool.name)
          decisions.push({
            id: randomUUID(),
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify({ approved: false }),
          });
      }
    }
    const messages = [...replayed.messages, ...decisions];
    const pending = new Set<string>();
    for (const message of messages) {
      if (message.role === 'tool') {
        expect(pending.delete(message.toolCallId)).toBe(true);
      } else {
        expect([...pending]).toEqual([]);
        if (message.role === 'assistant')
          for (const call of message.toolCalls ?? []) pending.add(call.id);
      }
    }
    expect([...pending]).toEqual([]);
    engine.runAgent.mockResolvedValueOnce({
      result: { text: 'The folders remain inaccessible.', toolCalls: [] },
      usage: {},
    });
    const continued = await lastValueFrom(
      f.agent
        .run({ ...f.input, runId: randomUUID(), messages })
        .pipe(toArray()),
    );
    expect(continued.filter((e) => e.type === 'RUN_ERROR')).toEqual([]);
    expect(continued.at(-1)?.type).toBe('RUN_FINISHED');
    expect(f.workspace.folders.list(f.dot.id)).toEqual([]);
    expect(engine.runAgent).toHaveBeenCalledTimes(2);
  },
);

it('does not show a saved request after the run is cancelled', async () => {
  const f = fixture();
  engine.runAgent.mockResolvedValueOnce(f.requestDecision());
  const save = f.workspace.folders.request.bind(f.workspace.folders);
  vi.spyOn(f.workspace.folders, 'request').mockImplementation((...args) => {
    const request = save(...args);
    f.agent.abortRun();
    return request;
  });
  const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(
    events.some(
      (e) =>
        e.type === 'TOOL_CALL_START' &&
        e.toolCallName === folderApprovalTool.name,
    ),
  ).toBe(false);
  expect(f.workspace.folders.list(f.dot.id)).toEqual([]);
});
