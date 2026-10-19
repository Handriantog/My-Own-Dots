import type { WorkspaceDestination } from '../shared/workspace-contract.js';

export function destination(value: unknown): WorkspaceDestination {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid workspace destination');
  const result: WorkspaceDestination = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      !['dotId', 'threadId', 'spaceId', 'pageId'].includes(key) ||
      (item !== undefined &&
        (typeof item !== 'string' || !/^[\w-]{1,128}$/.test(item)))
    )
      throw new Error('Invalid workspace destination');
    if (item !== undefined)
      result[key as keyof WorkspaceDestination] = item as string;
  }
  if (
    (result.threadId && !result.dotId) ||
    (result.pageId && !result.spaceId) ||
    (result.dotId && result.spaceId)
  )
    throw new Error('Invalid workspace destination');
  return result;
}
/** Internal popup links are routed as guarded renderer navigation, never reloaded. */
export function destinationFromUrl(
  value: string,
): WorkspaceDestination | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'dots:' ||
      url.host !== 'workspace' ||
      url.pathname !== '/' ||
      url.username ||
      url.password
    )
      return;
    const parts = url.hash
      .slice(1)
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    if (parts[0] === 'chat' && parts.length >= 2 && parts.length <= 3)
      return destination({
        dotId: parts[1],
        ...(parts[2] ? { threadId: parts[2] } : {}),
      });
    if (parts[0] === 'spaces' && parts.length === 4 && parts[2] === 'pages')
      return destination({ spaceId: parts[1], pageId: parts[3] });
  } catch {
    /* Ignore malformed or external destinations. */
  }
}
