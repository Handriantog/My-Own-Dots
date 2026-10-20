import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Platform } from './platform.js';
import {
  memoryScopeSchema,
  memoryKindSchema,
  memoryStatusSchema,
  memorySettingsPatchSchema,
  type MemoryScope,
} from '../shared/memory.js';
const idSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const revision = z.number().int().positive();
const empty = z.object({}).strict();
const editable = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    text: z.string().trim().min(1).max(12000).optional(),
    pinned: z.boolean().optional(),
    expiresAt: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
async function body<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<z.output<T>> {
  return schema.parse(await c.req.json().catch(() => null));
}
export function memoryRoutes(platform: Platform): Hono {
  const app = new Hono(),
    service = platform.memory!;
  const memory = platform.workspace.memory;
  const id = (c: Context) => idSchema.parse(c.req.param('id'));
  const dot = async (c: Context) => {
    const value = id(c);
    if (!(await platform.workspace.dot(value)))
      throw new HTTPException(404, { message: 'Dot not found.' });
    return value;
  };
  const item = async (c: Context) => {
    const value = await memory.get(id(c));
    if (!value) throw new HTTPException(404, { message: 'Memory not found.' });
    return value;
  };
  const scope = async (value: MemoryScope) => {
    if (
      (value.kind === 'dot' && !(await platform.workspace.dot(value.id))) ||
      (value.kind === 'space' &&
        !(await platform.workspace.spaces()).some((s) => s.id === value.id))
    )
      throw new HTTPException(404, { message: 'Memory scope not found.' });
    return value;
  };
  const receipt = async (c: Context) => {
    const value = await memory.history.receipt(id(c));
    if (!value)
      throw new HTTPException(404, { message: 'Memory change set not found.' });
    return value;
  };
  app.onError((error, c) => {
    if (error instanceof HTTPException)
      return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return c.json({ error: 'Invalid memory request.' }, 400);
    if (/revision|conflict|preview/i.test(error.message))
      return c.json(
        {
          error:
            'Memory changed or the restore preview expired. Refresh and try again.',
        },
        409,
      );
    if (
      /not found|not bound|unknown dot|unknown space|does not belong/i.test(
        error.message,
      )
    )
      return c.json({ error: 'Memory resource not found.' }, 404);
    if (/disabled|paused|access/i.test(error.message))
      return c.json(
        { error: 'Memory access is disabled or the workspace is paused.' },
        403,
      );
    if (
      /capacity|budget|awaiting review|evidence|sources|pin/i.test(
        error.message,
      )
    )
      return c.json(
        {
          error:
            'This change cannot be applied with the current evidence or memory limits.',
        },
        409,
      );
    return c.json(
      {
        error: 'Memory storage is unavailable. Your saved history is retained.',
      },
      503,
    );
  });
  app.get('/memory-items', async (c) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().regex(/^\d+$/).optional(),
        kind: memoryKindSchema.optional(),
        status: memoryStatusSchema.optional(),
        scopeKind: z.enum(['owner', 'dot', 'space']).optional(),
        scopeId: idSchema.optional(),
      })
      .strict()
      .parse(c.req.query());
    const selected = q.scopeKind
      ? await scope(
          memoryScopeSchema.parse(
            q.scopeKind === 'owner'
              ? { kind: 'owner' }
              : { kind: q.scopeKind, id: q.scopeId },
          ),
        )
      : undefined;
    return c.json(
      await memory.listOwner({
        limit: q.limit,
        cursor: q.cursor,
        kind: q.kind,
        status: q.status,
        scope: selected,
      }),
    );
  });
  app.post('/memory-items', async (c) => {
    const input = await body(
      c,
      editable
        .required({ title: true, text: true })
        .extend({ kind: memoryKindSchema.optional(), scope: memoryScopeSchema })
        .strict(),
    );
    return c.json(
      await memory.create({ ...input, scope: await scope(input.scope) }),
      201,
    );
  });
  app.get('/memory-items/:id', async (c) => {
    const found = await item(c);
    const sources = await Promise.all(
      found.sources.map(async (ref) => ({
        ref,
        text: (await service.repository.readSource(ref))?.text ?? null,
      })),
    );
    return c.json({
      item: found,
      revisions: await memory.revisions(found.id),
      sources,
    });
  });
  app.patch('/memory-items/:id', async (c) => {
    const found = await item(c),
      input = await body(
        c,
        z.object({ expectedRevision: revision, patch: editable }).strict(),
      );
    return c.json(
      await memory.edit(found.id, input.expectedRevision, input.patch),
    );
  });
  app.post('/memory-items/:id/review', async (c) => {
    const found = await item(c),
      input = await body(
        c,
        z
          .object({
            expectedRevision: revision,
            decision: z.enum(['approve', 'reject']),
          })
          .strict(),
      );
    return c.json(
      await service.publication.review(
        found.id,
        input.expectedRevision,
        input.decision,
      ),
    );
  });
  app.post('/memory-items/:id/forget', async (c) => {
    const found = await item(c),
      input = await body(c, z.object({ expectedRevision: revision }).strict());
    service.publication.forget(found.id, input.expectedRevision);
    return c.json({ ok: true });
  });
  app.post('/memory-items/:id/share', async (c) => {
    const found = await item(c),
      input = await body(
        c,
        z
          .object({ expectedRevision: revision, scope: memoryScopeSchema })
          .strict(),
      );
    return c.json(
      await service.publication.share(
        found.id,
        input.expectedRevision,
        await scope(input.scope),
      ),
    );
  });
  app.get('/dots/:id/memory-settings', async (c) =>
    c.json(await memory.settings(await dot(c))),
  );
  app.put('/dots/:id/memory-settings', async (c) => {
    const dotId = await dot(c),
      input = await body(
        c,
        z
          .object({
            expectedRevision: revision,
            patch: memorySettingsPatchSchema,
          })
          .strict(),
      );
    return c.json(
      await service.updateSettings(dotId, input.expectedRevision, input.patch),
    );
  });
  app.post('/conversations/:id/compact', async (c) => {
    await body(c, empty);
    return c.json(await service.requestCompact(id(c)), 202);
  });
  app.post('/dots/:id/dream', async (c) => {
    const dotId = await dot(c),
      input = await body(
        c,
        z
          .object({
            selectedThreadIds: z.array(idSchema).min(1).max(100).optional(),
          })
          .strict(),
      );
    return c.json(
      await service.requestDream(dotId, input.selectedThreadIds),
      202,
    );
  });
  app.get('/dots/:id/memory-jobs', async (c) => {
    const dotId = await dot(c);
    return c.json({
      ...(await service.status(dotId)),
      changes: await memory.history.receipts(dotId),
    });
  });
  app.get('/memory-changes/:id', async (c) => c.json(await receipt(c)));
  app.post('/memory-changes/:id/restore-preview', async (c) => {
    await body(c, empty);
    return c.json(service.publication.previewRestore((await receipt(c)).id));
  });
  app.post('/memory-changes/:id/restore', async (c) => {
    const changeId = id(c),
      input = await body(
        c,
        z
          .object({
            previewId: idSchema,
            expectedRevisions: z.record(idSchema, revision),
          })
          .strict(),
      );
    const preview = await memory.history.preview(input.previewId);
    if (!preview || preview.changeSetId !== changeId)
      throw new HTTPException(409, {
        message: 'Restore preview does not match this change set.',
      });
    return c.json(
      service.publication.restore(input.previewId, input.expectedRevisions),
    );
  });
  return app;
}
