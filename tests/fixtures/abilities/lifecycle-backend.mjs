import process from 'node:process';
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
app.route('/ability-host/v1', bridge.routes(config.ownerToken));
app.post('/api/abilities/:id/configure', async (c) => {
  config.binding.settings = (await c.req.json()).settings;
  config.binding.revision++;
  return c.json(config.binding);
});
app.post('/api/abilities/cleanup', (c) => c.json({ ok: true }));
app.get('/api/abilities/:id', (c) => c.json(config.binding));
app.get('/api/dots/:id/abilities', (c) =>
  c.json({ bindings: [config.binding] }),
);
app.get('/alive', (c) =>
  c.json({ alive: true, attached: Boolean(bridge.session()) }),
);
app.post('/invoke', async (c) => {
  const { op } = await c.req.json();
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
            invocationId: randomUUID(),
            threadId: 'thread',
            tool: 'run',
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
