import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { WorkspaceStore } from '../../src/server/workspace.ts';
import { Store } from '../../src/server/store.ts';
import { DotAgent } from '../../src/server/dot-agent.ts';
import { AbilityService } from '../../src/server/abilities/service.ts';
import type { AbilityHostPort } from '../../src/server/abilities/host-bridge.ts';
import {
  abilityTools,
  abilityToolName,
} from '../../src/server/abilities/tools.ts';
import {
  setVoiceTurn,
  clearVoiceTurn,
} from '../../src/server/local-voice/context.ts';
import { runtimePolicy } from '../../src/server/storage/runtime-policy.ts';
import { parseManifest } from '../../src/shared/abilities/manifest.ts';
import type { VerifiedPackage } from '../../src/shared/abilities/types.ts';
import type { VoiceDelegation } from '../../src/shared/voice-delegation.ts';
import manifestFixture from '../fixtures/abilities/manifest.json';
const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);
const cleanups: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  vi.restoreAllMocks();
});
function fixture(delegated = false, typedOnly = false) {
  const store = new Store(':memory:'),
    workspace = new WorkspaceStore(':memory:', 'owner');
  cleanups.push(() => {
    workspace.close();
    store.close();
  });
  const dot = workspace.dots()[0],
    other = workspace.createDot(dot.spaceId, 'Other', 'Fixture', true, true);
  workspace.bindThread('thread', dot.id, 'Fixture');
  if (delegated) workspace.bindThread('parent', dot.id, 'Parent');
  const manifest = parseManifest({
      ...manifestFixture,
      tools: manifestFixture.tools.map((tool) => ({
        ...tool,
        ...(typedOnly ? { channels: ['text'] } : {}),
      })),
    }),
    digest = 'a'.repeat(64);
  const pkg: VerifiedPackage = {
    digest,
    root: '/unused',
    manifest,
    descriptor: {
      formatVersion: 1,
      manifest,
      sourceCommit: 'b'.repeat(40),
      releaseTag: 'fixture/v0.1.0',
      asset: {
        id: 1,
        name: 'fixture.tar.gz',
        sha256: digest,
        compressedBytes: 1,
        extractedBytes: 1,
        fileCount: 1,
      },
    },
    files: [
      {
        path: 'dist/worker.mjs',
        sha256: 'c'.repeat(64),
        size: 1,
        executable: false,
      },
    ],
  };
  workspace.abilities.recordPackage(pkg);
  const binding = workspace.abilities.bind(
    dot.id,
    digest,
    ['account', 'search'],
    { clientId: 'fixture' },
  );
  const b = workspace.abilities.bind(
    other.id,
    digest,
    ['account', 'search'],
    {},
  );
  workspace.abilities.revoke(b.id);
  const invoke = vi.fn<AbilityHostPort['invoke']>(async () => ({
    status: 'success',
    resultRef: randomUUID(),
  }));
  let attached = true;
  const host: AbilityHostPort = {
    session: () =>
      attached ? { id: 'session', workspaceId: 'workspace' } : undefined,
    install: async () => pkg,
    invoke,
    revoke: async () => {},
    disconnect: async () => {},
    eraseState: async () => {},
    uninstall: async () => {},
    stop: async () => {},
  };
  const service = new AbilityService(workspace, host, {
    workspaceId: 'workspace',
  });
  const controller = new AbortController();
  const initial = runtimePolicy(store, workspace).turnState(dot.id);
  const check = async () => {
    if (
      (await runtimePolicy(store, workspace).turnState(dot.id)).abilities !==
      (await initial).abilities
    ) {
      controller.abort();
      throw new Error('Revoked');
    }
  };
  const name = abilityToolName(
    manifest.source,
    manifest.id,
    manifest.tools[0].id,
  );
  const runId = randomUUID();
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
    false,
    undefined,
    undefined,
    delegated
      ? ({
          forThread: async (): Promise<VoiceDelegation> => ({
            id: 'delegation',
            ownerId: workspace.ownerId,
            dotId: dot.id,
            callId: 'call',
            parentThreadId: 'parent',
            workerThreadId: 'thread',
            utteranceId: 'utterance',
            sourceMessageId: 'source-message',
            sourceText: 'Find a song.',
            request: 'Find a song.',
            status: 'running',
            runId,
            leaseGeneration: 1,
            leaseToken: 'lease-token',
            leaseUntil: Date.now() + 30_000,
            createdAt: 0,
            updatedAt: 0,
            result: null,
            error: null,
            receiptMessageId: null,
            deliveredAt: null,
          }),
          threadContext: async () => ({
            available: false,
            messages: [],
            guard: { originDotId: dot.id, spaceIds: [], pageIds: [] },
          }),
        } as never)
      : undefined,
    undefined,
    service,
  );
  const input = {
    threadId: 'thread',
    runId,
    messages: [
      { id: randomUUID(), role: 'user' as const, content: 'Find a song.' },
    ],
    context: [],
    state: {},
    tools: [],
    forwardedProps: {},
  };
  engine.runAgent.mockReset();
  return {
    workspace,
    dot,
    other,
    binding,
    invoke,
    service,
    controller,
    check,
    name,
    agent,
    input,
    detach: () => {
      attached = false;
    },
  };
}
describe('granted Ability tools', () => {
  it('aborts the actual in-flight inference when Ability grants change mid-turn', async () => {
    const f = fixture();
    let signal: AbortSignal | undefined;
    engine.runAgent.mockImplementation(
      (request) =>
        new Promise((_resolve, reject) => {
          signal = request.signal;
          signal!.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          );
        }),
    );
    const finished = lastValueFrom(f.agent.run(f.input).pipe(toArray())).catch(
      () => [],
    );
    try {
      await expect.poll(() => signal).toBeDefined();
      await f.service.disable(f.binding.id);
      await expect.poll(() => signal?.aborted).toBe(true);
    } finally {
      f.agent.abortRun();
      await finished;
    }
  });
  it('exposes only enabled bindings on an attached host and uses collision-resistant bounded names', async () => {
    const f = fixture();
    expect(
      await abilityTools(
        f.service,
        f.dot.id,
        'thread',
        f.check,
        f.controller.signal,
      ),
    ).toHaveLength(1);
    expect(
      await abilityTools(
        f.service,
        f.other.id,
        'thread',
        () => {},
        f.controller.signal,
      ),
    ).toEqual([]);
    f.detach();
    expect(
      await abilityTools(
        f.service,
        f.dot.id,
        'thread',
        f.check,
        f.controller.signal,
      ),
    ).toEqual([]);
    expect(f.name.length).toBeLessThanOrEqual(64);
    expect(f.name).not.toBe(
      abilityToolName(
        { owner: 'other', repository: 'abilities' },
        'fixture',
        'search',
      ),
    );
  });
  it('executes approved capabilities without approval prompts and suppresses duplicate tool delivery', async () => {
    const f = fixture(),
      [tool] = await abilityTools(
        f.service,
        f.dot.id,
        'thread',
        f.check,
        f.controller.signal,
      );
    const input = { arguments: { query: 'song' } },
      context = { toolCallId: 'call-1', emitCustomEvent() {} };
    const values = await Promise.all([
      tool.execute!(input, context),
      tool.execute!(input, context),
    ]);
    expect(values[0]).toEqual(values[1]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(values)).not.toContain('approval');
    const [replacement] = await abilityTools(
      f.service,
      f.dot.id,
      'thread',
      f.check,
      f.controller.signal,
    );
    await replacement.execute!(input, context);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('rejects model-supplied authority and checks revocation before cached execution', async () => {
    const f = fixture(),
      [tool] = await abilityTools(
        f.service,
        f.dot.id,
        'thread',
        f.check,
        f.controller.signal,
      );
    const input = { arguments: { query: 'song' } };
    expect(
      await tool.execute!(
        { ...input, digest: 'b'.repeat(64) },
        { toolCallId: 'spoof', emitCustomEvent() {} },
      ),
    ).toMatchObject({ status: 'error' });
    expect(f.invoke).not.toHaveBeenCalled();
    await tool.execute!(input, { toolCallId: 'valid', emitCustomEvent() {} });
    await f.service.disable(f.binding.id);
    expect(
      await tool.execute!(input, { toolCallId: 'valid', emitCustomEvent() {} }),
    ).toMatchObject({
      status: 'error',
    });
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('passes cancellation into an in-flight host invocation', async () => {
    const f = fixture();
    let cancelled = false;
    f.invoke.mockImplementation(
      async (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled = true;
              resolve({ status: 'uncertain' });
            },
            { once: true },
          );
        }),
    );
    const [tool] = await abilityTools(
      f.service,
      f.dot.id,
      'thread',
      f.check,
      f.controller.signal,
    );
    const pending = tool.execute!(
      { arguments: { query: 'song' } },
      { toolCallId: 'active', emitCustomEvent() {} },
    );
    await expect.poll(() => f.invoke.mock.calls.length).toBe(1);
    f.controller.abort();
    expect(await pending).toEqual({ status: 'uncertain' });
    expect(cancelled).toBe(true);
  });
  it('keeps post-dispatch receipt failures uncertain at the service and model boundary', async () => {
    const f = fixture();
    vi.spyOn(f.workspace.abilities, 'settleInvocation').mockImplementation(
      () => {
        throw new Error('Fixture receipt write failed');
      },
    );
    const input = {
      dotId: f.dot.id,
      bindingId: f.binding.id,
      threadId: 'thread',
      tool: 'search',
      invocationId: randomUUID(),
      arguments: { query: 'song' },
    };
    expect(await f.service.invoke(input, f.controller.signal)).toEqual({
      status: 'uncertain',
    });
    expect(f.workspace.abilities.receipt(input.invocationId)?.state).toBe(
      'running',
    );
    expect(await f.service.invoke(input, f.controller.signal)).toMatchObject({
      status: 'error',
    });
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const [tool] = await abilityTools(
      f.service,
      f.dot.id,
      'thread',
      f.check,
      f.controller.signal,
    );
    expect(
      await tool.execute!(
        { arguments: { query: 'song' } },
        { toolCallId: 'receipt-failure', emitCustomEvent() {} },
      ),
    ).toEqual({ status: 'uncertain' });
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it('drops revoked result references while retaining post-dispatch uncertainty', async () => {
    const f = fixture();
    f.invoke.mockImplementation(async () => {
      f.workspace.abilities.revoke(f.binding.id);
      return { status: 'success', resultRef: randomUUID() };
    });
    const [tool] = await abilityTools(
      f.service,
      f.dot.id,
      'thread',
      f.check,
      f.controller.signal,
    );
    expect(
      await tool.execute!(
        { arguments: { query: 'song' } },
        { toolCallId: 'revoked-result', emitCustomEvent() {} },
      ),
    ).toEqual({ status: 'uncertain' });
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('runs through the actual Dot tool loop with only a generic result', async () => {
    const f = fixture();
    engine.runAgent
      .mockResolvedValueOnce({
        result: {
          text: '',
          toolCalls: [
            {
              name: f.name,
              argumentsJson: JSON.stringify({ arguments: { query: 'song' } }),
            },
          ],
        },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: { text: 'Done.', toolCalls: [] },
        usage: {},
      });
    const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(events.filter((event) => event.type === 'RUN_ERROR')).toEqual([]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const result = events.find((event) => event.type === 'TOOL_CALL_RESULT');
    expect(result).toBeDefined();
    expect(JSON.parse(String(result!.content))).toMatchObject({
      status: 'success',
    });
  });
});

it('scopes a voice delegation result to its validated visible parent conversation', async () => {
  const f = fixture(true);
  engine.runAgent
    .mockResolvedValueOnce({
      result: {
        text: '',
        toolCalls: [
          {
            name: f.name,
            argumentsJson: JSON.stringify({ arguments: { query: 'song' } }),
          },
        ],
      },
      usage: {},
    })
    .mockResolvedValueOnce({
      result: { text: 'Choose in the conversation.', toolCalls: [] },
      usage: {},
    });
  await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
  expect(f.invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      context: expect.objectContaining({ threadId: 'parent' }),
    }),
    expect.any(AbortSignal),
  );
});

it.each(['direct', 'delegated'])(
  'does not expose typed-only Ability tools to %s voice inference',
  async (kind) => {
    const f = fixture(kind === 'delegated', true);
    if (kind === 'direct') {
      setVoiceTurn(f.workspace, {
        callId: 'call',
        dotId: f.dot.id,
        threadId: f.input.threadId,
        messageId: f.input.messages[0].id,
        text: f.input.messages[0].content,
      });
      cleanups.push(() => clearVoiceTurn(f.workspace, 'call'));
    }
    const prompts: unknown[] = [];
    engine.runAgent.mockImplementation(async (request) => {
      prompts.push(request.prompt);
      return {
        result: { text: 'Use typed commands for that Ability.', toolCalls: [] },
        usage: {},
      };
    });
    await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(prompts.length).toBeGreaterThan(0);
    expect(JSON.stringify(prompts)).not.toContain(f.name);
    expect(f.invoke).not.toHaveBeenCalled();
  },
);
