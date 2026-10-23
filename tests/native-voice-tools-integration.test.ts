import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { delegatedApprovalTools } from '../src/server/local-voice/delegation.js';
import { voiceJobReceipt } from '../src/server/local-voice/native-runtime.js';
import type { NativeVoiceSession } from '../src/server/local-voice/native-contract.js';
import type { FolderApprovalPending } from '../src/shared/folder-access.js';
import type { VoiceDelegation } from '../src/shared/voice-delegation.js';

const python = resolve(
  'node_modules/myown-llm-integrator/python/.venv/bin/python',
);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.skipIf(!existsSync(python))(
  'uses chat folder approval and tools for High voice, returns the result, and reuses permission with follow-up context',
  async () => {
    vi.stubEnv('MYOWN_LLM_PYTHON', python);
    vi.stubEnv('CODEX_BIN', '/nonexistent/forbidden-live-provider');
    vi.stubEnv(
      'AGENT_COMMAND_JSON',
      JSON.stringify([
        process.execPath,
        resolve('tests/fixtures/subscription-provider.mjs'),
      ]),
    );
    const root = await mkdtemp(join(tmpdir(), 'dots-native-tools-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    vi.stubEnv('AGENT_LOCK_PATH', join(root, 'provider.lock'));
    const folder = join(root, 'Test Notes');
    await mkdir(folder);
    const firstContent = `The project code is ${randomUUID()}.`;
    await writeFile(join(folder, 'notes.txt'), firstContent);
    const storage = await StorageClient.open({
      database: join(root, 'workspace.sqlite'),
      ownerId: randomUUID(),
      engine: 'sqlite',
    });
    cleanup.push(() => storage.close());
    const { store, workspace, voiceDelegations: jobs } = storage.repositories;
    const config = { mode: 'sample' as const, baseUrl: 'http://localhost' };
    const platform = await Platform.create(
      store,
      workspace,
      {
        conversationBackend: 'local',
        llmBackend: 'subscription',
        llmProvider: 'claude-code',
        baseUrl: config.baseUrl,
        runtimeUrl: 'http://localhost/api/copilotkit',
        voiceName: 'marin',
        slackUsers: [],
        webSearchProvider: 'disabled',
        workspaceId: randomUUID(),
      },
      { storage },
    );
    cleanup.push(() => platform.stop());
    await platform.start();
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      platform,
      ownerToken: 'fixture-owner-token',
    });
    const headers = { Authorization: 'Bearer fixture-owner-token' };
    const post = (body: unknown) => ({
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const dot = (await workspace.dots())[0];
    const parent = await platform.createConversation(dot.id, 'Fixture voice');
    const call = await workspace.createCall(parent.id);
    const native: NativeVoiceSession = {
      warm: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      interpret: vi.fn(),
      respond: vi.fn(async () => {
        throw Error('Tool requests must not use local small talk.');
      }),
      speak: vi.fn(async (text) => ({ text, pcm: Buffer.alloc(4) })),
    };
    const updates: VoiceDelegation[] = [];
    const unsubscribe = platform.nativeVoice!.listen((job) =>
      updates.push(job),
    );
    cleanup.push(async () => unsubscribe());
    const requested = vi.spyOn(workspace.folders, 'request');
    const read = vi.spyOn(workspace.folders, 'readFile');
    const parentContext = vi.spyOn(jobs, 'threadContext');
    const pageScope = vi.spyOn(workspace.pages, 'forThread');
    const abilityExposure = vi.spyOn(platform.abilities!, 'tools');
    const turn = (text: string) =>
      platform.nativeVoice!.turn({
        callId: call.id,
        dotId: dot.id,
        threadId: parent.id,
        messageId: randomUUID(),
        audio: Buffer.alloc(4),
        understanding: {
          route: 'delegate',
          text,
          tool: { name: 'delegate_task', arguments: { request: text } },
        },
        native,
        signal: new AbortController().signal,
      });
    const feed = async (): Promise<FolderApprovalPending[]> => {
      const response = await app.request('/api/folder-approvals', { headers });
      expect(response.status).toBe(200);
      return response.json();
    };
    const firstText =
      'voice-tools-fixture: Read notes.txt in the Test Notes folder.';
    await turn(firstText);
    await vi.waitFor(
      async () => {
        expect(await jobs.list({ parentThreadId: parent.id })).toEqual([
          expect.objectContaining({ status: 'approval', request: firstText }),
        ]);
        expect(await feed()).toHaveLength(1);
      },
      { timeout: 10000 },
    );
    const [firstJob] = await jobs.list({ parentThreadId: parent.id });
    const [pending] = await feed();
    expect(pending).toMatchObject({
      dotId: dot.id,
      threadId: firstJob.workerThreadId,
    });
    expect(await workspace.folders.list(dot.id)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    const path = `/api/conversations/${pending.threadId}/folder-requests/${pending.requestId}`;
    const selected = await app.request(
      `${path}/selection`,
      post({ path: folder }),
    );
    expect(selected.status).toBe(200);
    const selection = await selected.json();
    expect(await workspace.folders.list(dot.id)).toEqual([]);
    const approved = await app.request(
      `${path}/decision`,
      post({
        toolCallId: pending.toolCallId,
        approve: true,
        selectionId: selection.id,
        access: 'read',
      }),
    );
    expect(approved.status).toBe(200);
    const decision = await approved.json();
    expect(decision).toMatchObject({ approved: true, access: 'read' });
    const snapshot = await platform.localConversations!.getSnapshot(
      pending.threadId,
    );
    // This is the same governed runtime continuation sent by the approval UI.
    const continued = await app.request(
      `/api/copilotkit/agent/${dot.id}/run`,
      post({
        threadId: pending.threadId,
        runId: randomUUID(),
        messages: [
          ...snapshot.messages,
          {
            id: randomUUID(),
            role: 'tool',
            toolCallId: pending.toolCallId,
            content: JSON.stringify(decision),
          },
        ],
        state: snapshot.state,
        tools: delegatedApprovalTools,
        context: [],
        forwardedProps: {},
      }),
    );
    expect(continued.status).toBe(200);
    const stream = await continued.text();
    expect(stream).not.toContain('RUN_ERROR');
    await vi.waitFor(
      async () => {
        expect(await jobs.get(firstJob.id)).toMatchObject({
          status: 'completed',
          result: expect.stringContaining(firstContent),
          deliveredAt: expect.any(Number),
        });
        expect(updates).toContainEqual(
          expect.objectContaining({
            id: firstJob.id,
            status: 'completed',
            result: expect.stringContaining(firstContent),
          }),
        );
      },
      { timeout: 10000 },
    );
    expect(read).toHaveBeenCalledWith(
      dot.id,
      decision.grantId,
      'notes.txt',
      expect.any(AbortSignal),
    );
    // Canonical storage places tool results after the assistant's combined answer.
    // The receipt must still select that answer from this completed run.
    const completed = await platform.localConversations!.getSnapshot(
      firstJob.workerThreadId,
    );
    expect(completed.messages.at(-1)?.role).toBe('tool');
    const parentResult = await platform.localConversations!.getSnapshot(
      parent.id,
    );
    expect(parentResult.messages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining(firstContent),
      }),
    );
    expect(voiceJobReceipt((await jobs.get(firstJob.id))!).spoken).toContain(
      firstContent,
    );
    expect(await feed()).toEqual([]);

    // A fresh task must actually read again, retaining the grant and parent context.
    const secondContent = `The revised project code is ${randomUUID()}.`;
    await writeFile(join(folder, 'notes.txt'), secondContent);
    await turn(
      'voice-tools-fixture: Do you have access to that folder now? Read the notes again.',
    );
    await vi.waitFor(
      async () => {
        const latest = (await jobs.list({ parentThreadId: parent.id })).find(
          (job) => job.id !== firstJob.id,
        );
        expect(latest).toMatchObject({
          status: 'completed',
          result: expect.stringContaining(secondContent),
          deliveredAt: expect.any(Number),
        });
        expect(latest?.result).toContain('Prior folder context received.');
      },
      { timeout: 10000 },
    );
    expect(requested).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
    expect(await workspace.folders.list(dot.id)).toHaveLength(1);
    expect(await feed()).toEqual([]);
    expect(native.respond).not.toHaveBeenCalled();
    expect(
      (await platform.localConversations!.getSnapshot(parent.id)).messages,
    ).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining(secondContent),
      }),
    );

    // A completed worker becomes an ordinary chat, without extending the old
    // voice job's scope, changing its receipt, or treating typed input as voice.
    expect(parentContext).toHaveBeenCalledWith(parent.id, dot.id);
    expect(abilityExposure.mock.calls.length).toBeGreaterThan(0);
    expect(
      abilityExposure.mock.calls.every(([, mode]) => mode === 'voice'),
    ).toBe(true);
    const savedJob = await jobs.get(firstJob.id);
    const savedParent = await platform.localConversations!.getSnapshot(
      parent.id,
    );
    const savedWorker = await platform.localConversations!.getSnapshot(
      firstJob.workerThreadId,
    );
    parentContext.mockClear();
    pageScope.mockClear();
    abilityExposure.mockClear();
    await new DotAgent(
      store,
      workspace,
      platform.config,
      dot.id,
      false,
      undefined,
      undefined,
      jobs,
    ).evidenceGuard(firstJob.workerThreadId);
    expect(pageScope).toHaveBeenCalledWith(firstJob.workerThreadId);
    expect(pageScope).not.toHaveBeenCalledWith(parent.id);

    const followupRunId = randomUUID();
    const followup = await app.request(
      `/api/copilotkit/agent/${dot.id}/run`,
      post({
        threadId: firstJob.workerThreadId,
        runId: followupRunId,
        messages: [
          ...savedWorker.messages,
          { id: randomUUID(), role: 'user', content: 'Hello from this chat.' },
        ],
        state: savedWorker.state,
        tools: delegatedApprovalTools,
        context: [],
        forwardedProps: {},
      }),
    );
    expect(followup.status).toBe(200);
    const followupEvents = await followup.text();
    expect(followupEvents).not.toContain('RUN_ERROR');
    expect(followupEvents).toContain('Offline provider completed');
    const afterFollowup = await platform.localConversations!.getSnapshot(
      firstJob.workerThreadId,
    );
    expect(afterFollowup.lastRun).toMatchObject({
      runId: followupRunId,
      status: 'finished',
    });
    expect(afterFollowup.messages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('Offline provider completed'),
      }),
    );
    expect(await jobs.get(firstJob.id)).toEqual(savedJob);
    expect(await platform.localConversations!.getSnapshot(parent.id)).toEqual(
      savedParent,
    );
    expect(parentContext).not.toHaveBeenCalled();
    expect(pageScope).not.toHaveBeenCalledWith(parent.id);
    expect(abilityExposure).toHaveBeenCalledWith(dot.id, 'text');
    expect(abilityExposure).not.toHaveBeenCalledWith(dot.id, 'voice');
  },
  30000,
);
