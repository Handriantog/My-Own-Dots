import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { memoryRepositories } from '../fixtures/memory-repositories.ts';
import { Platform } from '../../src/server/platform.ts';
import { AbilityService } from '../../src/server/abilities/service.ts';
import type { AbilityHostPort } from '../../src/server/abilities/host-bridge.ts';
import { parseReleaseDescriptor } from '../../src/shared/abilities/manifest.ts';
import { verifyAbilityPackage } from '../../src/desktop/host/abilities/package.ts';
import descriptorFixture from '../fixtures/abilities/spotify-local/spotify-local-0.1.0.json';

const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);
afterEach(() => vi.restoreAllMocks());
it.each(['enabled', 'dot-disabled', 'master-disabled'])(
  'routes a High voice Spotify request through the real task agent with %s grants',
  async (state) => {
    const data = await memoryRepositories('sqlite');
    const platform = await Platform.create(
      data.store,
      data.workspace,
      {
        conversationBackend: 'local',
        llmBackend: 'subscription',
        llmProvider: 'codex',
        baseUrl: 'http://localhost',
        runtimeUrl: 'http://localhost/api/copilotkit',
        voiceName: 'marin',
        slackUsers: [],
        webSearchProvider: 'disabled',
        workspaceId: data.owner,
      },
      { storage: data.client },
    );
    try {
      await platform.start();
      const dot = (await data.workspace.dots())[0];
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
      const binding = await data.workspace.abilities.bind(
        dot.id,
        descriptor.asset.sha256,
        descriptor.manifest.permissions.map((p) => p.id),
        {},
      );
      if (state === 'dot-disabled')
        await data.workspace.abilities.revoke(binding.id);
      if (state === 'master-disabled')
        await data.workspace.abilities.setMaster(binding.digest, false);
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
      platform.abilities = new AbilityService(data.workspace, host, {
        workspaceId: data.owner,
      });
      engine.runAgent.mockImplementation(async (request) => {
        const payload = JSON.parse(request.prompt.split('\n\n')[1]);
        const pause = payload.availableTools.find((t: { name: string }) =>
          t.name.includes('_pause_'),
        );
        return {
          result:
            payload.messages.at(-1)?.role !== 'tool' && pause
              ? {
                  text: '',
                  toolCalls: [
                    {
                      name: pause.name,
                      argumentsJson: JSON.stringify({ arguments: {} }),
                    },
                  ],
                }
              : {
                  text: pause ? 'Spotify paused.' : 'No approved Spotify tool.',
                  toolCalls: [],
                },
          usage: {},
        };
      });
      const parent = await platform.createConversation(dot.id, 'Voice music');
      const call = await data.workspace.createCall(parent.id);
      const text = 'Please pause Spotify.';
      await platform.nativeVoice!.turn({
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
        signal: new AbortController().signal,
        native: {
          warm: async () => {},
          close: async () => {},
          interpret: async () => {
            throw Error('unused');
          },
          respond: async () => {
            throw Error('must delegate');
          },
          speak: async (text) => ({ text, pcm: Buffer.alloc(4) }),
        },
      });
      await vi.waitFor(
        async () => {
          const jobs = await platform.nativeVoice!.coordinator.jobs.list({
            parentThreadId: parent.id,
          });
          expect(jobs).toHaveLength(1);
          expect(jobs[0].status).toBe('completed');
          expect(jobs[0].result).toBe(
            state === 'enabled'
              ? 'Spotify paused.'
              : 'No approved Spotify tool.',
          );
        },
        { timeout: 5000 },
      );
      if (state === 'enabled') {
        expect(invocations).toHaveLength(1);
        expect(invocations[0].context).toMatchObject({
          dotId: dot.id,
          bindingId: binding.id,
          channel: 'voice',
          threadId: parent.id,
          tool: 'pause',
        });
      } else expect(invocations).toEqual([]);
    } finally {
      await platform.stop();
      await data.close();
    }
  },
  15000,
);
