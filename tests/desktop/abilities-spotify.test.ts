import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request, type Server } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { lastValueFrom, toArray } from 'rxjs';
import { memoryRepositories } from '../fixtures/memory-repositories.ts';
import {
  spotifyProvider,
  sentinel,
  trackUri,
  playlistUri,
} from '../fixtures/abilities/spotify-provider.ts';
import { AbilityService } from '../../src/server/abilities/service.ts';
import { AbilityHostBridge } from '../../src/server/abilities/host-bridge.ts';
import { DesktopAbilityBridge } from '../../src/desktop/host/abilities/bridge.ts';
import { abilityToolName } from '../../src/server/abilities/tools.ts';
import { DotAgent } from '../../src/server/dot-agent.ts';
import { LocalAgentRunner } from '../../src/server/local-runner.ts';
import { ContextCompaction } from '../../src/server/context-compaction.ts';
import { MemoryInference } from '../../src/server/memory-inference.ts';
import { canonicalVoiceAnswer } from '../../src/server/local-voice/live.ts';
import { delegatedOutcome } from '../../src/server/local-voice/delegation.ts';
import type { JsonValue } from '../../src/shared/abilities/types.ts';
const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'packaged Spotify through the production host',
  () => {
    let root: string,
      bundle: string,
      runtime: typeof import('../../src/desktop/host/abilities/distribution.ts');
    let descriptorBytes: Buffer, bytes: Buffer;
    beforeAll(async () => {
      // Missing fixture is a failure, never a fallback to a live account or network.
      descriptorBytes = await readFile(
        'tests/fixtures/abilities/spotify/spotify-0.1.0.json',
      );
      bytes = await readFile(
        'tests/fixtures/abilities/spotify/spotify-0.1.0.dot-ability.tar.gz',
      );
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'spotify-production-')),
      );
      bundle = join(root, 'bundle');
      const builder = await import(
        pathToFileURL(resolve('scripts/abilities/build.mjs')).href
      );
      await builder.buildAbilityRuntime(process.cwd(), bundle);
      runtime = createRequire(import.meta.url)(
        join(bundle, 'ability-runtime.cjs'),
      );
    });
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });
    async function fixture() {
      const data = await memoryRepositories('sqlite');
      cleanup.push(data.close);
      const home = await mkdtemp(join(root, 'workspace-'));
      const dot = (await data.workspace.dots())[0];
      const threadId = randomUUID();
      await data.workspace.bindThread(threadId, dot.id, 'Spotify acceptance');
      await data.conversations.getOrCreateThread({
        threadId,
        userId: data.owner,
        agentId: dot.id,
      });
      const descriptor = runtime.parseReleaseDescriptor(
        JSON.parse(descriptorBytes.toString()),
      );
      const review = {
        id: randomUUID(),
        expiresAt: Date.now() + 60000,
        descriptor,
        descriptorSha256: createHash('sha256')
          .update(descriptorBytes)
          .digest('hex'),
        descriptorUrl:
          'https://github.com/handriantog/my-own-dot-abilities/releases/download/' +
          encodeURIComponent(descriptor.releaseTag) +
          '/spotify-0.1.0.json',
        archiveUrl:
          'https://api.github.com/repos/handriantog/my-own-dot-abilities/releases/assets/1',
      };
      const backend = new AbilityHostBridge(data.owner);
      let service = new AbilityService(data.workspace, backend, {
        workspaceId: data.owner,
        resolve: async () => ({ ...structuredClone(review), id: randomUUID() }),
      });
      backend.setAuthority((context) => service.authorize(context));
      cleanup.push(() => backend.stop());
      const token = 'offline-owner-token-at-least-thirty-two-bytes';
      const app = new Hono();
      app.route('/ability-host/v1', backend.routes(token));
      const server = serve({
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port: 0,
      });
      await once(server, 'listening');
      cleanup.push(async () => {
        (server as Server).closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      });
      const { state, transport } = spotifyProvider();
      const key = randomBytes(32),
        executable = await realpath(process.execPath);
      const installer = new runtime.AbilityInstaller(
        join(home, 'installation'),
        {
          resolve: async () => structuredClone(review),
          download: async () => bytes,
        },
      );
      const host: InstanceType<typeof runtime.AbilityHost> =
        new runtime.AbilityHost({
          workspaceId: data.owner,
          packageRoot: join(home, 'installation'),
          stateRoot: join(home, 'state'),
          controlRoot: join(home, 'control'),
          credentialRoot: join(home, 'credentials'),
          launcher: join(bundle, 'native/ability-launcher'),
          runtimes: {
            javascript: {
              executable,
              readRoots: [dirname(dirname(executable))],
            },
          },
          installer,
          transport,
          storage: {
            isEncryptionAvailable: () => true,
            encryptString: (value) => {
              const iv = randomBytes(12),
                cipher = createCipheriv('aes-256-gcm', key, iv);
              const ciphertext = Buffer.concat([
                cipher.update(value, 'utf8'),
                cipher.final(),
              ]);
              return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
            },
            decryptString: (value) => {
              const cipher = createDecipheriv(
                'aes-256-gcm',
                key,
                value.subarray(0, 12),
              );
              cipher.setAuthTag(value.subarray(12, 28));
              return Buffer.concat([
                cipher.update(value.subarray(28)),
                cipher.final(),
              ]).toString('utf8');
            },
          },
          session: () => desktop.session,
          binding: (id) => service.get(id),
          authorize: (context) => desktop.authorize(context),
          open: async (url) => {
            state.urls.push(new URL(url));
          },
        });
      const desktop: DesktopAbilityBridge = new DesktopAbilityBridge(
        {
          url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          workspaceId: data.owner,
          ownerToken: token,
        },
        host,
      );
      cleanup.push(() => desktop.stop());
      await desktop.start();
      const pendingReview = await service.review(dot.id, review.descriptorUrl);
      expect(pendingReview.descriptor.manifest.notices).toHaveLength(2);
      expect(await service.list(dot.id)).toEqual([]);
      await expect(
        service.teach(dot.id, pendingReview.id, { clientId: 'offline-client' }),
      ).rejects.toMatchObject({ code: 'permission_denied' });
      const approved = await service.review(dot.id, review.descriptorUrl);
      const binding = await service.teach(
        dot.id,
        approved.id,
        { clientId: 'offline-client' },
        ['terms'],
      );
      const connect = async () => {
        const index = state.urls.length;
        const pending = host.accounts.connect(binding.id, 'offline-client');
        void pending.catch(() => {});
        await expect.poll(() => state.urls.length).toBe(index + 1);
        const url = new URL(
          state.urls[index].searchParams.get('redirect_uri')!,
        );
        expect(url.hostname).toBe('127.0.0.1');
        url.search = new URLSearchParams({
          code: 'offline-code',
          state: state.urls[index].searchParams.get('state')!,
        }).toString();
        const status = await new Promise<number>((done, reject) => {
          const req = request(url, (response) => {
            response.resume();
            response.once('end', () => done(response.statusCode!));
          });
          req.on('error', reject);
          req.end();
        });
        expect(status).toBe(200);
        await pending;
      };
      await connect();
      const invoke = (
        tool: string,
        args: Record<string, JsonValue> = {},
        extra: Record<string, unknown> = {},
      ) =>
        service.invoke(
          {
            dotId: dot.id,
            bindingId: binding.id,
            threadId,
            tool,
            invocationId: randomUUID(),
            arguments: args,
            ...extra,
          },
          new AbortController().signal,
        );
      return {
        ...data,
        home,
        dot,
        threadId,
        binding,
        descriptor,
        host,
        desktop,
        backend,
        state,
        invoke,
        connect,
        service,
        restartService: () => {
          service = new AbilityService(data.workspace, backend, {
            workspaceId: data.owner,
          });
          return service;
        },
      };
    }
    it('installs with consent, connects via PKCE, scopes private selections, and executes all eleven tools', async () => {
      const f = await fixture();
      const other = await f.workspace.createDot(
        f.dot.spaceId,
        'Other',
        'Fixture',
        true,
        true,
      );
      expect(await f.service.tools(other.id)).toEqual([]);
      expect(await f.service.tools(f.dot.id, 'voice')).toEqual([]);
      expect(
        await f.invoke(
          'search',
          { query: 'Synthetic Song' },
          { channel: 'voice' },
        ),
      ).toMatchObject({ code: 'permission_denied' });
      const result = await f.invoke('search', { query: 'Synthetic Song' });
      expect(result.status).toBe('success');
      if (!('resultRef' in result) || !result.resultRef)
        throw Error('Missing private result');
      expect(JSON.stringify(result)).not.toContain('SPOTIFY_SENTINEL');
      expect(
        await f.host.readResult(other.id, result.resultRef),
      ).toBeUndefined();
      const view = await f.host.readResult(f.dot.id, result.resultRef);
      if (view?.kind !== 'list') throw Error('Missing list');
      expect(view.items[0].label).toBe(sentinel);
      const selectionRef = await f.host.select(
        f.dot.id,
        result.resultRef,
        view.items[0].id,
      );
      expect(await f.invoke('save_tracks', {}, { selectionRef })).toMatchObject(
        { status: 'success' },
      );
      expect(await f.invoke('save_tracks', {}, { selectionRef })).toMatchObject(
        { status: 'error' },
      );
      for (const [tool, args] of [
        ['playback', {}],
        ['play', { uri: trackUri }],
        ['pause', {}],
        ['skip', {}],
        ['skip', { direction: 'previous' }],
        ['queue', { uri: trackUri }],
        ['volume', { percent: 35 }],
        ['playlists', {}],
        [
          'create_playlist',
          { name: 'Synthetic private list', uris: [trackUri] },
        ],
        ['add_to_playlist', { playlistUri, uris: [trackUri] }],
        ['save_tracks', { uris: [trackUri] }],
      ] as [string, Record<string, JsonValue>][])
        expect(await f.invoke(tool, args)).toMatchObject({ status: 'success' });
      const created = f.state.requests.find(
        (r) =>
          new URL(r.url).pathname === '/v1/me/playlists' && r.method === 'POST',
      )!;
      expect(JSON.parse(created.body)).toMatchObject({
        public: false,
        collaborative: false,
      });
      expect(
        f.state.requests
          .filter((r) =>
            /\/me\/player\/(play|pause|next|previous|queue|volume)/.test(r.url),
          )
          .every(
            (r) =>
              new URL(r.url).searchParams.get('device_id') === 'fixture-player',
          ),
      ).toBe(true);
      const before = f.state.requests.length;
      expect(await f.invoke('pause', {}, { dotId: other.id })).toMatchObject({
        code: 'permission_denied',
      });
      expect(f.state.requests).toHaveLength(before);
    }, 30000);
    it('refreshes once on rejection and revocation during refresh prevents the action', async () => {
      const f = await fixture();
      f.state.rejectAuth = true;
      expect(await f.invoke('pause')).toMatchObject({ status: 'success' });
      expect(f.state.refreshes).toBe(1);
      let release = () => {};
      f.state.beforeRefresh = () =>
        new Promise<void>((done) => {
          release = done;
        });
      f.state.rejectAuth = true;
      const pending = f.invoke('pause');
      await expect.poll(() => f.state.refreshes).toBe(2);
      await f.service.disable(f.binding.id);
      release();
      expect((await pending).status).not.toBe('success');
      expect(
        f.state.requests.filter(
          (r) => new URL(r.url).pathname === '/v1/me/player/pause',
        ),
      ).toHaveLength(1);
      expect(f.host.running(f.binding.id)).toBe(false);
    }, 15000);
    it('clears selections on disconnect, preserves disabled account state, and does not replay uncertain mutations after service restart', async () => {
      const f = await fixture();
      const result = await f.invoke('search', { query: 'Synthetic Song' });
      if (!('resultRef' in result) || !result.resultRef)
        throw Error('Missing result');
      await f.service.disable(f.binding.id);
      expect(await f.invoke('pause')).toMatchObject({
        code: 'permission_denied',
      });
      await f.service.enable(f.binding.id);
      expect(await f.invoke('pause')).toMatchObject({ status: 'success' });
      await f.service.disconnect(f.binding.id);
      expect(
        await f.host.readResult(f.dot.id, result.resultRef),
      ).toBeUndefined();
      expect(await f.invoke('pause')).toMatchObject({
        code: 'permission_denied',
      });
      await f.service.enable(f.binding.id);
      expect(await f.invoke('pause')).toMatchObject({ code: 'setup_needed' });
      await f.connect();
      const invocationId = randomUUID();
      f.state.failure = { path: '/v1/me/playlists', kind: 'drop' };
      expect(
        await f.invoke(
          'create_playlist',
          { name: 'Uncertain fixture' },
          { invocationId },
        ),
      ).toMatchObject({ status: 'uncertain' });
      expect(f.state.creations).toBe(1);
      const restarted = f.restartService();
      expect(
        await restarted.invoke(
          {
            dotId: f.dot.id,
            bindingId: f.binding.id,
            threadId: f.threadId,
            tool: 'create_playlist',
            arguments: { name: 'Uncertain fixture' },
            invocationId,
          },
          new AbortController().signal,
        ),
      ).toMatchObject({ code: 'permission_denied' });
      expect(f.state.creations).toBe(1);
      expect(await f.workspace.abilities.receipt(invocationId)).toMatchObject({
        state: 'settled',
        outcome: { status: 'uncertain' },
      });
      await f.desktop.stop();
      expect(f.host.running(f.binding.id)).toBe(false);
      await expect.poll(() => restarted.tools(f.dot.id)).toEqual([]);
    }, 20000);
    it.each([
      'search',
      'provider-error',
      'partial',
      'partial-403',
      'partial-transport',
    ])(
      'keeps %s worker metadata out of model requests, durable events, memory, compaction, diagnostics and speech inputs',
      async (mode) => {
        const f = await fixture(),
          inference: unknown[] = [],
          voiceEvents: unknown[] = [],
          logs: unknown[] = [];
        for (const method of ['log', 'warn', 'error'] as const)
          vi.spyOn(console, method).mockImplementation((...args) => {
            logs.push(args);
          });
        const agent = new DotAgent(
          f.store,
          f.workspace,
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
          f.dot.id,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          f.service,
        );
        const persisted = agent.onPersistedEvent.bind(agent);
        vi.spyOn(agent, 'onPersistedEvent').mockImplementation(
          (input, event) => {
            voiceEvents.push(structuredClone(event));
            persisted(input, event);
          },
        );
        const runner = new LocalAgentRunner(f.conversations);
        cleanup.push(() => runner.close());
        const input = {
          threadId: f.threadId,
          runId: randomUUID(),
          messages: [
            {
              id: randomUUID(),
              role: 'user' as const,
              content: 'Search for a synthetic song.',
            },
          ],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        };
        const partial = mode.startsWith('partial');
        const targetTool = partial ? 'create_playlist' : 'search';
        const targetArguments = partial
          ? { name: 'Synthetic private list', uris: [trackUri] }
          : { query: 'Synthetic Song' };
        if (mode === 'provider-error')
          f.state.failure = { path: '/v1/search', kind: 'reject', status: 403 };
        if (partial)
          f.state.failure = {
            path: '/v1/playlists/' + '3'.repeat(22) + '/items',
            kind: mode === 'partial-transport' ? 'drop' : 'reject',
            status: mode === 'partial-403' ? 403 : 503,
          };
        const name = abilityToolName(
          f.descriptor.manifest.source,
          'spotify',
          targetTool,
        );
        let calls = 0;
        engine.runAgent.mockReset();
        engine.runAgent.mockImplementation(async (request) => {
          inference.push({ prompt: request.prompt, schema: request.schema });
          return {
            result:
              calls++ === 0
                ? {
                    text: '',
                    toolCalls: [
                      {
                        name,
                        argumentsJson: JSON.stringify({
                          arguments: targetArguments,
                        }),
                      },
                    ],
                  }
                : { text: 'Check the private result card.', toolCalls: [] },
            usage: {},
          };
        });
        const events = await lastValueFrom(
          runner.run({ threadId: f.threadId, agent, input }).pipe(toArray()),
        );
        if (partial) {
          const event = events.find(
            (value) => value.type === 'TOOL_CALL_RESULT',
          );
          expect(event).toBeDefined();
          expect(JSON.parse(String(event!.content))).toMatchObject({
            status: 'uncertain',
          });
          expect(f.state.creations).toBe(1);
        }
        const snapshot = await f.conversations.getSnapshot(f.threadId);
        await f.evidence.indexRun(input.runId);
        const projected = await f.evidence.modelMessages(
          f.threadId,
          snapshot.messages,
        );
        const memory = await f.evidence.searchEpisodes({
          allowedThreadIds: [f.threadId],
          query: 'synthetic',
        });
        const handles = await f.host.recentResults(f.dot.id, f.threadId);
        expect(handles).toHaveLength(1);
        const ownerResult = JSON.stringify(
          await f.host.readResult(f.dot.id, handles[0]),
        );
        expect(ownerResult.includes('SPOTIFY_SENTINEL')).toBe(
          mode !== 'provider-error',
        );
        for (let i = 0; i < 6; i++)
          await lastValueFrom(
            runner
              .run({
                threadId: f.threadId,
                agent,
                input: {
                  ...input,
                  runId: randomUUID(),
                  messages: [
                    {
                      id: randomUUID(),
                      role: 'user',
                      content: 'Continue ' + i,
                    },
                  ],
                },
              })
              .pipe(toArray()),
          );
        const compactionInputs: unknown[] = [];
        const compact = new ContextCompaction(
          Object.assign(f.evidence, {
            workspace: f.workspace,
            memoryEnabled: () => true,
          }),
          new MemoryInference({ provider: 'codex' }, async (request) => {
            compactionInputs.push(request.prompt);
            return {
              result: {
                goal: 'Use Ability',
                constraints: [],
                decisions: [],
                completedWork: [],
                openQuestions: [],
                nextSteps: [],
                evidenceMessageIds: [],
              },
              usage: {},
            };
          }),
        );
        expect(
          await compact.compact(f.threadId, AbortSignal.timeout(5000)),
        ).toBe('updated');
        const captures = JSON.stringify({
          inference,
          events,
          snapshot,
          projected,
          memory,
          compactionInputs,
          voiceEvents,
          logs,
          voice: canonicalVoiceAnswer(snapshot, {
            messageId: input.messages[0].id,
            text: input.messages[0].content,
          }),
          delegation: delegatedOutcome(snapshot),
          final: await f.conversations.getSnapshot(f.threadId),
        });
        expect(inference.length).toBeGreaterThan(0);
        expect(voiceEvents.length).toBeGreaterThan(0);
        for (const secret of [
          'SPOTIFY_SENTINEL',
          'FAKE_ACCESS_TOKEN',
          'FAKE_REFRESH_TOKEN',
        ])
          expect(captures).not.toContain(secret);
      },
      20000,
    );
    it('expires private selections without retaining provider content', async () => {
      const f = await fixture();
      const result = await f.invoke('search', { query: 'Synthetic Song' });
      if (!('resultRef' in result) || !result.resultRef)
        throw Error('Missing result');
      const view = await f.host.readResult(f.dot.id, result.resultRef);
      if (view?.kind !== 'list') throw Error('Missing list');
      const selectionRef = await f.host.select(
        f.dot.id,
        result.resultRef,
        view.items[0].id,
      );
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
      expect(
        await f.host.readResult(f.dot.id, result.resultRef),
      ).toBeUndefined();
      clock.mockRestore();
      expect(await f.invoke('save_tracks', {}, { selectionRef })).toMatchObject(
        { code: 'permission_denied' },
      );
    }, 10000);
    it.each(['desktop', 'backend'])(
      'reaps the worker on %s disconnect without terminating external playback',
      async (mode) => {
        const f = await fixture();
        const external = spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          { stdio: 'ignore' },
        );
        cleanup.push(async () => {
          if (external.exitCode === null && external.signalCode === null) {
            const done = once(external, 'exit');
            external.kill();
            await done;
          }
        });
        f.state.failure = { path: '/v1/me/player/queue', kind: 'stall' };
        const pending = f.invoke('queue', { uri: trackUri });
        await expect
          .poll(() =>
            f.state.requests.some(
              (r) => new URL(r.url).pathname === '/v1/me/player/queue',
            ),
          )
          .toBe(true);
        if (mode === 'desktop') await f.desktop.stop();
        else await f.backend.stop();
        expect((await pending).status).not.toBe('success');
        await expect
          .poll(() => f.host.running(f.binding.id), { timeout: 5000 })
          .toBe(false);
        expect(external.exitCode).toBeNull();
        expect(external.signalCode).toBeNull();
      },
      15000,
    );
  },
);
