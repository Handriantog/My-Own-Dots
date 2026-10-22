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
import { runtimePolicy } from '../../src/server/storage/runtime-policy.ts';
import { parseManifest } from '../../src/shared/abilities/manifest.ts';
import type { VerifiedPackage } from '../../src/shared/abilities/types.ts';
import manifestFixture from '../fixtures/abilities/manifest.json';
const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);
const cleanups: (() => unknown)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  vi.restoreAllMocks();
});
function fixture() {
  const store = new Store(':memory:'),
    workspace = new WorkspaceStore(':memory:', 'owner');
  cleanups.push(() => {
    workspace.close();
    store.close();
  });
  const dot = workspace.dots()[0],
    other = workspace.createDot(dot.spaceId, 'Other', 'Fixture', true, true);
  workspace.bindThread('thread', dot.id, 'Fixture');
  const manifest = parseManifest(manifestFixture),
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
    undefined,
    undefined,
    service,
  );
  const input = {
    threadId: 'thread',
    runId: randomUUID(),
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
    await pending;
    expect(cancelled).toBe(true);
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
