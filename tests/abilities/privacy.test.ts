import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { lastValueFrom, toArray } from 'rxjs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { memoryRepositories } from '../fixtures/memory-repositories.ts';
import { AbilityHost } from '../../src/desktop/host/abilities/host.ts';
import { DesktopAbilityBridge } from '../../src/desktop/host/abilities/bridge.ts';
import { AbilityHostBridge } from '../../src/server/abilities/host-bridge.ts';
import { AbilityService } from '../../src/server/abilities/service.ts';
import { abilityToolName } from '../../src/server/abilities/tools.ts';
import { DotAgent } from '../../src/server/dot-agent.ts';
import { LocalAgentRunner } from '../../src/server/local-runner.ts';
import { ContextCompaction } from '../../src/server/context-compaction.ts';
import { MemoryInference } from '../../src/server/memory-inference.ts';
import { delegatedOutcome } from '../../src/server/local-voice/delegation.ts';
import { canonicalVoiceAnswer } from '../../src/server/local-voice/live.ts';
import { OwnerResultView } from '../../src/client/abilities/AbilityResultCard.tsx';
import { parseManifest } from '../../src/shared/abilities/manifest.ts';
import manifestFixture from '../fixtures/abilities/manifest.json';
const engine = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('myown-llm-integrator', () => engine);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'owner-only content across real conversation sinks',
  () => {
    let root: string, launcher: string;
    beforeAll(async () => {
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'abilities-privacy-')),
      );
      launcher = join(root, 'launcher');
      await promisify(execFile)('/usr/bin/xcrun', [
        'clang',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wno-deprecated-declarations',
        '-O2',
        resolve('native/ability-launcher/main.c'),
        '-o',
        launcher,
      ]);
    });
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });
    async function fixture() {
      const data = await memoryRepositories('sqlite');
      cleanups.push(data.close);
      const dot = (await data.workspace.dots())[0],
        threadId = randomUUID();
      await data.workspace.bindThread(threadId, dot.id, 'Private Ability test');
      await data.conversations.getOrCreateThread({
        threadId,
        userId: data.owner,
        agentId: dot.id,
      });
      const home = await mkdtemp(join(root, 'host-')),
        packageRoot = join(home, 'installation'),
        digest = 'a'.repeat(64),
        target = join(packageRoot, 'packages', digest);
      const manifest = parseManifest({
        ...manifestFixture,
        entrypoint: { runtime: 'javascript', path: 'worker.mjs' },
        tools: [
          {
            ...manifestFixture.tools[0],
            id: 'run',
            input: {
              type: 'object',
              properties: { op: { type: 'string', maxLength: 32 } },
              required: ['op'],
              additionalProperties: false,
            },
          },
        ],
      });
      await mkdir(target, { recursive: true, mode: 0o700 });
      // Real worker bytes, including hostile text/error/stderr and split protocol frames.
      let worker = (
        await readFile('tests/fixtures/abilities/owner-worker.mjs', 'utf8')
      ).replaceAll(
        'OWNER_ONLY_SENTINEL',
        'SPOTIFY_SENTINEL<script>alert(1)</script>',
      );
      worker = worker.replace(
        "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
        "{ const line = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'; process.stdout.write(line.slice(0, 25)); setTimeout(() => process.stdout.write(line.slice(25)), 5); }",
      );
      await writeFile(join(target, 'worker.mjs'), worker);
      await chmod(join(target, 'worker.mjs'), 0o444);
      const bytes = Buffer.from(worker),
        descriptor = {
          formatVersion: 1 as const,
          manifest,
          sourceCommit: 'b'.repeat(40),
          releaseTag: 'fixture/v0.1.0',
          asset: {
            id: 1,
            name: 'fixture.tar.gz',
            sha256: digest,
            compressedBytes: 1,
            extractedBytes: bytes.length,
            fileCount: 1,
          },
        };
      const pkg = {
        digest,
        root: target,
        descriptor,
        manifest,
        files: [
          {
            path: 'worker.mjs',
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
            executable: false,
          },
        ],
      };
      await data.workspace.abilities.recordPackage(pkg);
      const binding = await data.workspace.abilities.bind(
        dot.id,
        digest,
        manifest.permissions.map((p) => p.id),
        {},
      );
      const backend = new AbilityHostBridge(data.owner),
        service = new AbilityService(data.workspace, backend, {
          workspaceId: data.owner,
        });
      backend.setAuthority((context) => service.authorize(context));
      cleanups.push(() => backend.stop());
      const token = 'fixture-owner-token-at-least-thirty-two-bytes',
        app = new Hono();
      app.route('/ability-host/v1', backend.routes(token));
      const server = serve({
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port: 0,
      });
      await once(server, 'listening');
      cleanups.push(async () => {
        (server as Server).closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const executable = await realpath(process.execPath);
      const host: AbilityHost = new AbilityHost({
        workspaceId: data.owner,
        packageRoot,
        stateRoot: join(home, 'state'),
        controlRoot: join(home, 'control'),
        credentialRoot: join(home, 'credentials'),
        launcher,
        runtimes: {
          javascript: { executable, readRoots: [dirname(dirname(executable))] },
        },
        storage: {
          isEncryptionAvailable: () => false,
          encryptString: () => {
            throw new Error();
          },
          decryptString: () => {
            throw new Error();
          },
        },
        session: () => desktop.session,
        binding: (id) => service.get(id),
        authorize: (context) => desktop.authorize(context),
        open: async () => {},
      });
      const desktop: DesktopAbilityBridge = new DesktopAbilityBridge(
        {
          url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          workspaceId: data.owner,
          ownerToken: token,
        },
        host,
      );
      cleanups.push(() => desktop.stop());
      await desktop.start();
      const agent = new DotAgent(
        data.store,
        data.workspace,
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
      const runner = new LocalAgentRunner(data.conversations);
      cleanups.push(() => runner.close());
      const input = {
        threadId,
        runId: randomUUID(),
        messages: [
          {
            id: randomUUID(),
            role: 'user' as const,
            content: 'Use the approved Ability.',
          },
        ],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      };
      return {
        ...data,
        dot,
        binding,
        host,
        service,
        agent,
        runner,
        input,
        home,
        name: abilityToolName(manifest.source, manifest.id, 'run'),
      };
    }
    it.each(['success', 'raw-error', 'stderr', 'partial', 'late'])(
      'keeps %s provider bytes out of inference, durable events, memory, compaction, and voice',
      async (op) => {
        const f = await fixture(),
          inference: unknown[] = [],
          voiceEvents: unknown[] = [],
          logs: unknown[] = [];
        vi.spyOn(console, 'log').mockImplementation((...args) => {
          logs.push(args);
        });
        vi.spyOn(console, 'warn').mockImplementation((...args) => {
          logs.push(args);
        });
        vi.spyOn(console, 'error').mockImplementation((...args) => {
          logs.push(args);
        });
        // The real runner calls the real persisted-event hook; this observes its voice input.
        const persisted = f.agent.onPersistedEvent.bind(f.agent);
        vi.spyOn(f.agent, 'onPersistedEvent').mockImplementation(
          (input, event) => {
            voiceEvents.push(structuredClone(event));
            persisted(input, event);
          },
        );
        engine.runAgent.mockReset();
        let calls = 0;
        engine.runAgent.mockImplementation(async (request) => {
          inference.push({ prompt: request.prompt, schema: request.schema });
          return {
            result:
              calls++ === 0
                ? {
                    text: '',
                    toolCalls: [
                      {
                        name: f.name,
                        argumentsJson: JSON.stringify({ arguments: { op } }),
                      },
                    ],
                  }
                : {
                    text: 'The Ability finished. Check its result card.',
                    toolCalls: [],
                  },
            usage: {},
          };
        });
        const running = lastValueFrom(
          f.runner
            .run({ threadId: f.input.threadId, agent: f.agent, input: f.input })
            .pipe(toArray()),
        );
        if (op === 'late') {
          const state = join(
            f.home,
            'state',
            createHash('sha256')
              .update(JSON.stringify([f.owner, f.binding.id]))
              .digest('hex'),
            'started',
          );
          await expect
            .poll(
              async () => !!(await readFile(state).catch(() => undefined)),
              { interval: 10 },
            )
            .toBe(true);
          await f.runner.stop({ threadId: f.input.threadId });
        }
        const events = await running,
          snapshot = await f.conversations.getSnapshot(f.input.threadId);
        expect(inference.length).toBeGreaterThan(0);
        expect(voiceEvents.length).toBeGreaterThan(0);
        await f.evidence.indexRun(f.input.runId);
        const projected = await f.evidence.modelMessages(
          f.input.threadId,
          snapshot.messages,
        );
        const memory = await f.evidence.searchEpisodes({
          allowedThreadIds: [f.input.threadId],
          query: 'Ability',
        });
        const voice = canonicalVoiceAnswer(snapshot, {
          messageId: f.input.messages[0].id,
          text: f.input.messages[0].content,
        });
        if (op !== 'late' && op !== 'raw-error') {
          const handles = await f.host.recentResults(
            f.dot.id,
            f.input.threadId,
          );
          expect(handles).toHaveLength(1);
          const view = await f.host.readResult(f.dot.id, handles[0]);
          expect(view).toBeDefined();
          const html = renderToStaticMarkup(
            createElement(OwnerResultView, { result: view! }),
          );
          expect(html).toContain('SPOTIFY_SENTINEL&lt;script&gt;');
          expect(html).not.toContain('<script>');
        } else
          expect(
            await f.host.recentResults(f.dot.id, f.input.threadId),
          ).toEqual([]);
        // Extend the actual saved run through ordinary user turns until compaction has a prefix.
        engine.runAgent.mockImplementation(async (request) => {
          inference.push({ prompt: request.prompt, schema: request.schema });
          return { result: { text: 'Continue.', toolCalls: [] }, usage: {} };
        });
        for (let index = 0; index < 6; index++)
          await lastValueFrom(
            f.runner
              .run({
                threadId: f.input.threadId,
                agent: f.agent,
                input: {
                  ...f.input,
                  runId: randomUUID(),
                  messages: [
                    {
                      id: randomUUID(),
                      role: 'user',
                      content: `Continue ${index}`,
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
                goal: 'Use the Ability',
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
          await compact.compact(f.input.threadId, AbortSignal.timeout(5000)),
        ).toBe('updated');
        expect(compactionInputs).toHaveLength(1);
        const capturedInferenceAndStorage = {
          inference,
          events,
          snapshot,
          projected,
          memory,
          compactionInputs,
          voiceEvents,
          voice,
          delegation: delegatedOutcome(snapshot),
          logs,
          finalSnapshot: await f.conversations.getSnapshot(f.input.threadId),
        };
        expect(JSON.stringify(capturedInferenceAndStorage)).not.toContain(
          'SPOTIFY_SENTINEL',
        );
      },
      20000,
    );
  },
);
