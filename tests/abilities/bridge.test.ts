import { randomUUID } from 'node:crypto';
import { request, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../../src/server/workspace.ts';
import { AbilityHostBridge } from '../../src/server/abilities/host-bridge.ts';
import { AbilityService } from '../../src/server/abilities/service.ts';
import { abilityRoutes } from '../../src/server/abilities/routes.ts';
import {
  DesktopAbilityBridge,
  type DesktopAbilityHandlers,
} from '../../src/desktop/host/abilities/bridge.ts';
import type { InvocationContext } from '../../src/shared/abilities/types.ts';
import { archiveFixture } from '../fixtures/abilities/archive.ts';
import { verifyAbilityPackage } from '../../src/desktop/host/abilities/package.ts';

const token = 'fixture-owner-token-that-is-at-least-32-bytes';
const cleanup: (() => Promise<unknown> | void)[] = [];
// Node fetch adds browser Sec-Fetch headers. The desktop deliberately uses the
// native HTTP transport; exercise that wire format without relaxing the guard.
async function post(
  url: string,
  options: { headers: Record<string, string>; body: string },
) {
  return new Promise<{
    status: number;
    json(): Promise<Record<string, string>>;
  }>((resolve, reject) => {
    const req = request(
      url,
      { method: 'POST', headers: options.headers },
      async (res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({
          status: res.statusCode!,
          json: async () => JSON.parse(Buffer.concat(chunks).toString()),
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(ownerToken: string | null = token) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => workspace.close());
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Fixture');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ability-bridge-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const archive = await archiveFixture(root);
  await mkdir(join(root, 'staging'), { mode: 0o700 });
  const pkg = await verifyAbilityPackage(
    archive.path,
    archive.review,
    join(root, 'staging'),
    new AbortController().signal,
  );
  let clock = Date.now();
  const bridge = new AbilityHostBridge('workspace', () => clock);
  cleanup.push(() => bridge.stop());
  const service = new AbilityService(workspace, bridge, {
    workspaceId: 'workspace',
    resolve: async () => structuredClone(archive.review),
  });
  bridge.setAuthority((context) => service.authorize(context));
  const app = new Hono();
  app.route('/ability-host/v1', bridge.routes(ownerToken ?? undefined));
  app.route('/api', abilityRoutes(service, Boolean(ownerToken)));
  app.get('/api/unrelated', (c) => c.json({ ok: true }));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  cleanup.push(async () => {
    (server as Server).closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture port');
  const url = `http://127.0.0.1:${address.port}`;
  const pair = (
    extra: Record<string, string> = {},
    workspaceId = 'workspace',
    auth: string | null = token,
  ) =>
    post(`${url}/ability-host/v1/pair`, {
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...extra,
      },
      body: JSON.stringify({ workspaceId, nonce: 'a'.repeat(64) }),
    });
  const handlers: DesktopAbilityHandlers = {
    install: async () => pkg,
    invoke: async () => ({ status: 'success' }),
    revoke: async () => {},
    disconnect: async () => {},
    eraseState: async () => {},
    uninstall: async () => {},
    stop: async () => {},
  };
  const client = new DesktopAbilityBridge(
    { url, workspaceId: 'workspace', ownerToken: token },
    handlers,
  );
  cleanup.push(() => client.stop());
  return {
    workspace,
    dot,
    bridge,
    service,
    app,
    url,
    pair,
    client,
    handlers,
    archive,
    pkg,
    advance: (ms: number) => {
      clock += ms;
    },
    teach: async () => {
      const review = await service.review(dot.id, archive.review.descriptorUrl);
      return service.teach(dot.id, review.id);
    },
  };
}
describe('authenticated desktop Ability session', () => {
  it('requires owner authentication even in a tokenless older workspace', async () => {
    const f = await fixture();
    expect((await f.pair({}, 'workspace', null)).status).toBe(401);
    expect((await f.pair({}, 'workspace', 'wrong')).status).toBe(401);
    const old = await fixture(null);
    expect((await old.pair()).status).toBe(401);
  });
  it.each<Record<string, string>>([
    { origin: 'dots://workspace' },
    { 'sec-fetch-site': 'same-origin' },
  ])('rejects browser-origin pairing %j', async (headers) => {
    const f = await fixture();
    expect((await f.pair(headers)).status).toBe(403);
  });
  it('rejects mismatched workspace and nonliteral-loopback backend URLs', async () => {
    const f = await fixture();
    expect((await f.pair({}, 'another-workspace')).status).toBe(409);
    for (const url of [
      'http://localhost:4310',
      'https://example.com',
      'http://127.0.0.1:4310/path',
      'http://user:secret@127.0.0.1',
    ]) {
      expect(
        () =>
          new DesktopAbilityBridge(
            { url, workspaceId: 'workspace', ownerToken: token },
            f.handlers,
          ),
      ).toThrow();
    }
  });
  it('rejects replayed sequence numbers and expired session credentials', async () => {
    const f = await fixture();
    const pair = await (await f.pair()).json();
    expect(pair.token).not.toBe(token);
    expect(pair.token).toMatch(/^[a-f0-9]{64}$/);
    const heartbeat = (sequence: number) =>
      post(`${f.url}/ability-host/v1/heartbeat`, {
        headers: {
          authorization: `Bearer ${pair.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sequence }),
      });
    expect((await heartbeat(1)).status).toBe(200);
    expect((await heartbeat(1)).status).toBe(401);
    f.advance(4000);
    expect((await heartbeat(2)).status).toBe(401);
    expect(f.bridge.session()).toBeUndefined();
  });
  it('invalidates the old desktop when a new authenticated session pairs', async () => {
    const f = await fixture();
    await f.client.start();
    const before = f.bridge.session()!.id;
    const next = await (await f.pair()).json();
    expect(next.sessionId).not.toBe(before);
    await expect.poll(() => f.client.connected).toBe(false);
    expect(f.bridge.session()).toBeUndefined(); // replacement has not attached its stream
  });
  it('pairs again after disconnect without replaying old invocations', async () => {
    const f = await fixture();
    let calls = 0;
    f.handlers.invoke = async () => {
      calls++;
      return { status: 'success' };
    };
    await f.client.start();
    const binding = await f.teach();
    const firstSession = f.bridge.session()!.id;
    const input = {
      dotId: f.dot.id,
      bindingId: binding.id,
      threadId: 'thread',
      tool: 'search',
      invocationId: randomUUID(),
      arguments: { query: 'fixture' },
    };
    expect(await f.service.invoke(input, new AbortController().signal)).toEqual(
      { status: 'success' },
    );
    await f.client.stop();
    await f.client.start();
    expect(f.bridge.session()!.id).not.toBe(firstSession);
    expect(
      await f.service.invoke(input, new AbortController().signal),
    ).toMatchObject({ status: 'error' });
    expect(
      await f.service.invoke(
        { ...input, invocationId: randomUUID() },
        new AbortController().signal,
      ),
    ).toEqual({ status: 'success' });
    expect(calls).toBe(2);
  });
});
describe('serialized admission and revocation', () => {
  it('can reject a concurrent authority check while disable is waiting for the desktop stop', async () => {
    const f = await fixture();
    let context: InvocationContext | undefined;
    f.handlers.invoke = async (value, signal) => {
      context = value.request.context;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return { status: 'uncertain' };
    };
    f.handlers.revoke = async () => {
      await expect(f.client.authorize(context!)).rejects.toThrow();
    };
    await f.client.start();
    const binding = await f.teach();
    const active = f.service.invoke(
      {
        dotId: f.dot.id,
        bindingId: binding.id,
        threadId: 'thread',
        tool: 'search',
        invocationId: randomUUID(),
        arguments: { query: 'fixture' },
      },
      new AbortController().signal,
    );
    await expect.poll(() => context).toBeDefined();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        f.service.disable(binding.id),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Disable blocked an authority check')),
            500,
          );
        }),
      ]);
      expect(await active).toEqual({ status: 'uncertain' });
    } finally {
      clearTimeout(timer);
    }
  });
  it('stops an actual disposable worker before disable resolves and refuses later stale calls', async () => {
    const f = await fixture();
    const workers = new Map<ChildProcess, Promise<unknown>>(),
      launches: number[] = [];
    const stop = async () => {
      for (const worker of workers.keys()) worker.kill();
      await Promise.all(workers.values());
    };
    f.handlers.invoke = async (_value, signal) => {
      const worker = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { stdio: 'ignore', env: {} },
      );
      const done = once(worker, 'close');
      workers.set(worker, done);
      await once(worker, 'spawn');
      launches.push(worker.pid!);
      signal.addEventListener('abort', () => worker.kill(), { once: true });
      await done;
      return { status: 'uncertain' };
    };
    f.handlers.revoke = stop;
    f.handlers.stop = stop;
    await f.client.start();
    const binding = await f.teach();
    const input = {
      dotId: f.dot.id,
      bindingId: binding.id,
      threadId: 'thread',
      tool: 'search',
      invocationId: randomUUID(),
      arguments: { query: 'fixture' },
    };
    const active = f.service.invoke(input, new AbortController().signal);
    await expect.poll(() => launches.length).toBe(1);
    await f.service.disable(binding.id);
    expect(f.workspace.abilities.get(binding.id)?.enabled).toBe(false);
    const before = launches.length;
    expect(
      await f.service.invoke(
        { ...input, invocationId: randomUUID() },
        new AbortController().signal,
      ),
    ).toMatchObject({ status: 'error', code: 'permission_denied' });
    const launchesAfterDisable = launches.slice(before);
    expect(launchesAfterDisable).toEqual([]);
    expect(await active).toMatchObject({ status: 'uncertain' });
    expect(() => process.kill(launches[0], 0)).toThrow();
  });
  it('denies forged context, disconnected dispatch, and uninstall of a bound package', async () => {
    const f = await fixture();
    await f.client.start();
    const binding = await f.teach();
    await expect(
      f.client.authorize({
        workspaceId: 'workspace',
        sessionId: f.bridge.session()!.id,
        dotId: f.dot.id,
        bindingId: binding.id,
        digest: binding.digest,
        grantRevision: binding.revision,
        invocationId: 'forged',
        tool: 'search',
        threadId: 'thread',
      }),
    ).rejects.toThrow();
    await expect(f.service.uninstall(binding.digest)).rejects.toThrow();
    await f.client.stop();
    await expect.poll(() => f.bridge.session()).toBeUndefined();
    expect(
      await f.service.invoke(
        {
          dotId: f.dot.id,
          bindingId: binding.id,
          threadId: 'thread',
          tool: 'search',
          invocationId: randomUUID(),
          arguments: { query: 'fixture' },
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ status: 'error', code: 'host_unavailable' });
    await expect(f.service.disable(binding.id)).rejects.toThrow();
    expect(f.workspace.abilities.get(binding.id)?.enabled).toBe(false);
  });
  it('does not install until review approval and consumes that exact review only once', async () => {
    const f = await fixture();
    let installs = 0;
    f.handlers.install = async () => {
      installs++;
      return f.pkg;
    };
    await f.client.start();
    const review = await f.service.review(
      f.dot.id,
      f.archive.review.descriptorUrl,
    );
    expect(installs).toBe(0);
    await expect(f.service.teach('another-dot', review.id)).rejects.toThrow();
    await f.service.teach(f.dot.id, review.id);
    await expect(f.service.teach(f.dot.id, review.id)).rejects.toThrow();
    expect(installs).toBe(1);
  });
  it('keeps approved grants through disable, configuration and enable; forgetting controls state erasure', async () => {
    const f = await fixture();
    const effects: string[] = [];
    f.handlers.disconnect = async () => {
      effects.push('disconnect');
    };
    f.handlers.eraseState = async () => {
      effects.push('erase');
    };
    f.handlers.uninstall = async () => {
      effects.push('uninstall');
    };
    await f.client.start();
    const binding = await f.teach();
    await f.service.disable(binding.id);
    expect(await f.service.tools(f.dot.id)).toEqual([]);
    const configured = await f.service.configure(binding.id, {
      clientId: 'personal-client',
    });
    expect(configured.enabled).toBe(false);
    const enabled = await f.service.enable(binding.id);
    expect(enabled.grants).toEqual(binding.grants);
    expect(enabled.settings).toEqual({ clientId: 'personal-client' });
    const review = await f.service.review(
      f.dot.id,
      f.archive.review.descriptorUrl,
    );
    const updated = await f.service.update(binding.id, review.id);
    expect(updated.revision).toBeGreaterThan(enabled.revision);
    expect(updated.id).toBe(binding.id);
    await f.service.disconnect(binding.id);
    expect((await f.service.list(f.dot.id))[0].enabled).toBe(false);
    await f.service.forget(binding.id, false);
    expect(effects).toEqual(['disconnect', 'disconnect']);
    const next = await f.teach();
    await f.service.forget(next.id, true);
    await f.service.uninstall(binding.digest);
    expect(effects).toEqual([
      'disconnect',
      'disconnect',
      'disconnect',
      'erase',
      'uninstall',
    ]);
    expect(await f.service.list(f.dot.id)).toEqual([]);
  });
  it('does not uninstall a shared package while a reviewed installation is binding it', async () => {
    const f = await fixture();
    f.workspace.abilities.recordPackage(f.pkg);
    let entered = false,
      uninstalled = false,
      release: () => void = () => {};
    const installed = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.handlers.install = async () => {
      entered = true;
      await installed;
      return f.pkg;
    };
    f.handlers.uninstall = async () => {
      uninstalled = true;
    };
    await f.client.start();
    const teaching = f.teach();
    await expect.poll(() => entered).toBe(true);
    // Keep the installer waiting across the uninstall round trip. A correct
    // service queues uninstall until the approved binding has been recorded.
    const uninstall = f.service.uninstall(f.pkg.digest).then(
      () => 'removed',
      () => 'refused',
    );
    const timer = setTimeout(release, 100);
    try {
      await teaching;
      expect(await uninstall).toBe('refused');
      expect(uninstalled).toBe(false);
    } finally {
      clearTimeout(timer);
      release();
    }
  });
  it('refuses repeated invocation IDs and rejects owner-only payloads from the desktop', async () => {
    const f = await fixture();
    let calls = 0;
    f.handlers.invoke = async () => {
      calls++;
      return {
        status: 'success',
        visibility: 'model-visible',
        value: 'private-provider-metadata',
      };
    };
    await f.client.start();
    const binding = await f.teach();
    const input = {
      dotId: f.dot.id,
      bindingId: binding.id,
      threadId: 'thread',
      tool: 'search',
      invocationId: randomUUID(),
      arguments: { query: 'fixture' },
    };
    const first = await f.service.invoke(input, new AbortController().signal);
    expect(JSON.stringify(first)).not.toContain('private-provider-metadata');
    expect(first).toEqual({ status: 'uncertain' });
    expect(
      await f.service.invoke(input, new AbortController().signal),
    ).toMatchObject({ status: 'error' });
    expect(calls).toBe(1);
  });
  it('rejects caller-supplied invocation authority and tokenless owner Ability routes', async () => {
    const f = await fixture();
    await f.client.start();
    const binding = await f.teach();
    const response = await f.app.request(
      `/api/abilities/${binding.id}/invoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dotId: f.dot.id,
          threadId: 'thread',
          tool: 'search',
          invocationId: randomUUID(),
          arguments: { query: 'fixture' },
          context: { grantRevision: 100 },
        }),
      },
    );
    expect(response.status).toBe(400);
    const old = await fixture(null);
    expect(
      (await old.app.request(`/api/dots/${old.dot.id}/abilities`)).status,
    ).toBe(401);
    expect((await old.app.request('/api/unrelated')).status).toBe(200);
  });
});

it('validates required settings before installation and carries them through teaching and updates', async () => {
  const f = await fixture();
  await f.client.start();
  const manifest = f.archive.review.descriptor.manifest;
  manifest.settings = {
    type: 'object',
    properties: {
      ...manifest.settings.properties,
      label: { type: 'string', maxLength: 32 },
    },
    required: ['label'],
    additionalProperties: false,
  };
  f.pkg.manifest = structuredClone(manifest);
  f.pkg.descriptor = structuredClone(f.archive.review.descriptor);
  let installs = 0;
  f.handlers.install = async () => {
    installs++;
    return f.pkg;
  };
  let review = await f.service.review(f.dot.id, f.archive.review.descriptorUrl);
  await expect(f.service.teach(f.dot.id, review.id, {})).rejects.toThrow();
  expect(installs).toBe(0);
  review = await f.service.review(f.dot.id, f.archive.review.descriptorUrl);
  const binding = await f.service.teach(f.dot.id, review.id, {
    label: 'first',
  });
  expect(binding.settings).toEqual({ label: 'first' });
  review = await f.service.review(f.dot.id, f.archive.review.descriptorUrl);
  const updated = await f.service.update(binding.id, review.id, {
    label: 'second',
  });
  expect(updated.settings).toEqual({ label: 'second' });
  expect(installs).toBe(2);
});

it('blocks all new Ability admission during capture and refuses missing shutdown acknowledgement', async () => {
  const f = await fixture();
  await f.client.start();
  await f.teach();
  await expect(f.service.quiesce()).rejects.toThrow();
  let paused = false;
  f.handlers.quiesce = async () => {
    paused = true;
  };
  f.handlers.resume = async () => {
    paused = false;
  };
  const resume = await f.service.quiesce();
  expect(paused).toBe(true);
  await expect(
    f.service.review(f.dot.id, f.archive.review.descriptorUrl),
  ).rejects.toThrow();
  await resume();
  expect(paused).toBe(false);
  expect(
    await f.service.review(f.dot.id, f.archive.review.descriptorUrl),
  ).toBeDefined();
});

it('keeps deleted-Dot cleanup pending until the desktop confirms credential/state erasure', async () => {
  const f = await fixture();
  await f.client.start();
  const binding = await f.teach();
  (f.workspace as unknown as { db: import('node:sqlite').DatabaseSync }).db
    .prepare('DELETE FROM dots WHERE id=?')
    .run(f.dot.id);
  f.handlers.eraseState = async () => {
    throw new Error('offline');
  };
  await expect(f.service.cleanup()).rejects.toThrow();
  expect(f.workspace.abilities.pendingCleanup()).toEqual([binding.id]);
  let erased: string | undefined;
  f.handlers.eraseState = async (id) => {
    erased = id;
  };
  await f.service.cleanup();
  expect(erased).toBe(binding.id);
  expect(f.workspace.abilities.pendingCleanup()).toEqual([]);
});
