import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { memoryRepositories } from '../fixtures/memory-repositories.ts';
import { AbilityService } from '../../src/server/abilities/service.ts';
import { AbilityHostBridge } from '../../src/server/abilities/host-bridge.ts';
import { DesktopAbilityBridge } from '../../src/desktop/host/abilities/bridge.ts';
import type { JsonValue } from '../../src/shared/abilities/types.ts';
import { DesktopActivityDriver } from '../../src/desktop/host/activity-driver.ts';
import { CompanionSimulation } from '../../src/desktop/core/simulation.ts';
import { buildWorld } from '../../src/desktop/core/world.ts';
import { abilityTools } from '../../src/server/abilities/tools.ts';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'packaged Mouse Mover through the production host',
  () => {
    let root: string,
      bundle: string,
      runtime: typeof import('../../src/desktop/host/abilities/distribution.ts');
    let descriptorBytes: Buffer, bytes: Buffer;
    beforeAll(async () => {
      // Missing fixture is a failure, never a fallback to a live account or network.
      descriptorBytes = await readFile(
        'tests/fixtures/abilities/mouse-mover/mouse-mover-0.1.0.json',
      );
      bytes = await readFile(
        'tests/fixtures/abilities/mouse-mover/mouse-mover-0.1.0.dot-ability.tar.gz',
      );
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'activity-production-')),
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
    async function fixture(
      mode: 'normal' | 'accessibility' | 'hidden' | 'selection' = 'normal',
    ) {
      const data = await memoryRepositories('sqlite');
      cleanup.push(data.close);
      const home = await mkdtemp(join(root, 'workspace-'));
      const dot = (await data.workspace.dots())[0];
      const threadId = randomUUID();
      await data.workspace.bindThread(
        threadId,
        dot.id,
        'Mouse Mover acceptance',
      );
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
          '/mouse-mover-0.1.0.json',
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
      let now = 0,
        point = { x: 500, y: 780 };
      let awake = 0,
        begins = 0,
        ends = 0,
        moves = 0;
      const display = {
        id: 'fixture',
        bounds: { x: 0, y: 0, width: 1000, height: 800 },
        workArea: { x: 0, y: 25, width: 1000, height: 675 },
        scaleFactor: 2,
      };
      const sim = new CompanionSimulation(buildWorld(null, [display], 0), 1, {
        x: 200,
        y: 700,
      });
      const driver = new DesktopActivityDriver({
        now: () => now,
        selectedDot: () => (mode === 'selection' ? 'other' : dot.id),
        available: () => mode !== 'hidden',
        accessibility: () => mode !== 'accessibility',
        display: () => display,
        frame: () => sim.frame(),
        reducedMotion: () => false,
        handoff: (frame) => sim.adoptActivity(frame),
        changed: () => {},
        sleep: {
          start: (kind) => {
            expect(kind).toBe('prevent-display-sleep');
            awake++;
            return 1;
          },
          stop: () => {
            awake--;
          },
        },
        pointer: {
          begin: async () => {
            begins++;
            return {
              point: { ...point },
              down: false,
              revision: 1,
              sampledAtMs: 0,
              idleMs: 10000,
            };
          },
          move: async (_generation, next) => {
            point = { ...next };
            moves++;
            return true;
          },
          end: () => {
            ends++;
          },
        },
      });
      const executable = await realpath(process.execPath);
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
          activityDriver: () => driver,
          storage: {
            isEncryptionAvailable: () => false,
            encryptString: () => {
              throw Error('No credentials');
            },
            decryptString: () => {
              throw Error('No credentials');
            },
          },
          session: () => desktop.session,
          binding: (id) => service.get(id),
          authorize: (context) => desktop.authorize(context),
          open: async () => {
            throw Error('No external account flow');
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
      const approved = await service.reviewInstall(review.descriptorUrl);
      const installed = await service.install(
        approved.id,
        {},
        descriptor.manifest.notices
          ?.filter((n) => n.required)
          .map((n) => n.id) ?? [],
      );
      expect(installed.enabled).toBe(false);
      expect(driver.active).toBe(false);
      await service.setMaster(installed.digest, true);
      const binding = await service.assign(dot.id, installed.digest, true);
      if (!binding) throw Error('Missing binding');
      expect(driver.active).toBe(false);
      expect(begins).toBe(0);
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
            interactive: true,
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
        driver,
        effects: () => ({ awake, begins, ends, moves }),
        render: async (at: number) => {
          now = at;
          const frame = driver.frame(sim.frame(), now);
          await driver.presented(frame);
          return { frame, point: { ...point } };
        },
        invoke,
        service,
        restartService: () => {
          service = new AbilityService(data.workspace, backend, {
            workspaceId: data.owner,
          });
          return service;
        },
      };
    }
    it('carries the sealed package from exact Dock pickup into usable desktop space', async () => {
      const f = await fixture();
      expect(await f.invoke('start')).toMatchObject({ status: 'success' });
      expect((await f.render(1600)).point).toEqual({ x: 500, y: 780 });
      const settled = await f.render(5600);
      expect(settled.frame.root.y).toBeLessThanOrEqual(680);
      expect(settled.point.y).toBeLessThan(700);
      expect(await f.invoke('stop')).toMatchObject({ status: 'success' });
      expect(f.effects()).toMatchObject({ awake: 0, ends: 1 });
    });
    it.each([
      ['accessibility', 'setup_needed'],
      ['hidden', 'host_unavailable'],
      ['selection', 'host_unavailable'],
    ] as const)(
      'preserves %s refusal across the separately bundled host and sealed worker',
      async (mode, code) => {
        const f = await fixture(mode);
        expect(await f.invoke('start')).toEqual({ status: 'error', code });
        expect(f.effects()).toEqual({ awake: 0, begins: 0, ends: 0, moves: 0 });
      },
    );
    it('installs disabled, admits explicit text/voice, reports pause, stops twice, and revokes persistent ownership', async () => {
      const f = await fixture();
      expect(
        await abilityTools(
          f.service,
          f.dot.id,
          f.threadId,
          () => {},
          new AbortController().signal,
        ),
      ).toEqual([]);
      expect(await f.invoke('start', {}, { interactive: false })).toEqual({
        status: 'error',
        code: 'permission_denied',
      });
      const tools = await abilityTools(
        f.service,
        f.dot.id,
        f.threadId,
        () => {},
        new AbortController().signal,
        'voice',
        true,
      );
      expect(tools).toHaveLength(3);
      const start = tools.find((t) => t.name.includes('_start_'))!;
      const result = await start.execute!(
        { arguments: {} },
        { toolCallId: randomUUID(), emitCustomEvent: () => {} },
      );
      expect(result).toMatchObject({ status: 'success' });
      expect(f.driver.active).toBe(true);
      expect(f.effects()).toMatchObject({ awake: 1, begins: 1, moves: 0 });
      f.driver.physical({
        point: { x: 600, y: 300 },
        down: true,
        revision: 2,
        sampledAtMs: 1,
        idleMs: 0,
      });
      const paused = await f.invoke('status');
      expect(paused).toMatchObject({ status: 'success' });
      if (!('resultRef' in paused) || !paused.resultRef)
        throw Error('Missing private status');
      expect(await f.host.readResult(f.dot.id, paused.resultRef)).toEqual({
        kind: 'text',
        text: 'Mouse Mover is paused while you use the mouse. It resumes after five seconds of inactivity.',
      });
      expect(await f.invoke('stop')).toMatchObject({ status: 'success' });
      expect(await f.invoke('stop')).toMatchObject({ status: 'success' });
      expect(f.effects()).toMatchObject({ awake: 0, begins: 1, ends: 1 });
      expect(await f.invoke('start')).toMatchObject({ status: 'success' });
      await f.service.setMaster(f.binding.digest, false);
      expect(f.driver.active).toBe(false);
      expect(f.effects()).toMatchObject({ awake: 0, begins: 2, ends: 2 });
      expect(await f.invoke('start')).toMatchObject({ status: 'error' });
    });
    it.each([
      ['mouse-mover', '0.1.0'],
      ['spotify', '0.1.1'],
      ['spotify-local', '0.1.1'],
    ])(
      'extracts and seals final %s archive through the production installer',
      async (id, version) => {
        const home = await mkdtemp(join(root, 'seal-'));
        const filename = `${id}-${version}`;
        const descriptorBytes = await readFile(
          `tests/fixtures/abilities/mouse-mover/${filename}.json`,
        );
        const archive = await readFile(
          `tests/fixtures/abilities/mouse-mover/${filename}.dot-ability.tar.gz`,
        );
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
          descriptorUrl: `https://github.com/handriantog/my-own-dot-abilities/releases/download/${encodeURIComponent(descriptor.releaseTag)}/${filename}.json`,
          archiveUrl:
            'https://api.github.com/repos/handriantog/my-own-dot-abilities/releases/assets/1',
        };
        const installer = new runtime.AbilityInstaller(
          join(home, 'installation'),
          { resolve: async () => review, download: async () => archive },
        );
        const pkg = await installer.prepare(
          review,
          new AbortController().signal,
        );
        expect(pkg.manifest.id).toBe(id);
        expect(pkg.digest).toBe(descriptor.asset.sha256);
        expect(pkg.manifest.icon).toBeDefined();
        expect(
          await readFile(join(pkg.root, 'ability.json'), 'utf8'),
        ).toContain(id);
      },
    );
  },
);
