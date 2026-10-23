import { describe, expect, it, vi } from 'vitest';
import {
  allowNavigation,
  navigationItems,
  restoreSelection,
  surfaceFromSearch,
} from '../src/client/workspace-navigation';
import type { WorkspaceState } from '../src/shared/types';
const workspace = {
  dots: [{ id: 'd', name: 'Research' }],
  spaces: [{ id: 's', name: 'Design' }],
  conversations: [{ id: 't', dotId: 'd', title: 'Launch notes' }],
} as WorkspaceState;
describe('desktop navigation', () => {
  it('guards before any navigation side effect', () => {
    const commit = vi.fn();
    expect(allowNavigation(true, () => false, commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(allowNavigation(true, () => true, commit)).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
  });
  it('searches actual titles, Dots, Spaces and sections', () => {
    expect(navigationItems(workspace, 'launch').map((x) => x.label)).toEqual([
      'Launch notes',
    ]);
    expect(navigationItems(workspace, 'research')[0].destination).toEqual({
      dotId: 'd',
    });
    expect(navigationItems(workspace, 'design')[0].destination).toEqual({
      spaceId: 's',
    });
    expect(navigationItems(workspace, 'memory')[0].view).toBe('memories');
    expect(navigationItems(workspace, 'abilities')[0].view).toBe('abilities');
    const views = navigationItems(workspace)
      .filter((item) => item.detail === 'Workspace')
      .map((item) => item.view);
    expect(views.indexOf('abilities')).toBe(views.indexOf('memories') + 1);
  });
  it('keeps workspace and companion selections separate', () => {
    const get = (key: string) =>
      ({
        'workspace-dot': 'a',
        'companion-dot': 'b',
        'desktop-thread': 'legacy',
      })[key];
    expect(restoreSelection('workspace', get)).toEqual({
      dotId: 'a',
      threadId: undefined,
    });
    expect(restoreSelection('companion', get)).toEqual({
      dotId: 'b',
      threadId: 'legacy',
    });
  });
  it('migrates missing companion keys without resurrecting cleared selections', () => {
    const storage = new Map([
      ['desktop-dot', 'legacy-dot'],
      ['desktop-thread', 'legacy-thread'],
    ]);
    const get = (key: string) => storage.get(key) ?? null;
    expect(restoreSelection('companion', get)).toEqual({
      dotId: 'legacy-dot',
      threadId: 'legacy-thread',
    });
    storage.set('companion-dot', 'legacy-dot');
    storage.set('companion-thread', '');
    expect(restoreSelection('companion', get)).toEqual({
      dotId: 'legacy-dot',
      threadId: undefined,
    });
    storage.set('companion-dot', '');
    expect(restoreSelection('companion', get)).toEqual({
      dotId: '',
      threadId: undefined,
    });
  });
  it('selects the explicit native surface and retains compact compatibility', () => {
    expect(surfaceFromSearch('?surface=workspace')).toBe('workspace');
    expect(surfaceFromSearch('?surface=companion')).toBe('companion');
    expect(surfaceFromSearch('?desktop=1')).toBe('companion');
    expect(surfaceFromSearch('')).toBe('workspace');
  });
});
