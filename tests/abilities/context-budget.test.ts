import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { memoryRepositories } from '../fixtures/memory-repositories.ts';
import { MemoryMaintenance } from '../../src/server/memory-maintenance.ts';
import { DotAgent } from '../../src/server/dot-agent.ts';
import { LocalAgentRunner } from '../../src/server/local-runner.ts';
import { AbilityService } from '../../src/server/abilities/service.ts';
import type { AbilityHostPort } from '../../src/server/abilities/host-bridge.ts';
import { parseReleaseDescriptor } from '../../src/shared/abilities/manifest.ts';
import { pageReviewTool } from '../../src/shared/page-review.ts';
import { connectionActionTool } from '../../src/shared/connection-types.ts';
import { folderApprovalTool } from '../../src/shared/folder-access.ts';
import { localAiConfigFromEnv } from '../../src/server/platform-config.ts';
import { verifyAbilityPackage } from '../../src/desktop/host/abilities/package.ts';
import descriptorFixture from '../fixtures/abilities/spotify-local/spotify-local-0.1.0.json';

const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);
afterEach(() => vi.restoreAllMocks());

it.each([
  { label: 'default capacity', env: {}, allowed: true },
  {
    label: 'source setup defaults',
    env: parseEnv(readFileSync('.env.example', 'utf8')),
    allowed: true,
  },
  {
    label: 'explicit smaller capacity',
    env: { MEMORY_INPUT_TOKEN_LIMIT: '24000' },
    allowed: false,
  },
])('handles Spotify tool turns with $label', async ({ env, allowed }) => {
  const data = await memoryRepositories('sqlite');
  const config = {
    ...localAiConfigFromEnv(env),
    storageEngine: 'sqlite' as const,
    llmBackend: 'subscription' as const,
    llmProvider: 'codex',
    baseUrl: '',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
    webSearchProvider: 'disabled' as const,
  };
  const memory = await MemoryMaintenance.create(
    data.store,
    data.workspace,
    config,
    {
      repositories: data.client!.repositories,
    },
  );
  const runner = new LocalAgentRunner(data.conversations);
  try {
    const dot = (await data.workspace.dots())[0];
    const threadId = randomUUID();
    await data.workspace.bindThread(threadId, dot.id, 'Music chat');
    const descriptor = parseReleaseDescriptor(descriptorFixture);
    await data.workspace.abilities.recordPackage(
      await verifyAbilityPackage(
        'tests/fixtures/abilities/spotify-local/spotify-local-0.1.0.dot-ability.tar.gz',
        {
          id: randomUUID(),
          descriptor,
          descriptorSha256: 'a'.repeat(64),
          descriptorUrl: 'https://example.test/fixture.json',
          archiveUrl: 'https://example.test/fixture.tar.gz',
          expiresAt: Date.now() + 60000,
        },
        await realpath(data.root),
        new AbortController().signal,
      ),
    );
    await data.workspace.abilities.bind(
      dot.id,
      descriptor.asset.sha256,
      descriptor.manifest.permissions.map((permission) => permission.id),
      {},
    );
    const invocations: Parameters<AbilityHostPort['invoke']>[0][] = [];
    const host: AbilityHostPort = {
      session: () => ({ id: 'fixture', workspaceId: data.owner }),
      invoke: async (request) => {
        invocations.push(request);
        return { status: 'success', resultRef: randomUUID() };
      },
      install: async () => {
        throw Error('not used');
      },
      revoke: async () => {},
      disconnect: async () => {},
      eraseState: async () => {},
      uninstall: async () => {},
      stop: async () => {},
    };
    const abilities = new AbilityService(data.workspace, host, {
      workspaceId: data.owner,
    });
    const agent = new DotAgent(
      data.store,
      data.workspace,
      config,
      dot.id,
      false,
      undefined,
      memory,
      undefined,
      async (url) => ({ url, status: 'opened' }),
      abilities,
    );
    engine.runAgent.mockImplementation(async (request) => {
      const payload = JSON.parse(request.prompt.split('\n\n')[1]);
      const last = payload.messages.at(-1);
      return {
        result:
          last.role === 'user' && last.content.startsWith('Please')
            ? {
                text: '',
                toolCalls: [
                  {
                    name: payload.availableTools.find(
                      (tool: { name: string }) =>
                        tool.name.includes('_playlists_'),
                    ).name,
                    argumentsJson: JSON.stringify({ arguments: {} }),
                  },
                ],
              }
            : {
                text:
                  last.role === 'tool'
                    ? 'Check the playlist result card.'
                    : 'Which playlist?',
                toolCalls: [],
              },
        usage: {},
      };
    });
    for (const content of [
      'Hello.',
      'Can you play a song from my playlist?',
      'Anything from the bus playlist.',
      'Please use the desktop Spotify app.',
    ]) {
      const events = await lastValueFrom(
        runner
          .run({
            threadId,
            agent,
            input: {
              threadId,
              runId: randomUUID(),
              messages: [{ id: randomUUID(), role: 'user', content }],
              tools: [pageReviewTool, connectionActionTool, folderApprovalTool],
              context: [],
              state: {},
              forwardedProps: {},
            },
          })
          .pipe(toArray()),
      );
      if (!allowed && content.startsWith('Please')) {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'RUN_ERROR',
            message: expect.stringMatching(/Context capacity exceeded/),
          }),
        );
        expect(invocations).toEqual([]);
        break;
      }
      expect(events.filter((event) => event.type === 'RUN_ERROR')).toEqual([]);
      expect(
        events.some((event) => event.type === 'TEXT_MESSAGE_CONTENT'),
      ).toBe(true);
    }
    if (allowed) {
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({
        context: { tool: 'playlists', channel: 'text' },
        arguments: {},
      });
      const snapshot = await data.conversations.getSnapshot(threadId);
      expect(snapshot.messages).toContainEqual(
        expect.objectContaining({
          role: 'assistant',
          content: 'Check the playlist result card.',
        }),
      );
    }
  } finally {
    await runner.close();
    await memory.stop();
    await data.close();
  }
});
