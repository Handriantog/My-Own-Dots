import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { lastValueFrom, toArray } from 'rxjs';
import { expect, it, vi } from 'vitest';
import { DotAgent } from '../src/server/dot-agent';
import { Store } from '../src/server/store';
import { WorkspaceStore } from '../src/server/workspace';
import { folderApprovalTool } from '../src/shared/folder-access';
import { canonicalVoiceAnswer } from '../src/server/local-voice/live';
import type { ConversationSnapshot } from '../src/server/local-conversations';
const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
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
  const user = {
    id: 'owner-message',
    role: 'user' as const,
    content: 'Read my work notes.',
  };
  const input = {
    threadId,
    runId: randomUUID(),
    messages: [user],
    context: [],
    state: {},
    tools: [folderApprovalTool],
    forwardedProps: {},
  };
  engine.runAgent.mockReset();
  return {
    store,
    workspace,
    dot,
    agent,
    input,
    user,
    close() {
      workspace.close();
      store.close();
    },
  };
}
const reply = (text: string, name?: string, args?: unknown) => ({
  result: {
    text,
    toolCalls: name ? [{ name, argumentsJson: JSON.stringify(args) }] : [],
  },
  usage: {},
});

it('requests approval without access, then resumes the governed turn using only the approved folder', async () => {
  const f = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'dots-folder-agent-'));
  try {
    await writeFile(join(directory, 'notes.txt'), 'Fixture work notes');
    const prepared = vi.spyOn(f.workspace.folders, 'request');
    const read = vi.spyOn(f.workspace.folders, 'readFile');
    engine.runAgent
      .mockResolvedValueOnce(
        reply('', 'request_local_folder_access', {
          reason: 'Read work notes',
          folderHint: 'Work',
          access: 'read',
        }),
      )
      .mockImplementationOnce(async () =>
        reply('', folderApprovalTool.name, {
          requestId: prepared.mock.results[0].value.id,
        }),
      );
    const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(events.some((event) => event.type === 'RUN_ERROR')).toBe(false);
    const call = events.find(
      (event) =>
        'toolCallName' in event &&
        event.toolCallName === folderApprovalTool.name,
    ) as unknown as { toolCallId: string };
    expect(call?.toolCallId).toBeTruthy();
    expect(f.workspace.folders.list(f.dot.id)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    const requestId = prepared.mock.results[0].value.id;
    const selection = await f.workspace.folders.select(
      f.input.threadId,
      requestId,
      directory,
    );
    expect(f.workspace.folders.list(f.dot.id)).toEqual([]);
    const decision = await f.workspace.folders.decide(
      f.input.threadId,
      requestId,
      {
        toolCallId: call.toolCallId,
        approve: true,
        selectionId: selection.id,
        access: 'read',
      },
    );
    expect(decision.approved).toBe(true);
    engine.runAgent
      .mockReset()
      .mockResolvedValueOnce(
        reply('', 'read_local_file', {
          grantId: decision.grantId,
          path: 'notes.txt',
        }),
      )
      .mockResolvedValueOnce(reply('Your notes say: Fixture work notes.'));
    const pending = {
      id: 'folder-review',
      role: 'assistant' as const,
      content: '',
      toolCalls: [
        {
          id: call.toolCallId,
          type: 'function' as const,
          function: {
            name: folderApprovalTool.name,
            arguments: JSON.stringify({ requestId }),
          },
        },
      ],
    };
    const toolResult = {
      id: 'owner-decision',
      role: 'tool' as const,
      toolCallId: call.toolCallId,
      content: JSON.stringify(decision),
    };
    const resumed = await lastValueFrom(
      f.agent
        .run({
          ...f.input,
          runId: randomUUID(),
          messages: [f.user, pending, toolResult],
        })
        .pipe(toArray()),
    );
    expect(resumed.some((event) => event.type === 'RUN_ERROR')).toBe(false);
    expect(read).toHaveBeenCalledWith(
      f.dot.id,
      decision.grantId,
      'notes.txt',
      expect.any(AbortSignal),
    );
    expect(engine.runAgent.mock.calls.at(-1)?.[0].prompt).toContain(
      'Fixture work notes',
    );
    expect(
      resumed.some(
        (event) =>
          'delta' in event &&
          String(event.delta).includes('Fixture work notes'),
      ),
    ).toBe(true);
    const snapshot = (messages: unknown[]) =>
      ({
        messages,
        lastRun: { status: 'finished', input: { messages: [f.user] } },
      }) as ConversationSnapshot;
    expect(
      canonicalVoiceAnswer(snapshot([f.user, pending]), {
        messageId: f.user.id,
        text: f.user.content,
      }).state,
    ).toBe('approval');
    expect(
      canonicalVoiceAnswer(
        snapshot([
          f.user,
          pending,
          toolResult,
          { id: 'answer', role: 'assistant', content: 'Your notes are ready.' },
        ]),
        { messageId: f.user.id, text: f.user.content },
      ),
    ).toEqual({ state: 'ready', text: 'Your notes are ready.' });
  } finally {
    f.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not advertise local-folder tools when the client cannot present folder approval', async () => {
  const f = fixture();
  try {
    engine.runAgent.mockResolvedValue(
      reply('Open the desktop companion to choose a folder.'),
    );
    await lastValueFrom(f.agent.run({ ...f.input, tools: [] }).pipe(toArray()));
    const names =
      engine.runAgent.mock.calls[0][0].schema.properties.toolCalls.items
        .properties.name.enum;
    expect(names).not.toContain('request_local_folder_access');
    expect(names).not.toContain('read_local_file');
    expect(names).not.toContain(folderApprovalTool.name);
  } finally {
    f.close();
  }
});
