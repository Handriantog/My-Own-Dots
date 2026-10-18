import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FolderAccessCard } from '../src/client/FolderAccessCard';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));

const requestId = 'd213a4fb-4476-4af8-90d1-c48b2a6c5100';
const selectionId = 'f6144c1f-04a0-47af-82bd-a22bd32824dc';
const base = `/conversations/thread/folder-requests/${requestId}`;
const pendingRequest = {
  id: requestId,
  threadId: 'thread',
  dotId: 'dot',
  reason: 'Read the project notes to answer your question.',
  folderHint: 'Your project notes folder',
  requestedAccess: 'readwrite',
  status: 'pending',
  expiresAt: Date.now() + 3600000,
};
const selection = {
  id: selectionId,
  path: '/approved/Project notes',
  name: 'Project notes',
};
const approved = {
  approved: true,
  grantId: 'grant',
  name: 'Project notes',
  access: 'read',
  message: 'Folder access approved.',
};
const declined = {
  approved: false,
  message: 'The owner declined folder access.',
};
const props = {
  args: { requestId },
  status: 'executing',
  threadId: 'thread',
  toolCallId: 'call',
  respond: vi.fn(async (_result: unknown) => {}),
};
let root: ReactTestRenderer | undefined;
let choose: ReturnType<typeof vi.fn>;
let detail: Record<string, unknown>;
function button(label: string) {
  return root!.root.findByProps({ 'aria-label': label });
}
async function click(label: string) {
  await act(async () => button(label).props.onClick());
}
async function mount(next = props) {
  await act(async () => {
    root = create(createElement(FolderAccessCard, next));
  });
}
function text() {
  return JSON.stringify(root!.toJSON());
}
function mutations() {
  return api.mock.calls.filter(([, method]) => method === 'POST');
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  choose = vi.fn(async () => ({ path: '/picked/Project notes' }));
  vi.stubGlobal('window', { dotFolders: { choose } });
  props.respond.mockReset().mockResolvedValue(undefined);
  detail = { request: { ...pendingRequest } };
  api.mockReset().mockImplementation(async (path, method, body) => {
    if (path === base && (!method || method === 'GET')) return detail;
    if (path === `${base}/selection` && method === 'POST') {
      detail = { ...detail, selection };
      return selection;
    }
    if (path === `${base}/decision` && method === 'POST') {
      if (detail.decision) return detail.decision;
      const decision = body.approve ? approved : declined;
      detail = {
        ...detail,
        request: {
          ...pendingRequest,
          status: body.approve ? 'approved' : 'declined',
        },
        decision,
      };
      return decision;
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

it('requires an owner picker gesture and a separate approval of the verified folder', async () => {
  await mount();
  expect(choose).not.toHaveBeenCalled();
  expect(text()).toContain(pendingRequest.reason);
  expect(text()).toContain(pendingRequest.folderHint);
  expect(button('Approve folder access').props.disabled).toBe(true);
  expect(
    root!.root.findByProps({ 'aria-label': 'Folder permission' }).props.value,
  ).toBe('read');
  await click('Choose folder');
  expect(choose).toHaveBeenCalledExactlyOnceWith();
  expect(mutations()).toEqual([
    [`${base}/selection`, 'POST', { path: '/picked/Project notes' }],
  ]);
  expect(text()).toContain('/approved/Project notes');
  expect(text()).not.toContain('/picked/Project notes');
  expect(props.respond).not.toHaveBeenCalled();
  await click('Approve folder access');
  expect(mutations()[1]).toEqual([
    `${base}/decision`,
    'POST',
    {
      toolCallId: 'call',
      approve: true,
      selectionId,
      access: 'read',
    },
  ]);
  expect(props.respond).toHaveBeenCalledExactlyOnceWith(approved);
});

it('lets the owner explicitly choose read and write access', async () => {
  await mount();
  await click('Choose folder');
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': 'Folder permission' })
      .props.onChange({ target: { value: 'readwrite' } }),
  );
  await click('Approve folder access');
  expect(mutations()[1][2].access).toBe('readwrite');
});

it('does not stage or grant anything when the picker is cancelled', async () => {
  choose.mockResolvedValue(null);
  await mount();
  await click('Choose folder');
  expect(mutations()).toEqual([]);
  expect(props.respond).not.toHaveBeenCalled();
  expect(button('Approve folder access').props.disabled).toBe(true);
  expect(button('Choose folder').props.disabled).toBe(false);
});

it.each(['picker', 'selection', 'decision'])(
  'keeps review usable after a %s failure',
  async (failure) => {
    await mount();
    if (failure === 'picker')
      choose.mockRejectedValueOnce(new Error('Folder unavailable'));
    if (failure === 'selection')
      api.mockRejectedValueOnce(new Error('Folder unavailable'));
    await click('Choose folder');
    if (failure === 'decision') {
      api.mockRejectedValueOnce(new Error('Folder unavailable'));
      await click('Approve folder access');
    }
    expect(text()).toContain('Folder unavailable');
    expect(button('Choose folder').props.disabled).toBe(false);
    if (failure !== 'decision') await click('Choose folder');
    await click('Approve folder access');
    expect(props.respond).toHaveBeenCalledExactlyOnceWith(approved);
  },
);

it('persists a decline before responding and revalidates its binding on continuation', async () => {
  await mount();
  props.respond.mockRejectedValueOnce(new Error('Conversation disconnected'));
  await click('Decline folder access');
  expect(mutations()).toEqual([
    [`${base}/decision`, 'POST', { toolCallId: 'call', approve: false }],
  ]);
  expect(text()).toContain('Conversation disconnected');
  expect(text()).toContain('Declined');
  await click('Continue conversation');
  expect(mutations()).toEqual([
    [`${base}/decision`, 'POST', { toolCallId: 'call', approve: false }],
    [`${base}/decision`, 'POST', { toolCallId: 'call', approve: false }],
  ]);
  expect(choose).not.toHaveBeenCalled();
  expect(props.respond).toHaveBeenLastCalledWith(declined);
});

it.each([approved, declined])(
  'recovers a saved decision on reload without granting again: $approved',
  async (decision) => {
    detail = {
      request: {
        ...pendingRequest,
        status: decision.approved ? 'approved' : 'declined',
      },
      selection,
      decision,
    };
    await mount();
    expect(
      root!.root.findAllByProps({ 'aria-label': 'Choose folder' }),
    ).toHaveLength(0);
    await click('Continue conversation');
    expect(mutations()).toEqual([
      [
        `${base}/decision`,
        'POST',
        { toolCallId: 'call', approve: decision.approved },
      ],
    ]);
    expect(choose).not.toHaveBeenCalled();
    expect(props.respond).toHaveBeenCalledExactlyOnceWith(decision);
  },
);

it('recovers a completed approval when its HTTP response is lost', async () => {
  await mount();
  await click('Choose folder');
  api.mockImplementationOnce(async () => {
    detail = {
      request: { ...pendingRequest, status: 'approved' },
      selection,
      decision: approved,
    };
    throw new Error('Connection lost');
  });
  await click('Approve folder access');
  await click('Continue conversation');
  expect(mutations().filter(([path]) => path.endsWith('/decision'))).toEqual([
    [
      `${base}/decision`,
      'POST',
      { toolCallId: 'call', approve: true, selectionId, access: 'read' },
    ],
    [`${base}/decision`, 'POST', { toolCallId: 'call', approve: true }],
  ]);
  expect(choose).toHaveBeenCalledOnce();
  expect(props.respond).toHaveBeenCalledExactlyOnceWith(approved);
});

it('allows decline in a browser while directing folder selection to desktop', async () => {
  vi.stubGlobal('window', {});
  await mount();
  expect(text()).toContain('Open the desktop app to choose a folder');
  expect(
    root!.root.findAllByProps({ 'aria-label': 'Choose folder' }),
  ).toHaveLength(0);
  await click('Decline folder access');
  expect(props.respond).toHaveBeenCalledExactlyOnceWith(declined);
});

it('does not use model supplied paths or permissions as approval arguments', async () => {
  await mount({
    ...props,
    args: { requestId, path: '/untrusted', access: 'readwrite' },
  } as typeof props);
  expect(api).not.toHaveBeenCalled();
  expect(choose).not.toHaveBeenCalled();
  expect(text()).toContain('Invalid folder access request');
  expect(
    root!.root.findAllByProps({ 'aria-label': 'Approve folder access' }),
  ).toHaveLength(0);
});

it('offers retry when the server request cannot be loaded', async () => {
  api.mockRejectedValueOnce(new Error('Server unavailable'));
  await mount();
  expect(text()).toContain('Server unavailable');
  await click('Retry folder request');
  expect(button('Choose folder').props.disabled).toBe(false);
});

it('ignores a picker result after switching to another request card', async () => {
  let resolve!: (value: { path: string }) => void;
  choose.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount();
  await click('Choose folder');
  await act(async () =>
    root!.update(
      createElement(FolderAccessCard, { ...props, toolCallId: 'another-call' }),
    ),
  );
  await act(async () => resolve({ path: '/late/folder' }));
  expect(mutations()).toEqual([]);
  expect(button('Approve folder access').props.disabled).toBe(true);
});

it('does not open two pickers for repeated clicks before the first result', async () => {
  let resolve!: (value: null) => void;
  choose.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount();
  const select = button('Choose folder').props.onClick;
  await act(async () => {
    select();
    select();
  });
  expect(choose).toHaveBeenCalledOnce();
  await act(async () => resolve(null));
  expect(mutations()).toEqual([]);
});

it('revalidates a saved approval after continuation fails without selecting or granting again', async () => {
  await mount();
  await click('Choose folder');
  props.respond.mockRejectedValueOnce(new Error('Conversation unavailable'));
  await click('Approve folder access');
  expect(text()).toContain('Conversation unavailable');
  expect(text()).toContain('Approved');
  await click('Continue conversation');
  expect(mutations().filter(([path]) => path.endsWith('/decision'))).toEqual([
    [
      `${base}/decision`,
      'POST',
      { toolCallId: 'call', approve: true, selectionId, access: 'read' },
    ],
    [`${base}/decision`, 'POST', { toolCallId: 'call', approve: true }],
  ]);
  expect(choose).toHaveBeenCalledOnce();
  expect(props.respond).toHaveBeenLastCalledWith(approved);
});

it('announces a saved approval so an expanded settings list can refresh', async () => {
  const target = Object.assign(new EventTarget(), { dotFolders: { choose } });
  const changed = vi.fn();
  target.addEventListener('dot-folder-access-changed', changed);
  vi.stubGlobal('window', target);
  await mount();
  await click('Choose folder');
  expect(changed).not.toHaveBeenCalled();
  await click('Approve folder access');
  expect(changed).toHaveBeenCalledOnce();
  expect(changed.mock.calls[0][0].detail).toEqual({ dotId: 'dot' });
});

it('revalidates an approval revoked after loading before continuing the conversation', async () => {
  detail = {
    request: { ...pendingRequest, status: 'approved' },
    selection,
    decision: approved,
  };
  await mount();
  const revoked = {
    approved: false,
    message: 'Folder access was revoked. Request owner approval again.',
  };
  detail = { ...detail, decision: revoked };
  await click('Continue conversation');
  expect(mutations()).toEqual([
    [`${base}/decision`, 'POST', { toolCallId: 'call', approve: true }],
  ]);
  expect(props.respond).toHaveBeenCalledExactlyOnceWith(revoked);
  expect(choose).not.toHaveBeenCalled();
  expect(text()).toContain('Folder access was revoked');
});

it('does not respond with a cached approval when the server rejects its tool call binding', async () => {
  detail = {
    request: { ...pendingRequest, status: 'approved' },
    selection,
    decision: approved,
  };
  await mount({ ...props, toolCallId: 'another-call' });
  api.mockRejectedValueOnce(
    new Error('Folder request was already decided by another tool call.'),
  );
  await click('Continue conversation');
  expect(mutations()).toEqual([
    [`${base}/decision`, 'POST', { toolCallId: 'another-call', approve: true }],
  ]);
  expect(props.respond).not.toHaveBeenCalled();
  expect(text()).toContain('already decided by another tool call');
  expect(button('Continue conversation').props.disabled).toBe(false);
});
