import { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FolderAccessSettings } from '../src/client/FolderAccessSettings';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
const grants = [
  {
    id: 'grant',
    dotId: 'dot',
    name: 'Notes',
    path: '/owner/Notes',
    access: 'read',
    createdAt: 0,
  },
];
let root: ReactTestRenderer | undefined;
let activeGrants = grants;
async function click(label: string) {
  await act(async () =>
    root!.root.findByProps({ 'aria-label': label }).props.onClick(),
  );
}
async function mount() {
  await act(async () => {
    root = create(<FolderAccessSettings dotId="dot" />);
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', new EventTarget());
  activeGrants = grants;
  api.mockReset().mockImplementation(async (_path, method) => {
    if (method === 'DELETE') {
      activeGrants = [];
      return { revoked: true };
    }
    return activeGrants;
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});
it('loads exact folder permissions on expansion and revokes only on owner click', async () => {
  await mount();
  expect(api).not.toHaveBeenCalled();
  await click('Folder access');
  expect(api).toHaveBeenCalledExactlyOnceWith('/dots/dot/folder-grants');
  expect(JSON.stringify(root!.toJSON())).toContain('/owner/Notes');
  expect(JSON.stringify(root!.toJSON())).toContain('Read only');
  await click('Revoke access to Notes');
  expect(api).toHaveBeenCalledWith('/dots/dot/folder-grants/grant', 'DELETE');
  expect(JSON.stringify(root!.toJSON())).toContain('No folders shared');
});
it('keeps the permission visible after a revoke failure and permits retry', async () => {
  await mount();
  await click('Folder access');
  api.mockRejectedValueOnce(new Error('Revoke unavailable'));
  await click('Revoke access to Notes');
  expect(JSON.stringify(root!.toJSON())).toContain('Revoke unavailable');
  expect(
    root!.root.findByProps({ 'aria-label': 'Revoke access to Notes' }).props
      .disabled,
  ).toBe(false);
  await click('Revoke access to Notes');
  expect(JSON.stringify(root!.toJSON())).toContain('No folders shared');
});
it('retries a failed permission load without opening a folder picker', async () => {
  await mount();
  api.mockRejectedValueOnce(new Error('Folders unavailable'));
  await click('Folder access');
  expect(JSON.stringify(root!.toJSON())).toContain('Folders unavailable');
  await click('Retry folder permissions');
  expect(JSON.stringify(root!.toJSON())).toContain('/owner/Notes');
});

it('removes a revoked grant when React repeats mount effects', async () => {
  await act(async () => {
    root = create(
      <StrictMode>
        <FolderAccessSettings dotId="dot" />
      </StrictMode>,
    );
  });
  await click('Folder access');
  await click('Revoke access to Notes');
  expect(JSON.stringify(root!.toJSON())).toContain('No folders shared');
});

it('refreshes an expanded list after this Dot gains folder access', async () => {
  api.mockResolvedValueOnce([]);
  await mount();
  await click('Folder access');
  expect(JSON.stringify(root!.toJSON())).toContain('No folders shared');
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('dot-folder-access-changed', {
        detail: { dotId: 'other-dot' },
      }),
    );
  });
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('dot-folder-access-changed', {
        detail: { dotId: 'dot' },
      }),
    );
  });
  expect(api).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(root!.toJSON())).toContain('/owner/Notes');
});

it('announces a successful revocation to other open permission lists', async () => {
  const changed = vi.fn();
  window.addEventListener('dot-folder-access-changed', changed);
  await mount();
  await click('Folder access');
  await click('Revoke access to Notes');
  expect(changed).toHaveBeenCalledOnce();
  expect(changed.mock.calls[0][0].detail).toEqual({ dotId: 'dot' });
});
