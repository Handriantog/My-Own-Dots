import type { WorkspaceRepository } from './storage/runtime-repositories.js';
import type { ConversationRepository } from './local-conversations.js';

/** Called only after authentication and validateRuntimeScope. */
export async function localThreadResponse(
  request: Request,
  body: unknown,
  storage: ConversationRepository,
  workspace: WorkspaceRepository,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.slice('/api/copilotkit/'.length);
  if (path === 'threads' && request.method === 'GET') {
    const bound = new Set(
      (await workspace.conversations()).map((thread) => thread.id),
    );
    const threads = (
      await storage.listThreads(url.searchParams.get('agentId') ?? undefined)
    ).filter((thread) => bound.has(thread.id));
    return Response.json({ threads, nextCursor: null });
  }
  const inspect = path.match(/^threads\/([^/]+)\/(messages|events|state)$/);
  if (inspect && request.method === 'GET') {
    const threadId = decodeURIComponent(inspect[1]);
    const kind = inspect[2];
    if (kind === 'messages')
      return Response.json(
        await storage.getThreadMessages({
          threadId,
          userId: workspace.ownerId,
        }),
      );
    if (kind === 'events')
      return Response.json({ events: await storage.getEvents(threadId) });
    return Response.json({ state: await storage.getState(threadId) });
  }
  if (path.startsWith('threads/')) {
    return Response.json(
      { error: 'Managed thread metadata is unavailable in local mode.' },
      { status: 405 },
    );
  }
  if (
    /^agent\/[^/]+\/(run|connect)$/.test(path) &&
    body &&
    typeof body === 'object' &&
    'threadId' in body &&
    typeof body.threadId === 'string'
  ) {
    const thread = await workspace.requireThread(body.threadId);
    await storage.getOrCreateThread({
      threadId: thread.id,
      userId: workspace.ownerId,
      agentId: thread.dotId,
      name: thread.title,
    });
  }
  return undefined;
}
