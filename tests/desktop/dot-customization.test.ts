import { expect, it } from 'vitest';
import { Hono } from 'hono';
import { WorkspaceStore } from '../../src/server/workspace.js';
import { DesktopDots } from '../../src/desktop/host/desktop-dots.js';
import { DEFAULT_PREFERENCES } from '../../src/desktop/host/preferences.js';

it('keeps inactive edits off the desktop, serializes switches and persists the last selection', async () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const a = store.dots()[0];
  const b = store.createDot(
    a.spaceId,
    'Scout',
    'Research carefully',
    true,
    true,
  );
  const app = new Hono();
  app.get('/api/desktop-dot', (c) => c.json(store.desktopDot()));
  app.post('/api/desktop-dot/initialize', async (c) =>
    c.json(store.initializeDotCustomization(await c.req.json())),
  );
  app.put('/api/desktop-dot', async (c) =>
    c.json(store.selectDesktopDot((await c.req.json()).dotId)),
  );
  app.patch('/api/dots/:id/customization', async (c) =>
    c.json(store.setDotCustomization(c.req.param('id'), await c.req.json())),
  );
  const connection = {
    url: 'http://localhost:4310',
    ownerToken: 'test-token',
    owned: false,
  };
  let selected: string | null = null;
  const controller = new DesktopDots(
    () => connection,
    DEFAULT_PREFERENCES,
    (state) => {
      selected = state?.dotId ?? null;
    },
    ((url: URL, options: RequestInit) =>
      app.request(url.href, options)) as typeof fetch,
  );
  try {
    await controller.sync();
    expect(selected).toBe(a.id);
    await controller.update(b.id, { color: '#aa33ff', muted: true });
    expect(selected).toBe(a.id);
    expect(
      controller.current?.dots.find((dot) => dot.id === a.id)?.customization
        .color,
    ).toBe('#45a7ff');
    await Promise.all([
      controller.select(b.id),
      controller.select(a.id),
      controller.select(b.id),
    ]);
    expect(selected).toBe(b.id);
    expect(store.desktopDot().dotId).toBe(b.id);
    expect(
      controller.current?.dots.find((dot) => dot.id === b.id)?.customization,
    ).toMatchObject({ color: '#aa33ff', muted: true });
  } finally {
    store.close();
  }
});
