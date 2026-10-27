import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversationSession } from '../src/server/local-voice/codex-conversation-intake.js';

afterEach(() => vi.unstubAllEnvs());

it('reuses the installed adapter process with fresh tool-free threads and reaps cancelled replacements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-intake-boundary-'));
  const executable = join(root, 'codex.mjs');
  await writeFile(
    executable,
    (
      await readFile('tests/fixtures/conversation-execution-server.mjs', 'utf8')
    ).replace('#!/usr/bin/env node', `#!${process.execPath}`),
  );
  await chmod(executable, 0o700);
  vi.stubEnv('CODEX_BIN', executable);
  const session = new CodexConversationSession();
  const rows = async (): Promise<Record<string, unknown>[]> =>
    (await readFile(join(root, 'requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  const request = {
    caption: 'Hello',
    instructions: 'You are the fixture Dot.',
    context: { tasks: [] },
    signal: new AbortController().signal,
  };
  try {
    await session.warm(request.signal);
    expect(await session.run(request)).toEqual({
      reply: 'Fixture response.',
      needsTask: false,
      usesTaskStatus: false,
    });
    expect(
      await session.run({
        ...request,
        caption: 'ACTION',
        instructions: 'Updated persona.',
      }),
    ).toEqual({
      reply: 'Fixture response.',
      needsTask: true,
      usesTaskStatus: false,
    });
    const first = await rows();
    expect(first.filter((row) => row.spawn)).toHaveLength(2); // configuration probe + admitted process
    expect(
      first.filter((row) => row.spawn).map((row) => row.effectiveEffort),
    ).toEqual(['low', 'low']);
    for (const row of first.filter((row) => row.method === 'turn/start'))
      expect(row.params).toMatchObject({ effort: 'low' });
    const threads = first.filter((row) => row.method === 'thread/start');
    expect(threads).toHaveLength(2);
    expect(threads[0].pid).toBe(threads[1].pid);
    for (const row of threads) {
      expect(row.params).toMatchObject({
        environments: [],
        ephemeral: true,
        selectedCapabilityRoots: [],
        approvalPolicy: 'never',
      });
      expect(row.params).not.toHaveProperty('runtimeWorkspaceRoots');
      const params = row.params as { dynamicTools: { name: string }[] };
      expect(params.dynamicTools).toEqual([]);
    }
    const controller = new AbortController();
    const stalled = session.run({
      ...request,
      caption: 'STALL',
      signal: controller.signal,
    });
    const stopped = stalled.catch((error: unknown) => error);
    await vi.waitFor(async () =>
      expect(
        (await rows()).filter((row) => row.method === 'turn/start'),
      ).toHaveLength(3),
    );
    controller.abort(new Error('Owner interrupted.'));
    expect(await stopped).toEqual(new Error('Owner interrupted.'));
    expect(
      await session.run({ ...request, caption: 'After interruption' }),
    ).toEqual({
      reply: 'Fixture response.',
      needsTask: false,
      usesTaskStatus: false,
    });
    await expect(
      session.run({ ...request, caption: 'COMMENTARY_ONLY' }),
    ).rejects.toThrow(/final/i);
    await session.close();
    const final = await rows();
    expect(final.filter((row) => row.method === 'turn/start')).toHaveLength(5);
    expect(final.filter((row) => row.spawn)).toHaveLength(4);
    for (const row of final.filter((row) => row.spawn))
      expect(() => process.kill(row.spawn as number, 0)).toThrow();
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
