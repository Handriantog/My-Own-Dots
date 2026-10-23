import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStore } from '../../src/server/workspace';
import { AbilityService } from '../../src/server/abilities/service';
import { AbilityHost } from '../../src/desktop/host/abilities/host';
import { AbilityFailure } from '../../src/shared/abilities/bridge';
import { parseManifest } from '../../src/shared/abilities/manifest';
import { abilityTools } from '../../src/server/abilities/tools';
import type { AbilityHostPort } from '../../src/server/abilities/host-bridge';
import type {
  ActivityDriver,
  ActivityStatus,
} from '../../src/shared/abilities/activity';
import manifestFixture from '../fixtures/abilities/manifest.json';
import activity from '../fixtures/abilities/activity.json';
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'interactive activity through service, store and confined worker',
  () => {
    let root: string, launcher: string, node: string;
    beforeAll(async () => {
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'activity-admission-')),
      );
      launcher = join(root, 'launcher');
      node = await realpath(process.execPath);
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
      const workspace = new WorkspaceStore(':memory:', 'owner');
      cleanups.push(() => workspace.close());
      const dot = workspace.dots()[0];
      workspace.bindThread('thread', dot.id, 'Fixture');
      const home = await mkdtemp(join(root, 'host-')),
        digest = 'a'.repeat(64),
        packageRoot = join(home, 'installation');
      const manifest = parseManifest({
        ...manifestFixture,
        activities: [activity],
        permissions: [
          {
            id: 'motion',
            kind: 'companion-activity',
            purpose: 'Fixture',
            activities: ['orbit'],
            pointer: true,
            keepAwake: 'display',
          },
        ],
        entrypoint: { runtime: 'javascript', path: 'worker.mjs' },
        tools: [
          {
            ...manifestFixture.tools[0],
            id: 'run',
            execution: 'interactive',
            input: {
              type: 'object',
              properties: { op: { type: 'string', maxLength: 32 } },
              required: ['op'],
              additionalProperties: false,
            },
          },
        ],
      });
      const target = join(packageRoot, 'packages', digest);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await copyFile(
        'tests/fixtures/abilities/owner-worker.mjs',
        join(target, 'worker.mjs'),
      );
      await chmod(join(target, 'worker.mjs'), 0o444);
      const bytes = await readFile(join(target, 'worker.mjs'));
      const pkg = {
        digest,
        root: target,
        manifest,
        descriptor: {
          formatVersion: 1 as const,
          manifest,
          sourceCommit: 'a'.repeat(40),
          releaseTag: 'fixture/v0.1.0',
          asset: {
            id: 1,
            name: 'fixture.tar.gz',
            sha256: digest,
            compressedBytes: 1,
            extractedBytes: bytes.length,
            fileCount: 1,
          },
        },
        files: [
          {
            path: 'worker.mjs',
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
            executable: false,
          },
        ],
      };
      workspace.abilities.recordPackage(pkg);
      const binding = workspace.abilities.bind(dot.id, digest, ['motion'], {});
      let attached = true,
        owner: string | undefined,
        state: ActivityStatus = 'inactive',
        starts = 0;
      const driver: ActivityDriver = {
        async start(who) {
          owner = who.bindingId;
          state = 'approaching';
          starts++;
        },
        async stop(id) {
          if (!id || id === owner) {
            state = 'inactive';
            owner = undefined;
          }
        },
        status(id) {
          return id === owner ? state : 'inactive';
        },
      };
      const host = new AbilityHost({
        workspaceId: 'workspace',
        packageRoot,
        stateRoot: join(home, 'state'),
        controlRoot: join(home, 'control'),
        credentialRoot: join(home, 'credentials'),
        launcher,
        runtimes: {
          javascript: { executable: node, readRoots: [dirname(dirname(node))] },
        },
        storage: {
          isEncryptionAvailable: () => false,
          encryptString: () => {
            throw Error('unavailable');
          },
          decryptString: () => {
            throw Error('unavailable');
          },
        },
        session: () => (attached ? 'session' : undefined),
        binding: async (id) => service.get(id),
        authorize: async (ctx) => (await service.authorize(ctx)).binding,
        activityDriver: () => driver,
        renewActivity: async (ctx) => {
          const b = await service.get(ctx.bindingId),
            master = (await service.installed()).find(
              (i) => i.digest === b.digest,
            );
          if (!master?.enabled || master.restored)
            throw new AbilityFailure('permission_denied');
          return b;
        },
        open: async () => {},
      });
      const port: AbilityHostPort = {
        session: () =>
          attached ? { id: 'session', workspaceId: 'workspace' } : undefined,
        install: async () => pkg,
        invoke: async (req, signal) =>
          host.invoke(
            JSON.parse(
              JSON.stringify({
                type: 'invoke',
                request: req,
                ...(await service.authorize(req.context)),
              }),
            ),
            signal,
          ),
        cancel: (id) => host.cancel(id),
        revoke: (id, revision) => host.revoke(id, revision),
        disconnect: (id) => host.disconnect(id),
        eraseState: (id) => host.eraseState(id),
        uninstall: (d) => host.uninstall(d),
        quiesce: () => host.quiesce(),
        resume: () => host.resume(),
        stop: () => host.stop(),
      };
      const service = new AbilityService(workspace, port, {
        workspaceId: 'workspace',
      });
      cleanups.push(() => host.stop());
      const invoke = (
        op: string,
        interactive = true,
        signal = new AbortController().signal,
        id = randomUUID(),
      ) =>
        service.invoke(
          {
            dotId: dot.id,
            bindingId: binding.id,
            threadId: 'thread',
            tool: 'run',
            invocationId: id,
            arguments: { op },
            interactive,
          },
          signal,
        );
      return {
        workspace,
        dot,
        binding,
        host,
        service,
        invoke,
        driver,
        state: () => state,
        starts: () => starts,
        detach: () => {
          attached = false;
        },
      };
    }
    it('filters default background tools and rejects untrusted interactive arguments', async () => {
      const f = await fixture();
      expect(await f.service.tools(f.dot.id)).toEqual([]);
      expect(await f.service.tools(f.dot.id, 'text', true)).toHaveLength(1);
      expect(await f.invoke('activity-start', false)).toMatchObject({
        status: 'error',
        code: 'permission_denied',
      });
      const [tool] = await abilityTools(
        f.service,
        f.dot.id,
        'thread',
        () => {},
        new AbortController().signal,
        'text',
        true,
      );
      expect(
        await tool.execute!(
          { arguments: { op: 'activity-start' }, interactive: true },
          { toolCallId: 'forged', emitCustomEvent() {} },
        ),
      ).toMatchObject({ status: 'error' });
      expect(f.starts()).toBe(0);
    });
    it('starts only when requested and keeps activity after successful receipt settlement', async () => {
      const f = await fixture();
      expect(f.state()).toBe('inactive');
      expect(await f.invoke('activity-start')).toMatchObject({
        status: 'success',
      });
      expect(f.state()).toBe('approaching');
      await new Promise((r) => setTimeout(r, 650));
      expect(f.state()).toBe('approaching');
      expect(await f.invoke('activity-start')).toMatchObject({
        status: 'success',
      });
      expect(f.starts()).toBe(1);
      expect(await f.invoke('activity-stop')).toMatchObject({
        status: 'success',
      });
      expect(f.state()).toBe('inactive');
    });
    it.each(['activity-fail', 'activity-invalid', 'activity-hold'])(
      'releases a provisional start on %s',
      async (op) => {
        const f = await fixture(),
          c = new AbortController();
        const pending = f.invoke(op, true, c.signal);
        if (op === 'activity-hold') {
          await expect.poll(f.state).toBe('approaching');
          c.abort();
        }
        expect((await pending).status).not.toBe('success');
        expect(f.state()).toBe('inactive');
      },
    );
    it('cancels after host success during receipt settlement without leaking the native lease', async () => {
      const f = await fixture(),
        c = new AbortController(),
        settle = f.workspace.abilities.settleInvocation.bind(
          f.workspace.abilities,
        );
      vi.spyOn(f.workspace.abilities, 'settleInvocation').mockImplementation(
        (id, outcome) => {
          c.abort();
          return settle(id, outcome);
        },
      );
      const id = randomUUID();
      expect(await f.invoke('activity-start', true, c.signal, id)).toEqual({
        status: 'uncertain',
      });
      expect(f.state()).toBe('inactive');
      expect(f.workspace.abilities.receipt(id)?.outcome).toEqual({
        status: 'uncertain',
      });
    });
    it('does not cancel a prior activity when a later query fails settlement', async () => {
      const f = await fixture();
      await f.invoke('activity-start');
      const c = new AbortController(),
        settle = f.workspace.abilities.settleInvocation.bind(
          f.workspace.abilities,
        );
      vi.spyOn(f.workspace.abilities, 'settleInvocation').mockImplementation(
        (id, outcome) => {
          c.abort();
          return settle(id, outcome);
        },
      );
      expect(await f.invoke('activity-status', true, c.signal)).toEqual({
        status: 'uncertain',
      });
      expect(f.state()).toBe('approaching');
    });
    it('releases immediately when cancellation races a blocked receipt write', async () => {
      const f = await fixture(),
        c = new AbortController();
      let release!: () => void,
        entered = false;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const settle = f.workspace.abilities.settleInvocation.bind(
        f.workspace.abilities,
      );
      vi.spyOn(f.workspace.abilities, 'settleInvocation').mockImplementation(
        async (id, outcome) => {
          entered = true;
          await gate;
          settle(id, outcome);
        },
      );
      const pending = f.invoke('activity-start', true, c.signal);
      await expect.poll(() => entered).toBe(true);
      c.abort();
      try {
        await expect.poll(f.state).toBe('inactive');
      } finally {
        release();
        await pending;
      }
    });
    it('rolls back on a failed receipt write', async () => {
      const f = await fixture();
      vi.spyOn(f.workspace.abilities, 'settleInvocation').mockImplementation(
        () => {
          throw Error('storage unavailable');
        },
      );
      expect(await f.invoke('activity-start')).toEqual({ status: 'uncertain' });
      expect(f.state()).toBe('inactive');
    });
    it.each(['master', 'dot', 'disconnect', 'quiesce', 'uninstall'])(
      'immediately releases committed ownership on %s',
      async (action) => {
        const f = await fixture();
        await f.invoke('activity-start');
        expect(f.state()).toBe('approaching');
        if (action === 'master')
          await f.service.setMaster(f.binding.digest, false);
        if (action === 'dot') await f.service.disable(f.binding.id);
        if (action === 'disconnect') await f.service.disconnect(f.binding.id);
        if (action === 'quiesce') await f.service.quiesce();
        if (action === 'uninstall')
          await f.service.uninstall(f.binding.digest, true);
        expect(f.state()).toBe('inactive');
      },
    );
    it.each(['master', 'revision', 'session'])(
      'renewal detects %s changes without an active worker',
      async (action) => {
        const f = await fixture();
        await f.invoke('activity-start');
        if (action === 'master')
          f.workspace.abilities.setMaster(f.binding.digest, false);
        if (action === 'revision') f.workspace.abilities.revoke(f.binding.id);
        if (action === 'session') f.detach();
        await expect.poll(f.state, { timeout: 3000 }).toBe('inactive');
      },
    );
  },
);
