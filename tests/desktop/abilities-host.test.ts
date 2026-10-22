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
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import manifestFixture from '../fixtures/abilities/manifest.json';
import { parseManifest } from '../../src/shared/abilities/manifest.ts';
import { AbilityHost } from '../../src/desktop/host/abilities/host.ts';
import { DesktopAbilityBridge } from '../../src/desktop/host/abilities/bridge.ts';
import { AbilityHostBridge } from '../../src/server/abilities/host-bridge.ts';
import {
  hostCommandSchema,
  type HostInvocation,
} from '../../src/shared/abilities/bridge.ts';
import type { InvocationOutcome } from '../../src/shared/abilities/types.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'assembled Ability host with real confined workers',
  () => {
    let root: string, launcher: string, node: string;
    beforeAll(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'abilities-host-')));
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
    async function fixture(
      visibility: 'owner-only' | 'model-visible' = 'owner-only',
      wire = false,
    ) {
      const home = await mkdtemp(join(root, 'host-')),
        digest = 'a'.repeat(64),
        packageRoot = join(home, 'installation');
      const manifest = parseManifest({
        ...manifestFixture,
        entrypoint: { runtime: 'javascript', path: 'worker.mjs' },
        tools: [
          {
            ...manifestFixture.tools[0],
            id: 'run',
            visibility,
            input: {
              type: 'object',
              properties: { op: { type: 'string', maxLength: 32 } },
              required: ['op'],
              additionalProperties: false,
            },
            output: { type: 'integer', minimum: 0, maximum: 100 },
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
      const data = await readFile(join(target, 'worker.mjs'));
      const files = [
        {
          path: 'worker.mjs',
          sha256: createHash('sha256').update(data).digest('hex'),
          size: data.length,
          executable: false,
        },
      ];
      const descriptor = {
        formatVersion: 1 as const,
        manifest,
        sourceCommit: 'a'.repeat(40),
        releaseTag: 'fixture/v0.1.0',
        asset: {
          id: 1,
          name: 'fixture.tar.gz',
          sha256: digest,
          compressedBytes: 1,
          extractedBytes: data.length,
          fileCount: 1,
        },
      };
      const binding = {
        id: randomUUID(),
        dotId: 'dot',
        digest,
        manifest,
        grants: ['account', 'search'],
        settings: { clientId: 'fixture-client' },
        revision: 1,
        enabled: true,
        restored: false,
        approvedAt: 1,
      };
      let command: HostInvocation = {
        type: 'invoke',
        binding,
        package: { digest, descriptor, manifest, files },
        request: {
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
          arguments: { op: 'success' },
          settings: binding.settings,
        },
      };
      command = hostCommandSchema.parse(
        JSON.parse(JSON.stringify(command)),
      ) as HostInvocation;
      const calls: unknown[] = [];
      let session: string | undefined = 'session';
      let desktop: DesktopAbilityBridge | undefined;
      let backend: AbilityHostBridge | undefined;
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
            throw new Error('unavailable');
          },
          decryptString: () => {
            throw new Error('unavailable');
          },
        },
        session: () => session,
        binding: async () => structuredClone(binding),
        authorize: async (context) =>
          desktop ? desktop.authorize(context) : structuredClone(binding),
        open: async () => {},
        http: {
          request: async (context, request) => {
            calls.push({ context, request });
            return {
              ok: true,
              kind: 'https',
              status: 200,
              headers: {},
              body: 'OWNER_ONLY_SENTINEL',
            };
          },
        },
      });
      cleanups.push(() => host.stop());
      if (wire) {
        backend = new AbilityHostBridge('workspace');
        backend.setAuthority(async () => ({
          binding: structuredClone(binding),
          package: command.package,
        }));
        const token = 'fixture-owner-token-at-least-thirty-two-bytes';
        const app = new Hono();
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
        cleanups.push(() => backend!.stop());
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('missing port');
        desktop = new DesktopAbilityBridge(
          {
            url: `http://127.0.0.1:${address.port}`,
            workspaceId: 'workspace',
            ownerToken: token,
          },
          host,
        );
        cleanups.push(() => desktop!.stop());
        await desktop.start();
        session = backend.session()!.id;
        command.request.context.sessionId = session;
      }
      const invoke = async (
        op: string,
        signal = new AbortController().signal,
        selectionRef?: string,
      ) =>
        (backend
          ? (value: HostInvocation, signal: AbortSignal) =>
              backend!.invoke(value.request, signal)
          : host.invoke.bind(host))(
          {
            ...command,
            request: {
              ...command.request,
              context: {
                ...command.request.context,
                invocationId: randomUUID(),
              },
              arguments: { op },
              ...(selectionRef ? { selectionRef } : {}),
            },
          },
          signal,
        );
      return {
        host,
        statePath: join(
          home,
          'state',
          createHash('sha256')
            .update(JSON.stringify(['workspace', binding.id]))
            .digest('hex'),
        ),
        command,
        binding,
        calls,
        invoke,
        endSession: () => {
          session = undefined;
        },
      };
    }
    it('projects success, partial, errors, stderr and late results before the bridge', async () => {
      const f = await fixture('owner-only', true),
        bridgeResponses: InvocationOutcome[] = [];
      for (const op of ['success', 'partial', 'raw-error', 'stderr'])
        bridgeResponses.push(await f.invoke(op));
      expect(bridgeResponses.map((r) => r.status)).toEqual([
        'success',
        'uncertain',
        'error',
        'success',
      ]);
      for (const result of bridgeResponses)
        if ('resultRef' in result && result.resultRef) {
          expect(await f.host.readResult('dot', result.resultRef)).toEqual({
            kind: 'text',
            text: 'OWNER_ONLY_SENTINEL',
          });
          expect(
            await f.host.readResult('other-dot', result.resultRef),
          ).toBeUndefined();
        }
      const controller = new AbortController();
      const pending = f.invoke('late', controller.signal);
      setTimeout(() => controller.abort(), 75);
      await expect(pending).rejects.toMatchObject({
        code: 'cancelled',
        message: 'cancelled',
      });
      expect(JSON.stringify(bridgeResponses)).not.toContain(
        'OWNER_ONLY_SENTINEL',
      );
    });
    it('returns only fixed errors for invalid model-visible values and enforces the frame ceiling', async () => {
      const f = await fixture('model-visible');
      expect(await f.invoke('model')).toEqual({
        status: 'success',
        visibility: 'model-visible',
        value: 42,
      });
      for (const op of ['model-invalid', 'model-oversize'])
        expect(await f.invoke(op)).toEqual({
          status: 'error',
          code: 'invalid_response',
        });
    });
    it('reports uncertain and discards a late result after authority changes', async () => {
      const f = await fixture();
      const pending = f.invoke('late');
      await expect
        .poll(
          async () =>
            (
              await readFile(join(f.statePath, 'started'), 'utf8').catch(
                () => '',
              )
            ).length,
          { interval: 10 },
        )
        .toBeGreaterThan(0);
      f.binding.revision++;
      expect(await pending).toEqual({ status: 'uncertain' });
    });
    it('binds HTTPS/account calls to host identity and rejects worker identity fields', async () => {
      const f = await fixture();
      vi.spyOn(f.host.accounts, 'presence').mockResolvedValue({
        connected: true,
        handle: randomUUID(),
      });
      const http = await f.invoke('http');
      expect(http.status).toBe('success');
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({
        context: { dotId: 'dot', bindingId: f.binding.id },
      });
      const account = await f.invoke('account');
      expect(account.status).toBe('success');
      expect(await f.invoke('identity')).toEqual({
        status: 'error',
        code: 'invalid_response',
      });
    });
    it('keeps selections local, one-use, and bound to current authority', async () => {
      const f = await fixture(),
        result = await f.invoke('selection');
      if (!('resultRef' in result) || !result.resultRef)
        throw new Error('missing result');
      const view = await f.host.readResult('dot', result.resultRef);
      if (view?.kind !== 'list') throw new Error('missing view');
      const ref = await f.host.select(
        'dot',
        result.resultRef,
        view.items[0].id,
      );
      const selected = await f.invoke('selected', undefined, ref);
      expect(selected.status).toBe('success');
      expect(await f.invoke('selected', undefined, ref)).toEqual({
        status: 'error',
        code: 'permission_denied',
      });
      f.binding.revision++;
      expect(await f.host.readResult('dot', result.resultRef)).toBeUndefined();
    });
    it.each(['revoke', 'disconnect', 'stop', 'session'])(
      'clears results on %s',
      async (action) => {
        const f = await fixture(),
          result = await f.invoke('success');
        if (!('resultRef' in result) || !result.resultRef)
          throw new Error('missing result');
        if (action === 'revoke') await f.host.revoke(f.binding.id, 1);
        if (action === 'disconnect') await f.host.disconnect(f.binding.id);
        if (action === 'stop') await f.host.stop();
        if (action === 'session') f.endSession();
        expect(
          await f.host.readResult('dot', result.resultRef),
        ).toBeUndefined();
      },
    );
    it('fails closed on command/package/settings mismatch and stale revisions', async () => {
      const f = await fixture();
      for (const patch of [
        { digest: 'b'.repeat(64) },
        { dotId: 'foreign' },
        { grantRevision: 2 },
      ]) {
        expect(
          await f.host.invoke(
            {
              ...f.command,
              request: {
                ...f.command.request,
                context: { ...f.command.request.context, ...patch },
              },
            },
            new AbortController().signal,
          ),
        ).toEqual({ status: 'error', code: 'permission_denied' });
      }
    });
  },
);
