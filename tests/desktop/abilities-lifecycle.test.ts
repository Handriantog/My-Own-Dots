import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fork, execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AbilityController } from '../../src/desktop/host/abilities/controller.ts';
import { parseManifest } from '../../src/shared/abilities/manifest.ts';
import manifestFixture from '../fixtures/abilities/manifest.json';
import activity from '../fixtures/abilities/activity.json';
import type { ActivityStatus } from '../../src/shared/abilities/activity';
import type { WorkspaceBackendConnection } from '../../src/desktop/host/workspace-backend.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await within(fn(), 'Fixture cleanup', 3000);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Fixture cleanup failed.');
});
async function within<T>(
  promise: Promise<T>,
  stage: string,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error(`${stage} timed out.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const listening = new AbortController();
  const done = once(child, 'exit', { signal: listening.signal });
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  }, 1000);
  try {
    child.kill('SIGTERM');
    await within(done, 'Fixture child exit after SIGKILL', 2000);
  } finally {
    clearTimeout(escalation);
    listening.abort();
  }
}
describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'desktop Ability lifecycle and owner boundary',
  () => {
    let root: string, bundle: string, executable: string;
    beforeAll(async () => {
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'ability-lifecycle-')),
      );
      bundle = join(root, 'bundle');
      await mkdir(join(bundle, 'native'), { recursive: true, mode: 0o700 });
      executable = await realpath(process.execPath);
      await promisify(execFile)('/usr/bin/xcrun', [
        'clang',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wno-deprecated-declarations',
        '-O2',
        resolve('native/ability-launcher/main.c'),
        '-o',
        join(bundle, 'native/ability-launcher'),
      ]);
    });
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });
    it('reaps a fixture child that ignores graceful shutdown', async () => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import process from 'node:process'; process.on('SIGTERM', () => {}); process.send({ ready: true }); setInterval(() => {}, 1000);",
        ],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      );
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await once(child, 'message', { signal: AbortSignal.timeout(1000) });
        await Promise.race([
          stop(child),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(Error('Fixture shutdown did not escalate.')),
              1800,
            );
          }),
        ]);
        expect(child.signalCode).toBe('SIGKILL');
        expect(alive(child.pid!)).toBe(false);
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit', {
            signal: AbortSignal.timeout(1000),
          });
          child.kill('SIGKILL');
          await exited;
        }
      }
    }, 3000);
    async function fixture(
      onUnavailable?: (stage: string, code: string) => void,
      interruptCleanup = false,
      activities = false,
    ) {
      const home = await mkdtemp(join(root, 'fixture-')),
        profile = join(home, 'profile');
      await mkdir(profile, { mode: 0o700 });
      const manifest = parseManifest({
        ...manifestFixture,
        ...(activities
          ? {
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
            }
          : {}),
        entrypoint: { runtime: 'javascript', path: 'worker.mjs' },
        tools: [
          {
            ...manifestFixture.tools[0],
            id: 'run',
            ...(activities ? { execution: 'interactive' } : {}),
            input: {
              type: 'object',
              properties: { op: { type: 'string', maxLength: 32 } },
              required: ['op'],
              additionalProperties: false,
            },
          },
        ],
      });
      const digest = 'a'.repeat(64),
        binding = {
          id: randomUUID(),
          dotId: 'dot',
          digest,
          manifest,
          grants: activities ? ['motion'] : ['account', 'search'],
          settings: {},
          revision: 1,
          enabled: true,
          restored: false,
          approvedAt: 1,
        };
      const packagePath = join(
        home,
        'abilities',
        'installation',
        'packages',
        digest,
      );
      await mkdir(packagePath, { recursive: true, mode: 0o700 });
      await copyFile(
        'tests/fixtures/abilities/owner-worker.mjs',
        join(packagePath, 'worker.mjs'),
      );
      await chmod(join(packagePath, 'worker.mjs'), 0o444);
      const bytes = await readFile(join(packagePath, 'worker.mjs'));
      const pkg = {
        digest,
        manifest,
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
      const config = {
        workspaceId: randomUUID(),
        abilityRoot: join(home, 'abilities'),
        ownerToken: 'fixture-owner-token-at-least-thirty-two-bytes',
        binding,
        package: pkg,
        interruptCleanup,
      };
      const configFile = join(home, 'backend.json');
      await writeFile(configFile, JSON.stringify(config));
      const backend = fork(
        'tests/fixtures/abilities/lifecycle-backend.mjs',
        [configFile],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      cleanups.push(() => stop(backend));
      const [connection] = (await within(
        once(backend, 'message'),
        'Fixture backend readiness',
        5000,
      )) as [WorkspaceBackendConnection];
      const options = {
        profile,
        bundle,
        runtimes: {
          javascript: { executable, readRoots: [dirname(dirname(executable))] },
        },
      };
      let activityStatus: ActivityStatus = 'inactive';
      const controller = new AbilityController({
        activityDriver: () => ({
          async start() {
            activityStatus = 'approaching';
          },
          async stop() {
            activityStatus = 'inactive';
          },
          status() {
            return activityStatus;
          },
        }),
        ...options,
        onUnavailable,
        storage: {
          isEncryptionAvailable: () => false,
          encryptString: () => {
            throw new Error();
          },
          decryptString: () => {
            throw new Error();
          },
        },
        open: async () => {},
      });
      cleanups.push(() => controller.stop());
      const statePath = join(
        config.abilityRoot,
        'state',
        createHash('sha256')
          .update(JSON.stringify([config.workspaceId, binding.id]))
          .digest('hex'),
      );
      const worker = async () => {
        const response = fetch(`${connection.url}/invoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'hold' }),
        });
        let earlyResult: unknown;
        void response
          .then((result) => result.clone().json())
          .then((result) => {
            earlyResult = result;
          });
        let pid = 0;
        await expect
          .poll(
            async () => {
              if (earlyResult)
                throw new Error(
                  `Worker ended before readiness: ${JSON.stringify(earlyResult)}`,
                );
              pid = Number(
                (
                  await readFile(join(statePath, 'started'), 'utf8').catch(
                    () => '',
                  )
                )
                  .trim()
                  .split('\n')
                  .at(-1),
              );
              return pid;
            },
            { interval: 20, timeout: 5000 },
          )
          .toBeGreaterThan(0);
        expect(alive(pid)).toBe(true);
        return { pid, response };
      };
      return {
        home,
        activityStatus: () => activityStatus,
        backend,
        connection,
        controller,
        worker,
        binding,
        options,
        statePath,
      };
    }
    it('wires the controller driver, renews master authority and never replays after reconnect', async () => {
      const f = await fixture(undefined, false, true);
      await f.controller.attach(f.connection);
      const result = await fetch(`${f.connection.url}/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'activity-start', interactive: true }),
      });
      expect(await result.json()).toMatchObject({ status: 'success' });
      expect(f.activityStatus()).toBe('approaching');
      await new Promise((r) => setTimeout(r, 700));
      expect(f.activityStatus()).toBe('approaching');
      await fetch(`${f.connection.url}/master-off`, { method: 'POST' });
      await expect.poll(f.activityStatus, { timeout: 3000 }).toBe('inactive');
      await f.controller.suspend();
      await f.controller.attach(f.connection);
      expect(f.activityStatus()).toBe('inactive');
    });
    it('acknowledges cancellation after a worker returned and releases its committed activity', async () => {
      const f = await fixture(undefined, false, true);
      await f.controller.attach(f.connection);
      const response = await fetch(`${f.connection.url}/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'activity-start', interactive: true }),
      });
      expect(await response.json()).toMatchObject({ status: 'success' });
      expect(f.activityStatus()).toBe('approaching');
      const cancelled = await fetch(`${f.connection.url}/cancel-invocation`, {
        method: 'POST',
      });
      expect(await cancelled.json()).toEqual({ ok: true });
      expect(f.activityStatus()).toBe('inactive');
    });
    it('keeps an attached backend alive while quit reaps its real Ability worker', async () => {
      const f = await fixture();
      await f.controller.attach(f.connection);
      expect(f.controller.available).toBe(true);
      const worker = await f.worker();
      await f.controller.stop();
      await worker.response;
      const workerPidsAlive = [worker.pid].filter(alive),
        externalBackendAlive =
          alive(f.backend.pid!) &&
          (await fetch(`${f.connection.url}/alive`)).ok;
      expect(workerPidsAlive).toEqual([]);
      expect(externalBackendAlive).toBe(true);
      expect(f.controller.available).toBe(false);
    }, 15000);
    it('suspends and revalidates a fresh session on resume without stopping the backend', async () => {
      const f = await fixture();
      await f.controller.attach(f.connection);
      const worker = await f.worker();
      await f.controller.suspend();
      await worker.response;
      expect(alive(worker.pid)).toBe(false);
      expect(f.controller.available).toBe(false);
      await f.controller.attach(f.connection);
      expect(f.controller.available).toBe(true);
      expect(alive(f.backend.pid!)).toBe(true);
    });
    it.each(['stream disconnect', 'desktop stall'] as const)(
      'recovers once from a %s without replaying the interrupted worker',
      async (failure) => {
        const failures: { stage: string; code: string }[] = [];
        const f = await fixture((stage, code) =>
          failures.push({ stage, code }),
        );
        await f.controller.attach(f.connection);
        const before = await (await fetch(`${f.connection.url}/alive`)).json();
        const worker = await f.worker();
        if (failure === 'stream disconnect')
          await fetch(`${f.connection.url}/disconnect`, { method: 'POST' });
        else {
          // The backend is a separate process: a blocked desktop must lose its
          // short-lived authority even while the workspace keeps running.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
        }
        await expect.poll(() => f.controller.available).toBe(false);
        await expect.poll(() => alive(worker.pid)).toBe(false);
        await worker.response;
        expect(failures).toEqual([
          { stage: 'connection', code: 'host_unavailable' },
        ]);
        await expect
          .poll(() => f.controller.available, { timeout: 4000 })
          .toBe(true);
        const after = await (await fetch(`${f.connection.url}/alive`)).json();
        expect(after.sessionId).not.toBe(before.sessionId);
        expect(after.pairs).toBe(2);
        expect(
          (await readFile(join(f.statePath, 'started'), 'utf8')).trim(),
        ).toBe(String(worker.pid));
        await fetch(`${f.connection.url}/disconnect`, { method: 'POST' });
        await expect.poll(() => f.controller.available).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const failedAgain = await (
          await fetch(`${f.connection.url}/alive`)
        ).json();
        expect(failedAgain.pairs).toBe(2);
        expect(f.controller.available).toBe(false);
        await f.controller.reconnect();
        expect(f.controller.available).toBe(true);
        await f.controller.stop();
        await expect(f.controller.reconnect()).rejects.toThrow();
        expect(f.controller.available).toBe(false);
      },
      15000,
    );
    it('reports only the failed attachment stage and safe error code', async () => {
      const f = await fixture();
      const failures: { stage: string; code: string }[] = [];
      const controller = new AbilityController({
        ...f.options,
        bundle: join(root, 'missing-private-location'),
        storage: {
          isEncryptionAvailable: () => false,
          encryptString: () => {
            throw new Error();
          },
          decryptString: () => {
            throw new Error();
          },
        },
        open: async () => {},
        onUnavailable: (stage, code) => failures.push({ stage, code }),
      });
      cleanups.push(() => controller.stop());
      await controller.attach(f.connection);
      expect(controller.available).toBe(false);
      expect(failures).toEqual([
        { stage: 'launcher', code: 'host_unavailable' },
      ]);
    });
    it('recovers once when the first connection drops before attachment cleanup completes', async () => {
      const f = await fixture(undefined, true);
      await f.controller.attach(f.connection);
      expect(f.controller.available).toBe(false);
      await expect
        .poll(() => f.controller.available, { timeout: 4000 })
        .toBe(true);
      const status = await (await fetch(`${f.connection.url}/alive`)).json();
      expect(status.pairs).toBe(2);
    });
    it('cancels scheduled automatic recovery when the workspace suspends', async () => {
      const f = await fixture();
      await f.controller.attach(f.connection);
      await fetch(`${f.connection.url}/disconnect`, { method: 'POST' });
      await expect.poll(() => f.controller.available).toBe(false);
      await f.controller.suspend();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const status = await (await fetch(`${f.connection.url}/alive`)).json();
      expect(status.pairs).toBe(1);
      expect(f.controller.available).toBe(false);
    });
    it('rejects remote senders and cross-Dot owner result requests before reading private data', async () => {
      const f = await fixture();
      await f.controller.attach(f.connection);
      expect(
        await f.controller.invoke(
          'list',
          { dotId: 'dot' },
          { trusted: () => false },
        ),
      ).toEqual({ ok: false, code: 'permission_denied' });
      expect(
        await f.controller.invoke(
          'connect',
          {
            dotId: 'foreign',
            bindingId: f.binding.id,
            accountId: 'account',
            clientId: 'id',
          },
          { trusted: () => true },
        ),
      ).toEqual({ ok: false, code: 'permission_denied' });
      const listed = await f.controller.invoke(
        'list',
        { dotId: 'dot' },
        { trusted: () => true },
      );
      expect(listed).toMatchObject({ ok: true, value: { available: true } });
    });
    it('reads documentation only for a known installed digest and a trusted workspace frame', async () => {
      const f = await fixture();
      await f.controller.attach(f.connection);
      const args = { source: 'installed', digest: f.binding.digest };
      const file = join(
        f.home,
        'abilities',
        'installation',
        'packages',
        f.binding.digest,
        'README.md',
      );
      await writeFile(file, '# Installed guide');
      expect(
        await f.controller.invoke('documentation', args, {
          trusted: () => true,
        }),
      ).toEqual({ ok: true, value: { markdown: '# Installed guide' } });
      expect(
        await f.controller.invoke('documentation', args, {
          trusted: () => false,
        }),
      ).toEqual({ ok: false, code: 'permission_denied' });
      expect(
        await f.controller.invoke(
          'documentation',
          { ...args, digest: 'b'.repeat(64) },
          { trusted: () => true },
        ),
      ).toEqual({ ok: false, code: 'permission_denied' });
      expect(
        await f.controller.invoke(
          'documentation',
          { ...args, path: '/etc/passwd' },
          { trusted: () => true },
        ),
      ).toMatchObject({ ok: false });
    });
    it('saves the personal client ID in the same trusted Connect action before OAuth begins', async () => {
      const f = await fixture();
      await f.controller.attach(f.connection);
      await f.controller.invoke(
        'connect',
        {
          dotId: 'dot',
          bindingId: f.binding.id,
          accountId: 'account',
          clientId: 'personal-client',
        },
        { trusted: () => true },
      );
      const binding = await (
        await fetch(`${f.connection.url}/api/abilities/${f.binding.id}`)
      ).json();
      expect(binding.settings.clientId).toBe('personal-client');
      expect(binding.grants).toEqual(f.binding.grants);
    });
    it('fails closed without a supported launcher or verified workspace identity', async () => {
      const f = await fixture();
      await f.controller.attach({ ...f.connection, workspaceId: undefined });
      expect(f.controller.available).toBe(false);
      const unavailable = new AbilityController({
        ...f.options,
        bundle: join(root, 'missing'),
        storage: {
          isEncryptionAvailable: () => false,
          encryptString: () => {
            throw new Error();
          },
          decryptString: () => {
            throw new Error();
          },
        },
        open: async () => {},
      });
      cleanups.push(() => unavailable.stop());
      await unavailable.attach(f.connection);
      expect(unavailable.available).toBe(false);
    });
    it.each(['SIGKILL', 'SIGSTOP'] as const)(
      'reaps workers after desktop %s even while the external backend stays alive',
      async (signal) => {
        const f = await fixture();
        const configFile = join(f.home, 'owner.json');
        await writeFile(
          configFile,
          JSON.stringify({ options: f.options, connection: f.connection }),
        );
        const owner = fork(
          'tests/fixtures/abilities/lifecycle-owner.mjs',
          [configFile],
          {
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          },
        );
        cleanups.push(async () => {
          owner.kill('SIGCONT');
          await stop(owner);
        });
        const [ready] = await within(
          once(owner, 'message'),
          'Fixture owner readiness',
          5000,
        );
        expect(ready).toEqual({ attached: true });
        const worker = await f.worker();
        if (signal === 'SIGSTOP') {
          // Successful authority renewals must keep a normal long invocation alive.
          await new Promise((resolve) => setTimeout(resolve, 3500));
          expect(alive(worker.pid)).toBe(true);
        }
        const dead = signal === 'SIGKILL' ? once(owner, 'exit') : undefined;
        owner.kill(signal);
        await dead;
        await expect
          .poll(() => alive(worker.pid), { timeout: 6000, interval: 25 })
          .toBe(false);
        await within(worker.response, 'Worker response after owner loss', 3000);
        expect(alive(f.backend.pid!)).toBe(true);
        expect(
          (
            await fetch(`${f.connection.url}/alive`, {
              signal: AbortSignal.timeout(3000),
            })
          ).ok,
        ).toBe(true);
      },
      15000,
    );
  },
);
