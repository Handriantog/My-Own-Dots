import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { failureCode } from '../../shared/abilities/bridge.js';
import {
  assertBoundedJson,
  abilityLimits,
} from '../../shared/abilities/limits.js';
import type { JsonValue } from '../../shared/abilities/types.js';
import type { AbilityService } from './service.js';

const id = z.string().min(1).max(256);
const values = z.record(
  z.string().max(64),
  z.custom<JsonValue>((value) => {
    try {
      assertBoundedJson(value, abilityLimits.frameBytes);
      return true;
    } catch {
      return false;
    }
  }),
);
/** Mounted behind createApp's owner authentication; tokenless legacy apps are denied here too. */
export function abilityRoutes(
  service: AbilityService,
  authenticated: boolean,
): Hono {
  const guarded = new Hono();
  const authenticate: MiddlewareHandler = async (c, next) => {
    if (!authenticated) return c.json({ error: 'setup_needed' }, 401);
    await next();
  };
  guarded.use('/abilities/*', authenticate);
  guarded.use('/dots/:dotId/abilities', authenticate);
  guarded.use('/dots/:dotId/abilities/*', authenticate);
  guarded.onError((error, c) => c.json({ error: failureCode(error) }, 400));
  guarded.get('/dots/:dotId/abilities', async (c) =>
    c.json({ bindings: await service.list(c.req.param('dotId')) }),
  );
  guarded.post('/dots/:dotId/abilities/review', async (c) => {
    const body = z
      .strictObject({ url: z.string().min(1).max(2048) })
      .parse(await c.req.json());
    return c.json(await service.review(c.req.param('dotId'), body.url));
  });
  guarded.post('/dots/:dotId/abilities/teach', async (c) => {
    const body = z
      .strictObject({ reviewId: z.uuid() })
      .parse(await c.req.json());
    return c.json(await service.teach(c.req.param('dotId'), body.reviewId));
  });
  for (const action of ['enable', 'disable', 'disconnect'] as const)
    guarded.post(`/abilities/:id/${action}`, async (c) => {
      z.strictObject({}).parse(await c.req.json());
      return c.json(
        (await service[action](z.uuid().parse(c.req.param('id')))) ?? {
          ok: true,
        },
      );
    });
  guarded.post('/abilities/:id/update', async (c) => {
    const body = z
      .strictObject({ reviewId: z.uuid() })
      .parse(await c.req.json());
    return c.json(
      await service.update(z.uuid().parse(c.req.param('id')), body.reviewId),
    );
  });
  guarded.post('/abilities/:id/configure', async (c) => {
    const body = z.strictObject({ settings: values }).parse(await c.req.json());
    return c.json(
      await service.configure(z.uuid().parse(c.req.param('id')), body.settings),
    );
  });
  guarded.post('/abilities/:id/forget', async (c) => {
    const body = z
      .strictObject({ eraseState: z.boolean() })
      .parse(await c.req.json());
    await service.forget(z.uuid().parse(c.req.param('id')), body.eraseState);
    return c.json({ ok: true });
  });
  guarded.post('/abilities/packages/:digest/uninstall', async (c) => {
    z.strictObject({}).parse(await c.req.json());
    await service.uninstall(
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(c.req.param('digest')),
    );
    return c.json({ ok: true });
  });
  guarded.post('/abilities/:id/invoke', async (c) => {
    const body = z
      .strictObject({
        dotId: id,
        threadId: id,
        tool: id,
        invocationId: z.uuid(),
        arguments: values,
        selectionRef: z.uuid().optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.invoke(
        { ...body, bindingId: z.uuid().parse(c.req.param('id')) },
        c.req.raw.signal,
      ),
    );
  });
  // Register only the concrete paths; do not place Ability middleware in front
  // of unrelated legacy APIs mounted on the same /api prefix.
  return guarded;
}
