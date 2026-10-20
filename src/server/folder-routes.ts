import type { FolderRepository } from './storage/runtime-repositories.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isIP } from 'node:net';
import { z } from 'zod';
import { FolderAccessError } from './folder-access.js';
import { folderDecisionSchema } from '../shared/folder-access.js';

const selectionSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => !path.includes('\0')),
  })
  .strict();

function loopbackPeer(address: string) {
  if (address === '::1') return true;
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}

/** Mounted beneath createApp's owner authentication and origin/host guards. */
export function folderRoutes(folders: FolderRepository) {
  const app = new Hono();
  const requests = '/conversations/:threadId/folder-requests/:requestId';
  for (const path of [
    requests,
    `${requests}/*`,
    '/dots/:dotId/folder-grants',
    '/dots/:dotId/folder-grants/*',
  ]) {
    app.use(path, async (c, next) => {
      // Node's actual socket peer cannot be replaced by a spoofed Host header.
      // In-process fetches (e.g. app.request) have no network binding.
      const incoming = (
        c.env as
          { incoming?: { socket?: { remoteAddress?: string } } } | undefined
      )?.incoming;
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(c.req.url).hostname,
        ) ||
        (incoming && !loopbackPeer(incoming.socket?.remoteAddress ?? ''))
      ) {
        return c.json(
          { error: 'Local folder access requires a loopback connection.' },
          403,
        );
      }
      await next();
    });
  }
  const limit = bodyLimit({
    maxSize: 16384,
    onError: (c) => c.json({ error: 'Folder request is too large.' }, 413),
  });
  app.get(requests, async (c) =>
    c.json(
      await folders.getRequest(
        c.req.param('threadId'),
        c.req.param('requestId'),
      ),
    ),
  );
  app.post(`${requests}/selection`, limit, async (c) => {
    const input = selectionSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      return c.json({ error: 'Choose a valid local folder.' }, 400);
    return c.json(
      await folders.select(
        c.req.param('threadId'),
        c.req.param('requestId'),
        input.data.path,
      ),
    );
  });
  app.post(`${requests}/decision`, limit, async (c) => {
    const input = folderDecisionSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      return c.json({ error: 'Enter a valid folder approval decision.' }, 400);
    return c.json(
      await folders.decide(
        c.req.param('threadId'),
        c.req.param('requestId'),
        input.data,
      ),
    );
  });
  app.get('/dots/:dotId/folder-grants', async (c) =>
    c.json(await folders.list(c.req.param('dotId'))),
  );
  app.delete('/dots/:dotId/folder-grants/:grantId', async (c) =>
    c.json(await folders.revoke(c.req.param('dotId'), c.req.param('grantId'))),
  );
  app.onError((error, c) => {
    if (error instanceof FolderAccessError)
      return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return c.json({ error: 'Invalid folder request.' }, 400);
    return c.json({ error: 'Local folder operation could not complete.' }, 503);
  });
  return app;
}
