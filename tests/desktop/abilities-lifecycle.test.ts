import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fork, execFile, type ChildProcess } from 'node:child_process';
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
import type { WorkspaceBackendConnection } from '../../src/desktop/host/workspace-backend.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
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
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  await done;
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
    async function fixture() {
      const home = await mkdtemp(join(root, 'fixture-')),
        profile = join(home, 'profile');
      await mkdir(profile, { mode: 0o700 });
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
      const digest = 'a'.repeat(64),
        binding = {
          id: randomUUID(),
          dotId: 'dot',
          digest,
          manifest,
          grants: ['account', 'search'],
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
      const [connection] = (await once(backend, 'message')) as [
        WorkspaceBackendConnection,
      ];
      const options = {
        profile,
        bundle,
        runtimes: {
          javascript: { executable, readRoots: [dirname(dirname(executable))] },
        },
      };
      const controller = new AbilityController({
        ...options,
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
        backend,
        connection,
        controller,
        worker,
        binding,
        options,
      };
    }
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
        const [ready] = await once(owner, 'message');
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
        await worker.response;
        expect(alive(f.backend.pid!)).toBe(true);
        expect((await fetch(`${f.connection.url}/alive`)).ok).toBe(true);
      },
      15000,
    );
  },
);
