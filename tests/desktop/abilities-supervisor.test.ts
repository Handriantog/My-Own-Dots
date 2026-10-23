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
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import fixture from '../fixtures/abilities/manifest.json';
import { parseManifest } from '../../src/shared/abilities/manifest.ts';
import type {
  Binding,
  CapabilityReply,
  InvocationRequest,
  VerifiedPackage,
} from '../../src/shared/abilities/types.ts';
import { AbilitySupervisor } from '../../src/desktop/host/abilities/supervisor.ts';
import { buildSandboxProfile } from '../../src/desktop/host/abilities/sandbox.ts';

const execute = promisify(execFile),
  cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'real confined protocol workers',
  () => {
    let root: string,
      launcher: string,
      native: string,
      node: string,
      pythonRoot: string,
      pythonExecutable: string;
    beforeAll(async () => {
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'abilities-supervisor-')),
      );
      launcher = join(root, 'launcher');
      native = join(root, 'native');
      node = await realpath(process.execPath);
      const python = JSON.parse(
        (
          await execute('python3', [
            '-I',
            '-S',
            '-B',
            '-c',
            'import sys,json; print(json.dumps([sys.base_prefix,sys.executable]))',
          ])
        ).stdout,
      ) as [string, string];
      pythonRoot = await realpath(python[0]);
      const framework = join(
        pythonRoot,
        'Resources/Python.app/Contents/MacOS/Python',
      );
      pythonExecutable = await realpath(
        await stat(framework).then(
          () => framework,
          () => python[1],
        ),
      );
      for (const [source, output] of [
        ['native/ability-launcher/main.c', launcher],
        ['tests/fixtures/abilities/worker.c', native],
      ])
        await execute('/usr/bin/xcrun', [
          'clang',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-Wno-deprecated-declarations',
          '-O2',
          resolve(source),
          '-o',
          output,
        ]);
    });
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });
    async function setup(
      runtime: 'javascript' | 'python' | 'native' = 'javascript',
    ) {
      const home = await mkdtemp(join(root, 'quoted-"path"-')),
        packageRoot = join(home, 'package'),
        stateRoot = join(home, 'state');
      for (const path of [
        packageRoot,
        stateRoot,
        join(stateRoot, 'tmp'),
        join(home, 'control'),
      ])
        await mkdir(path, { mode: 0o700 });
      const outside = join(root, randomUUID() + '-other-dot');
      await writeFile(outside, 'PRIVATE_SENTINEL');
      const entry =
        runtime === 'javascript'
          ? 'worker.mjs'
          : runtime === 'python'
            ? 'worker.py'
            : 'worker';
      const manifest = parseManifest({
        ...fixture,
        entrypoint: { runtime, path: entry },
        helpers: [
          {
            id: 'parser',
            entrypoint: { runtime: 'javascript', path: 'helper.mjs' },
            arguments: {
              type: 'object',
              properties: {
                delay: { type: 'integer', minimum: 0, maximum: 5000 },
              },
              required: ['delay'],
              additionalProperties: false,
            },
          },
        ],
        permissions: [
          ...fixture.permissions,
          {
            id: 'helper',
            kind: 'helper',
            helperId: 'parser',
            purpose: 'Run fixture parser.',
          },
        ],
        tools: [
          {
            ...fixture.tools[0],
            id: 'run',
            input: {
              type: 'object',
              properties: {
                op: { type: 'string', maxLength: 32 },
                outside: { type: 'string', maxLength: 4096 },
              },
              required: ['op'],
              additionalProperties: false,
            },
          },
        ],
      });
      await copyFile(
        runtime === 'native'
          ? native
          : resolve(`tests/fixtures/abilities/${entry}`),
        join(packageRoot, entry),
      );
      await copyFile(
        resolve('tests/fixtures/abilities/worker.mjs'),
        join(packageRoot, 'helper.mjs'),
      );
      await writeFile(
        join(packageRoot, 'ability.json'),
        JSON.stringify(manifest),
      );
      const files = [];
      for (const path of [entry, 'helper.mjs', 'ability.json']) {
        await chmod(join(packageRoot, path), path === 'worker' ? 0o555 : 0o444);
        const bytes = await readFile(join(packageRoot, path));
        files.push({
          path,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
          executable: path === 'worker',
        });
      }
      const digest = createHash('sha256')
        .update(JSON.stringify(files))
        .digest('hex');
      const pkg: VerifiedPackage = {
        root: packageRoot,
        digest,
        manifest,
        files,
        descriptor: {
          formatVersion: 1,
          manifest,
          sourceCommit: 'a'.repeat(40),
          releaseTag: 'fixture/v0.1.0',
          asset: {
            id: 1,
            name: 'fixture.tar.gz',
            sha256: digest,
            compressedBytes: 1,
            extractedBytes: files.reduce((sum, f) => sum + f.size, 0),
            fileCount: files.length,
          },
        },
      };
      const binding: Binding = {
        id: randomUUID(),
        dotId: 'dot',
        digest,
        manifest,
        grants: manifest.permissions.map((p) => p.id),
        settings: {},
        revision: 1,
        enabled: true,
        restored: false,
        approvedAt: Date.now(),
      };
      let allowed = true;
      const capabilities = {
        handle: async (): Promise<CapabilityReply> => ({
          ok: true,
          kind: 'account',
          connected: false,
        }),
      };
      const supervisor = new AbilitySupervisor({
        launcher,
        controlRoot: join(home, 'control'),
        runtimes: {
          javascript: { executable: node, readRoots: [dirname(node)] },
          python: { executable: pythonExecutable, readRoots: [pythonRoot] },
        },
        resolve: async () => {
          if (!allowed) throw new Error('Revoked fixture');
          return { binding, package: pkg, stateRoot };
        },
        capability: (_context, _request, _signal) => capabilities.handle(),
      });
      cleanups.push(() => supervisor.stopAll());
      const request = (op: string): InvocationRequest => ({
        context: {
          workspaceId: 'workspace',
          sessionId: 'session',
          dotId: 'dot',
          bindingId: binding.id,
          digest,
          grantRevision: 1,
          invocationId: randomUUID(),
          tool: 'run',
          threadId: 'thread',
        },
        arguments: { op, outside },
        settings: {},
      });
      const pids = async () =>
        (await readFile(join(stateRoot, 'pids'), 'utf8').catch(() => ''))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(Number);
      return {
        home,
        pkg,
        binding,
        supervisor,
        capabilities,
        request,
        stateRoot,
        pids,
        revoke: () => {
          allowed = false;
        },
      };
    }
    it('starts with quoted paths, denies another Dot file and strips the parent environment', async () => {
      const f = await setup();
      process.env.ABILITY_FIXTURE_SECRET = 'fixture-secret';
      try {
        const result = await f.supervisor.invoke(
          f.request('normal'),
          new AbortController().signal,
        );
        expect(result).toMatchObject({
          status: 'success',
          value: { readBlocked: true, injected: null },
        });
        expect((await f.pids()).every((pid) => !alive(pid))).toBe(true);
      } finally {
        delete process.env.ABILITY_FIXTURE_SECRET;
      }
    });
    it('serializes the second call, admits eight queued calls and rejects the ninth', async () => {
      const f = await setup(),
        signal = new AbortController();
      const first = f.supervisor.invoke(f.request('hold'), signal.signal);
      await expect.poll(async () => (await f.pids()).length).toBe(1);
      const queued = Array.from({ length: 8 }, () =>
        f.supervisor.invoke(f.request('normal'), signal.signal),
      );
      expect(
        await f.supervisor.invoke(f.request('normal'), signal.signal),
      ).toEqual({ status: 'error', code: 'busy' });
      expect((await f.pids()).length).toBe(1);
      signal.abort();
      await Promise.all([first, ...queued]);
      expect((await f.pids()).length).toBe(1);
      expect((await f.pids()).filter(alive)).toEqual([]);
    });
    it('counts helpers toward the four-worker ceiling and reaps every process', async () => {
      const f = await setup();
      let maxConcurrentWorkers = 0;
      const timer = setInterval(() => {
        maxConcurrentWorkers = Math.max(
          maxConcurrentWorkers,
          f.supervisor.status(f.binding.id).workers,
        );
      }, 5);
      try {
        const result = await f.supervisor.invoke(
          f.request('helpers'),
          new AbortController().signal,
        );
        expect(result.status).toBe('success');
        if (result.status !== 'success' || !Array.isArray(result.value))
          throw new Error('Missing helper fixture results');
        expect(
          result.value.filter(
            (v) =>
              v && typeof v === 'object' && !Array.isArray(v) && v.ok === true,
          ),
        ).toHaveLength(3);
        expect(result.value).toContainEqual({ ok: false, code: 'busy' });
        expect(maxConcurrentWorkers).toBe(4);
        expect(maxConcurrentWorkers).toBeLessThanOrEqual(4);
        const survivorsAfterStop = (await f.pids()).filter(alive);
        expect(survivorsAfterStop).toEqual([]);
      } finally {
        clearInterval(timer);
      }
    });
    it.each(['effect-crash', 'effect-malformed'])(
      'reports uncertainty after a confirmed effect followed by %s',
      async (op) => {
        const f = await setup();
        let effects = 0;
        f.capabilities.handle = async () => {
          effects++;
          return { ok: true, kind: 'account', connected: false };
        };
        expect(
          await f.supervisor.invoke(
            f.request(op),
            new AbortController().signal,
          ),
        ).toEqual({ status: 'uncertain' });
        expect(effects).toBe(1);
        expect((await f.pids()).filter(alive)).toEqual([]);
      },
    );
    it.each(['malformed', 'oversize', 'unknown'])(
      'closes a worker sending %s protocol data',
      async (op) => {
        const f = await setup();
        expect(
          await f.supervisor.invoke(
            f.request(op),
            new AbortController().signal,
          ),
        ).toEqual({ status: 'uncertain' });
        expect((await f.pids()).length).toBe(1);
        expect((await f.pids()).filter(alive)).toEqual([]);
      },
    );
    it('allows exactly sixty seconds then closes control and reaps the timed-out worker', async () => {
      const f = await setup();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = f.supervisor.invoke(
        f.request('hold'),
        new AbortController().signal,
      );
      for (
        let i = 0;
        i < 200 && !(await stat(join(f.stateRoot, 'ready')).catch(() => false));
        i++
      )
        await delay(10);
      const pids = await f.pids();
      expect(pids).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(pids.filter(alive)).toEqual(pids);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ status: 'uncertain' });
      expect(pids.filter(alive)).toEqual([]);
    });
    it('waits two seconds for an ignored TERM, then kills and reaps before stop resolves', async () => {
      const f = await setup();
      const pending = f.supervisor.invoke(
        f.request('ignore-term'),
        new AbortController().signal,
      );
      await expect
        .poll(() =>
          stat(join(f.stateRoot, 'ready')).then(
            () => true,
            () => false,
          ),
        )
        .toBe(true);
      const started = performance.now();
      await f.supervisor.stopBinding(f.binding.id);
      expect(performance.now() - started).toBeGreaterThanOrEqual(1900);
      expect(await pending).toEqual({ status: 'uncertain' });
      expect((await f.pids()).filter(alive)).toEqual([]);
    });
    it('finishes process cleanup even when the private profile directory cannot be removed', async () => {
      const f = await setup();
      const pending = f.supervisor.invoke(
        f.request('hold'),
        new AbortController().signal,
      );
      await expect.poll(async () => (await f.pids()).length).toBe(1);
      const control = join(f.home, 'control');
      await chmod(control, 0o500);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          f.supervisor.stopBinding(f.binding.id),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error('Profile cleanup blocked process shutdown')),
              1000,
            );
          }),
        ]);
        expect(await pending).toEqual({ status: 'uncertain' });
        expect((await f.pids()).filter(alive)).toEqual([]);
      } finally {
        clearTimeout(timer);
        await chmod(control, 0o700);
      }
    });
    it('drops authority immediately on cancellation before a pending capability can start a helper', async () => {
      const f = await setup();
      let reached = false,
        release: () => void = () => {};
      f.capabilities.handle = async () => {
        reached = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });

        return { ok: true, kind: 'account', connected: false };
      };
      const controller = new AbortController(),
        pending = f.supervisor.invoke(
          f.request('late-helper'),
          controller.signal,
        );
      await expect.poll(() => reached).toBe(true);
      controller.abort();
      f.revoke();
      release();
      await pending;
      expect((await f.pids()).length).toBe(1);
      expect((await f.pids()).filter(alive)).toEqual([]);
    });
    it('ends helper authority as soon as the main worker returns, before its shutdown grace ends', async () => {
      const f = await setup();
      let providerCalls = 0;
      f.capabilities.handle = async () => {
        providerCalls++;
        return { ok: true, kind: 'account', connected: false };
      };
      expect(
        await f.supervisor.invoke(
          f.request('background-helper'),
          new AbortController().signal,
        ),
      ).toEqual({ status: 'success' });
      expect(providerCalls).toBe(0);
      expect((await f.pids()).filter(alive)).toEqual([]);
    });
    it('runs selected Python with isolated startup', async () => {
      const f = await setup('python');
      expect(
        await f.supervisor.invoke(
          f.request('normal'),
          new AbortController().signal,
        ),
      ).toMatchObject({
        status: 'success',
        value: { isolated: 1, noSite: 1, injected: null, cwdInPath: false },
      });
    });
    it('keeps a native re-exec confined under the application profile', async () => {
      const f = await setup('native');
      expect(
        await f.supervisor.invoke(
          f.request('reexec'),
          new AbortController().signal,
        ),
      ).toMatchObject({ status: 'success', value: { readBlocked: true } });
    });
    it('rejects a native package for another architecture before executing it', async () => {
      const f = await setup('native'),
        path = join(f.pkg.root, 'worker');
      const bytes = await readFile(path);
      bytes.writeUInt32LE(0x01000007, 4);
      await chmod(path, 0o755);
      await writeFile(path, bytes);
      await chmod(path, 0o555);
      f.pkg.files.find((file) => file.path === 'worker')!.sha256 = createHash(
        'sha256',
      )
        .update(bytes)
        .digest('hex');
      expect(
        await f.supervisor.invoke(
          f.request('normal'),
          new AbortController().signal,
        ),
      ).toEqual({ status: 'error', code: 'unsupported_platform' });
    });
    it('rejects a package directory replaced with a symlink', async () => {
      const f = await setup();
      await rename(f.pkg.root, f.pkg.root + '-moved');
      await symlink(f.pkg.root + '-moved', f.pkg.root);
      expect(
        await f.supervisor.invoke(
          f.request('normal'),
          new AbortController().signal,
        ),
      ).toEqual({ status: 'error', code: 'permission_denied' });
      expect(await f.pids()).toEqual([]);
    });
  },
);
it('rejects broad or overlapping sandbox roots', () => {
  const input = {
    packageRoot: '/private/ability/package',
    stateRoot: '/private/ability/state',
    temporaryRoot: '/private/ability/state/tmp',
    executable: '/opt/node/bin/node',
    runtimeReadRoots: ['/opt/node/bin'],
  };
  expect(() =>
    buildSandboxProfile({ ...input, runtimeReadRoots: ['/'] }),
  ).toThrow();
  expect(() =>
    buildSandboxProfile({ ...input, stateRoot: input.packageRoot }),
  ).toThrow();
});
