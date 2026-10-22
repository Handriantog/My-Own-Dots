import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';

export function messageMarkRoutes(
  platform: Pick<Platform, 'workspace' | 'localConversations' | 'intelligence'>,
) {
  const app = new Hono();
  app.get('/message-marks', async (c) =>
    c.json(await platform.workspace.messageMarks()),
  );
  app.put('/conversations/:id/messages/:messageId/marks', async (c) => {
    const parsed = z
      .object({ kind: z.enum(['pin', 'bookmark']), active: z.boolean() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Choose a valid message action.' }, 400);
    const threadId = c.req.param('id');
    const messageId = c.req.param('messageId');
    await platform.workspace.requireThread(threadId);
    // Removal still works when the original message is no longer available.
    if (!parsed.data.active) {
      return c.json(
        await platform.workspace.setMessageMark(
          threadId,
          { id: messageId, role: 'user', content: '' },
          parsed.data.kind,
          false,
        ),
      );
    }
    const source = platform.localConversations ?? platform.intelligence;
    if (!source)
      return c.json({ error: 'Conversation storage is unavailable.' }, 503);
    const history = await source.getThreadMessages({
      threadId,
      userId: platform.workspace.ownerId,
    });
    const message = history.messages.find((item) => item.id === messageId);
    if (
      !message ||
      !['user', 'assistant'].includes(message.role) ||
      typeof message.content !== 'string' ||
      !message.content.trim() ||
      message.id.startsWith(voiceReceiptMessagePrefix)
    )
      return c.json(
        {
          error:
            'This message is not saved yet or is no longer available. Try again after the response finishes.',
        },
        404,
      );
    return c.json(
      await platform.workspace.setMessageMark(
        threadId,
        {
          id: message.id,
          role: message.role as 'user' | 'assistant',
          content: message.content,
        },
        parsed.data.kind,
        true,
      ),
    );
  });
  return app;
}
