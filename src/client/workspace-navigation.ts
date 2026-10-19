import type { WorkspaceState } from '../shared/types';
import type { WorkspaceDestination } from '../desktop/shared/workspace-contract';
export type Surface = 'workspace' | 'companion';
export type WorkspaceView =
  'chat' | 'space' | 'tasks' | 'memories' | 'settings';
export function surfaceFromSearch(search: string): Surface {
  const params = new URLSearchParams(search);
  return params.get('surface') === 'companion' ||
    (!params.has('surface') && params.get('desktop') === '1')
    ? 'companion'
    : 'workspace';
}
/** Only an explicit host configuration transition resets saved identities. */
export function resetNavigationForConfiguration() {
  const params = new URLSearchParams(location.search);
  const resetId = params.get('resetNavigation');
  if (!resetId) return false;
  try {
    if (localStorage.getItem('workspace-configuration-reset') !== resetId) {
      // Include dormant surfaces and legacy selections before any renderer can restore them.
      for (const surface of ['workspace', 'companion', 'desktop'])
        for (const key of ['dot', 'thread', 'navigation'])
          localStorage.setItem(`${surface}-${key}`, '');
      localStorage.setItem('workspace-configuration-reset', resetId);
    }
  } catch {
    /* A fresh document also starts empty when storage is unavailable. */
  }
  params.delete('resetNavigation');
  history.replaceState(
    null,
    '',
    `${location.pathname}${params.size ? `?${params}` : ''}`,
  );
  return true;
}
export function restoreSelection(
  surface: Surface,
  get: (key: string) => string | null | undefined,
) {
  return {
    dotId:
      get(`${surface}-dot`) ??
      (surface === 'companion' ? get('desktop-dot') : '') ??
      '',
    threadId:
      (get(`${surface}-thread`) ??
        (surface === 'companion' ? get('desktop-thread') : '')) ||
      undefined,
  };
}
export function allowNavigation(
  dirty: boolean,
  confirm: () => boolean,
  commit: () => void,
): boolean {
  if (dirty && !confirm()) return false;
  commit();
  return true;
}
export interface NavigationItem {
  id: string;
  label: string;
  detail: string;
  view: WorkspaceView;
  destination?: WorkspaceDestination;
}
export function navigationItems(
  workspace: WorkspaceState,
  query = '',
): NavigationItem[] {
  const items: NavigationItem[] = [
    ...(
      ['chat', 'space', 'tasks', 'memories', 'settings'] as WorkspaceView[]
    ).map((view, i) => ({
      id: view,
      view,
      label: ['Chats', 'Spaces', 'Activity', 'Memory', 'Settings'][i],
      detail: 'Workspace',
    })),
    ...workspace.dots.map((dot) => ({
      id: `dot:${dot.id}`,
      label: dot.name,
      detail: 'Dot',
      view: 'chat' as const,
      destination: { dotId: dot.id },
    })),
    ...workspace.spaces.map((space) => ({
      id: `space:${space.id}`,
      label: space.name,
      detail: 'Space',
      view: 'space' as const,
      destination: { spaceId: space.id },
    })),
    ...workspace.conversations.map((thread) => ({
      id: `thread:${thread.id}`,
      label: thread.title,
      detail:
        workspace.dots.find((dot) => dot.id === thread.dotId)?.name ||
        'Conversation',
      view: 'chat' as const,
      destination: { dotId: thread.dotId, threadId: thread.id },
    })),
  ];
  const terms = query.trim().toLowerCase().split(/\s+/);
  return items.filter((item) =>
    terms.every((term) =>
      `${item.label} ${item.detail}`.toLowerCase().includes(term),
    ),
  );
}

export function savedNavigation(surface: Surface) {
  try {
    const value = JSON.parse(
      localStorage.getItem(`${surface}-navigation`) || '{}',
    );
    return {
      view: (['chat', 'space', 'tasks', 'memories', 'settings'].includes(
        value.view,
      )
        ? value.view
        : 'chat') as WorkspaceView,
      spaceId: typeof value.spaceId === 'string' ? value.spaceId : '',
      pageId: typeof value.pageId === 'string' ? value.pageId : undefined,
      collapsed: value.collapsed === true,
    };
  } catch {
    return {
      view: 'chat' as WorkspaceView,
      spaceId: '',
      pageId: undefined,
      collapsed: false,
    };
  }
}
