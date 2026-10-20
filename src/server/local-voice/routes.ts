import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { LocalVoiceService } from './service.js';
import { voiceSettingsSchema } from '../../shared/voice-settings.js';
const control = z.discriminatedUnion('action', [
  z.object({ action: z.literal('heartbeat') }).strict(),
  z.object({ action: z.literal('end') }).strict(),
  z.object({ action: z.literal('interrupt') }).strict(),
  z.object({ action: z.literal('mute'), value: z.boolean() }).strict(),
  z.object({ action: z.literal('speaker'), value: z.boolean() }).strict(),
  z
    .object({ action: z.literal('answer'), messageId: z.string().uuid() })
    .strict(),
  z
    .object({
      action: z.literal('played'),
      generation: z.number().int().min(0),
      sequence: z.number().int().min(0),
      samples: z.number().int().min(1).max(960),
    })
    .strict(),
]);
export function localVoiceRoutes(service?: LocalVoiceService) {
  const app = new Hono();
  app.onError((_error, c) =>
    c.json(
      { error: 'The voice call is unavailable or the request was rejected.' },
      400,
    ),
  );
  app.use(
    '/local-voice/*',
    bodyLimit({
      maxSize: 8192,
      onError: (c) => c.json({ error: 'Voice request is too large.' }, 413),
    }),
  );
  app.get('/local-voice/status', async (c) =>
    c.json(
      service
        ? await service.status()
        : { enabled: false, ready: false, reason: 'Local voice is disabled.' },
    ),
  );
  app.use('/local-voice/*', async (c, next) => {
    if (!service) return c.json({ error: 'Local voice is disabled.' }, 503);
    // The desktop speech transport is never exposed on an external hostname.
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname)
    )
      return c.json(
        { error: 'Local voice requires a loopback workspace.' },
        403,
      );
    await next();
  });
  app.get('/local-voice/dots/:id/settings', async (c) =>
    c.json(await service!.settings(c.req.param('id'))),
  );
  app.put('/local-voice/dots/:id/settings', async (c) =>
    c.json(
      await service!.saveSettings(
        c.req.param('id'),
        voiceSettingsSchema.parse(await c.req.json()),
      ),
    ),
  );
  app.post('/local-voice/dots/:id/preview', async (c) => {
    const wav = await service!.preview(
      c.req.param('id'),
      voiceSettingsSchema.parse(await c.req.json()),
      c.req.raw.signal,
    );
    return c.body(new Uint8Array(wav), 200, {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
    });
  });
  app.post('/local-voice/calls', async (c) => {
    const input = z
      .object({
        threadId: z.string().uuid(),
        dotId: z.string().min(1).max(100),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!input.success)
      return c.json({ error: 'Select a valid conversation and Dot.' }, 400);
    return c.json(
      await service!.start(
        input.data.threadId,
        input.data.dotId,
        c.req.raw.signal,
      ),
      201,
    );
  });
  app.get('/local-voice/calls/:id/events', async (c) => {
    const call = await service!.require(
      c.req.param('id'),
      c.req.header('x-dot-voice-token'),
    );
    await call.touch();
    if (call.connected) throw Error('Call already has an event stream');
    return streamSSE(c, async (stream) => {
      let finish: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
      const abortStream = () => {
        stream.abort();
        finish();
      };
      const onCallEnd = () => {
        // Allow the final event to drain, but never depend on a responsive reader.
        if (!shutdownDeadline) {
          shutdownDeadline = setTimeout(abortStream, 1000);
          shutdownDeadline.unref?.();
        }
      };
      const detach = call.listen(async (event) => {
        await stream.writeSSE({ data: JSON.stringify(event) });
        if (event.type === 'ended') finish();
      });
      stream.onAbort(() => {
        detach();
        finish();
      });
      call.endSignal.addEventListener('abort', onCallEnd, { once: true });
      c.req.raw.signal.addEventListener('abort', abortStream, { once: true });
      if (call.endSignal.aborted) onCallEnd();
      if (c.req.raw.signal.aborted) abortStream();
      try {
        await done;
      } finally {
        clearTimeout(shutdownDeadline);
        call.endSignal.removeEventListener('abort', onCallEnd);
        c.req.raw.signal.removeEventListener('abort', abortStream);
        detach();
      }
    });
  });
  app.post('/local-voice/calls/:id/frame', async (c) => {
    const call = await service!.require(
      c.req.param('id'),
      c.req.header('x-dot-voice-token'),
    );
    const input = z
      .object({
        sequence: z.number().int().min(0),
        pcm: z.string().length(1368),
      })
      .strict()
      .parse(await c.req.json());
    const pcm = Buffer.from(input.pcm, 'base64');
    if (pcm.toString('base64') !== input.pcm || pcm.length !== 1024)
      throw Error();
    try {
      await call.frame(input.sequence, pcm);
    } catch (error) {
      await call.end('Audio input was interrupted. Start a new call to retry.');
      throw error;
    }
    return c.json({ ok: true });
  });
  app.post('/local-voice/calls/:id/control', async (c) => {
    const input = control.parse(await c.req.json());
    const call = await service!.require(
      c.req.param('id'),
      c.req.header('x-dot-voice-token'),
      { allowEnded: input.action === 'end' },
    );
    switch (input.action) {
      case 'heartbeat':
        await call.touch();
        break;
      case 'end':
        await call.end();
        break;
      case 'interrupt':
        await call.interrupt();
        break;
      case 'mute':
        await call.mute(input.value);
        break;
      case 'speaker':
        await call.speaker(input.value);
        break;
      case 'answer':
        await call.answer(input.messageId);
        break;
      case 'played':
        await call.played(input.generation, input.sequence, input.samples);
        break;
    }
    return c.json({ ok: true });
  });
  return app;
}
