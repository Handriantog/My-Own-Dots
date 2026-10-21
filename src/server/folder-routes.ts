import type { FolderRepository } from './storage/runtime-repositories.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isIP } from 'node:net';
import { z } from 'zod';
import { FolderAccessError } from './folder-access.js';
import type { Platform } from './platform.js';
import type { ConversationSnapshot } from './local-conversations.js';
import { voiceDelegationActive } from '../shared/voice-delegation.js';
import {
  folderApprovalSchema,
  folderApprovalTool,
  folderDecisionSchema,
  type FolderApprovalPending,
} from '../shared/folder-access.js';

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

function pendingFolderReviews(snapshot: ConversationSnapshot) {
  const pending = new Map<string, string[]>();
  // A human approval pause is a successfully finished run. Never surface
  // a partial call from a running, stopped, failed, or interrupted task.
  if (snapshot.lastRun?.status !== 'finished') return pending;
  const answered = new Set(
    snapshot.messages.flatMap((message) =>
      message.role === 'tool' ? [message.toolCallId] : [],
    ),
  );
  for (const message of snapshot.messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      if (
        call.function.name !== folderApprovalTool.name ||
        answered.has(call.id)
      )
        continue;
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        continue;
      }
      const parsed = folderApprovalSchema.safeParse(args);
      if (!parsed.success) continue;
      const calls = pending.get(parsed.data.requestId) ?? [];
      calls.push(call.id);
      pending.set(parsed.data.requestId, calls);
    }
  }
  return pending;
}

/** Mounted beneath createApp's owner authentication and origin/host guards. */
export function folderRoutes(
  folders: FolderRepository,
  context?: Pick<
    Platform,
    'workspace' | 'localConversations' | 'voiceDelegations'
  >,
) {
  const app = new Hono();
  const requests = '/conversations/:threadId/folder-requests/:requestId';
  for (const path of [
    '/folder-approvals',
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
  app.get('/folder-approvals', async (c) => {
    const conversations = context?.localConversations;
    const workspace = context?.workspace;
    const approvals: FolderApprovalPending[] = [];
    if (!conversations || !workspace) return c.json(approvals);
    if (conversations.ownerId !== workspace.ownerId)
      return c.json({ error: 'Conversation owner does not match.' }, 403);
    const reviews = new Map<string, Map<string, string[]>>();
    const threads = new Map<string, string | undefined>();
    const dots = new Map<string, Awaited<ReturnType<typeof workspace.dot>>>();
    for (const request of await folders.reviewRequests()) {
      if (!threads.has(request.threadId)) {
        try {
          threads.set(
            request.threadId,
            (await workspace.requireThread(request.threadId)).dotId,
          );
        } catch {
          threads.set(request.threadId, undefined);
        }
      }
      if (threads.get(request.threadId) !== request.dotId) continue;
      if (!dots.has(request.dotId))
        dots.set(request.dotId, await workspace.dot(request.dotId));
      const dot = dots.get(request.dotId);
      if (!dot) continue;
      if (!reviews.has(request.threadId)) {
        const job = await context?.voiceDelegations?.forThread(
          request.threadId,
        );
        if (
          job &&
          (!voiceDelegationActive(job.status) ||
            job.dotId !== request.dotId ||
            job.ownerId !== workspace.ownerId)
        ) {
          // Cancelling an already-paused task leaves its last run finished.
          reviews.set(request.threadId, new Map());
          continue;
        }
        try {
          reviews.set(
            request.threadId,
            pendingFolderReviews(
              await conversations.getSnapshot(request.threadId),
            ),
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== 'Conversation not found.'
          )
            throw error;
          reviews.set(request.threadId, new Map());
        }
      }
      const calls = reviews.get(request.threadId)?.get(request.requestId);
      // One card per request; replay a saved decision only to its original call.
      const toolCallId = request.toolCallId
        ? calls?.find((id) => id === request.toolCallId)
        : calls?.[0];
      if (!toolCallId) continue;
      approvals.push({
        requestId: request.requestId,
        threadId: request.threadId,
        dotId: dot.id,
        dotName: dot.name,
        toolCallId,
      });
      // Cap verified pending approvals, never historical candidate rows: old
      // unanswered requests must not be displaced by newer answered reviews.
      if (approvals.length === 100) break;
    }
    return c.json(approvals);
  });
  app.get(requests, async (c) =>
    c.json(
      await folders.getRequest(
        c.req.param('threadId'),
        c.req.param('requestId'),
      ),
    ),
  );
  app.post(`${requests}/resolve`, limit, async (c) => {
    const input = z
      .object({})
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json(
        { error: 'Folder resolution uses the saved request only.' },
        400,
      );
    return c.json(
      await folders.resolve(c.req.param('threadId'), c.req.param('requestId')),
    );
  });
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
