import process from 'node:process';
import { setTimeout } from 'node:timers';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { AbilityHostBridge } from '../../../src/server/abilities/host-bridge.ts';
import { randomUUID } from 'node:crypto';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const bridge = new AbilityHostBridge(config.workspaceId);
bridge.setAuthority(async () => ({
  binding: config.binding,
  package: config.package,
}));
const app = new Hono();
let pairs = 0;
let master = true;
let lastInvocation;
app.post('/cancel-invocation', async (c) => {
  await bridge.cancel(lastInvocation);
  return c.json({ ok: true });
});
app.post('/master-off', (c) => {
  master = false;
  return c.json({ ok: true });
});
app.use('/ability-host/v1/pair', async (_c, next) => {
  pairs++;
  await next();
});
app.route('/ability-host/v1', bridge.routes(config.ownerToken));
app.post('/api/abilities/:id/configure', async (c) => {
  config.binding.settings = (await c.req.json()).settings;
  config.binding.revision++;
  return c.json(config.binding);
});
app.post('/api/abilities/cleanup', async (c) => {
  if (config.interruptCleanup) {
    config.interruptCleanup = false;
    await bridge.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return c.json({ ok: true });
});
app.get('/api/abilities/catalog', (c) =>
  c.json({
    installations: [
      {
        digest: config.binding.digest,
        manifest: config.binding.manifest,
        enabled: true,
        restored: false,
        settings: {},
        enabledDots: 1,
      },
    ],
  }),
);
app.get('/api/abilities/:id', (c) => c.json(config.binding));
app.get('/api/dots/:id/abilities', (c) =>
  c.json({
    bindings: [config.binding],
    installed: [
      {
        digest: config.binding.digest,
        manifest: config.binding.manifest,
        enabled: master,
        restored: false,
        settings: {},
        enabledDots: 1,
      },
    ],
  }),
);
app.get('/alive', (c) =>
  c.json({
    alive: true,
    attached: Boolean(bridge.session()),
    sessionId: bridge.session()?.id,
    pairs,
  }),
);
app.post('/disconnect', async (c) => {
  await bridge.stop();
  return c.json({ ok: true });
});
app.post('/invoke', async (c) => {
  const { op, interactive } = await c.req.json();
  lastInvocation = randomUUID();
  try {
    return c.json(
      await bridge.invoke(
        {
          context: {
            workspaceId: config.workspaceId,
            sessionId: bridge.session()?.id ?? '',
            bindingId: config.binding.id,
            dotId: config.binding.dotId,
            digest: config.binding.digest,
            grantRevision: config.binding.revision,
            invocationId: lastInvocation,
            threadId: 'thread',
            tool: 'run',
            ...(interactive === true ? { interactive: true } : {}),
          },
          arguments: { op },
          settings: config.binding.settings,
        },
        c.req.raw.signal,
      ),
    );
  } catch {
    return c.json({ status: 'uncertain' });
  }
});
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await once(server, 'listening');
process.send({
  ...config,
  url: `http://127.0.0.1:${server.address().port}`,
  owned: false,
});
process.on('SIGTERM', async () => {
  await bridge.stop();
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
