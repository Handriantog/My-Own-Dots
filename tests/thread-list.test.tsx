import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ThreadList } from '../src/client/ThreadList';
import type { Conversation, Dot } from '../src/shared/types';

vi.mock('@copilotkit/react-core/v2', () => ({
  useThreads: () => ({ threads: [], error: null }),
}));
afterEach(() => vi.unstubAllGlobals());
it('does not steal composer focus when deletion finishes after the user moves away', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const composer = {};
  const document = { activeElement: {}, body: {} };
  vi.stubGlobal('document', document);
  let release!: () => void;
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      createElement(ThreadList, {
        ...base,
        onDelete: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      }),
      {
        createNodeMock: (node) =>
          node.type === 'input'
            ? {
                focus() {
                  document.activeElement = this;
                },
              }
            : node.type === 'li'
              ? {
                  contains() {
                    return false;
                  },
                  isConnected: true,
                  scrollIntoView() {},
                }
              : null,
      },
    );
  });
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Chat actions for Recent chat' })
      .props.onClick(),
  );
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Delete chat' }).props.onClick(),
  );
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Move to Trash' }).props.onClick(),
  );
  document.activeElement = composer;
  await act(async () => release());
  expect(document.activeElement).toBe(composer);
  await act(async () => root.unmount());
});
const local: Conversation[] = [
  {
    id: 'recent',
    dotId: 'dot',
    ownerId: 'owner',
    title: 'Recent chat',
    createdAt: 3,
  },
  {
    id: 'pinned',
    dotId: 'helper',
    ownerId: 'owner',
    title: 'Project notes',
    createdAt: 1,
    pinnedAt: 2,
  },
  {
    id: 'older',
    dotId: 'dot',
    ownerId: 'owner',
    title: 'Older chat',
    createdAt: 2,
  },
];
const base = {
  dots: [
    { id: 'dot', name: 'Dot' },
    { id: 'helper', name: 'Researcher' },
  ] as Dot[],
  local,
  selected: 'recent',
  onSelect: () => {},
  onUpdate: async () => {},
  deleted: [],
  onDelete: async () => {},
  onRestore: async () => {},
};

it('keeps pinned chats first and searches titles and Dot names across all chats', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(ThreadList, base));
  });
  const titles = () =>
    root.root
      .findAllByProps({ className: 'chat-thread-link' })
      .map((button) => button.props['aria-label']);
  expect(titles()).toEqual(['Project notes', 'Recent chat', 'Older chat']);
  const search = root.root.findByProps({ 'aria-label': 'Search chats' });
  await act(async () =>
    search.props.onChange({ target: { value: '  PROJECT  ' } }),
  );
  expect(titles()).toEqual(['Project notes']);
  await act(async () =>
    search.props.onChange({ target: { value: 'researcher' } }),
  );
  expect(titles()).toEqual(['Project notes']);
  await act(async () =>
    search.props.onChange({ target: { value: 'missing' } }),
  );
  expect(titles()).toEqual([]);
  expect(JSON.stringify(root.toJSON())).toContain('No chats found');
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Clear chat search' })
      .props.onClick(),
  );
  expect(titles()).toHaveLength(3);
  await act(async () => root.unmount());
});

it('confirms deletion, preserves a failed deletion, and offers restoring chats from Trash', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let current = local;
  let deleted: Conversation[] = [];
  let fail = true;
  let root!: ReturnType<typeof create>;
  const props = {
    ...base,
    onDelete: async (id: string) => {
      if (fail) throw new Error('Chat is busy');
      deleted = current
        .filter((thread) => thread.id === id)
        .map((thread) => ({ ...thread, deletedAt: 10 }));
      current = current.filter((thread) => thread.id !== id);
      root.update(
        createElement(ThreadList, { ...props, local: current, deleted }),
      );
    },
    onRestore: async (id: string) => {
      current = [...current, ...deleted.filter((thread) => thread.id === id)];
      deleted = deleted.filter((thread) => thread.id !== id);
      root.update(
        createElement(ThreadList, { ...props, local: current, deleted }),
      );
    },
  };
  await act(async () => {
    root = create(createElement(ThreadList, props));
  });
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Chat actions for Recent chat' })
      .props.onClick(),
  );
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Delete chat' }).props.onClick(),
  );
  expect(current).toHaveLength(3);
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Cancel delete' }).props.onClick(),
  );
  expect(current).toHaveLength(3);
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Chat actions for Recent chat' })
      .props.onClick(),
  );
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Delete chat' }).props.onClick(),
  );
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Move to Trash' }).props.onClick(),
  );
  expect(JSON.stringify(root.toJSON())).toContain('Chat is busy');
  expect(current).toHaveLength(3);
  fail = false;
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Move to Trash' }).props.onClick(),
  );
  expect(current).toHaveLength(2);
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Open chat Trash' }).props.onClick(),
  );
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Restore Recent chat' })
      .props.onClick(),
  );
  expect(current).toHaveLength(3);
  expect(deleted).toHaveLength(0);
  await act(async () => root.unmount());
});

it('renames and pins without opening the chat, and keeps a failed rename ready to retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let current = local;
  let fail = true;
  let opened = '';
  let root!: ReturnType<typeof create>;
  const props = {
    ...base,
    onSelect: (id: string) => {
      opened = id;
    },
    onUpdate: async (
      id: string,
      patch: { title?: string; pinned?: boolean },
    ) => {
      if (fail) throw new Error('Storage unavailable');
      current = current.map((thread) =>
        thread.id === id
          ? {
              ...thread,
              ...(patch.title ? { title: patch.title } : {}),
              ...(patch.pinned !== undefined
                ? { pinnedAt: patch.pinned ? 100 : null }
                : {}),
            }
          : thread,
      );
      root.update(createElement(ThreadList, { ...props, local: current }));
    },
  };
  await act(async () => {
    root = create(createElement(ThreadList, props));
  });
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Chat actions for Recent chat' })
      .props.onClick(),
  );
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Rename chat' }).props.onClick(),
  );
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Chat name' })
      .props.onChange({ target: { value: '  Clear title  ' } }),
  );
  await act(async () =>
    root.root.findByType('form').props.onSubmit({ preventDefault() {} }),
  );
  expect(root.root.findByProps({ 'aria-label': 'Chat name' }).props.value).toBe(
    '  Clear title  ',
  );
  expect(JSON.stringify(root.toJSON())).toContain('Storage unavailable');
  fail = false;
  await act(async () =>
    root.root.findByType('form').props.onSubmit({ preventDefault() {} }),
  );
  expect(root.root.findAllByType('form')).toHaveLength(0);
  expect(
    root.root.findByProps({ 'aria-label': 'Clear title' }).props[
      'aria-current'
    ],
  ).toBe('page');
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Chat actions for Clear title' })
      .props.onClick(),
  );
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Pin chat' }).props.onClick(),
  );
  expect(
    root.root.findAllByProps({ className: 'chat-thread-link' })[0].props[
      'aria-label'
    ],
  ).toBe('Clear title');
  expect(opened).toBe('');
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Clear title' }).props.onClick(),
  );
  expect(opened).toBe('recent');
  await act(async () => root.unmount());
});

it('keeps rename controls focusable while saving and preserves the draft on failure', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let reject!: (reason: Error) => void;
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      createElement(ThreadList, {
        ...base,
        onUpdate: () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      }),
    );
  });
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Chat actions for Recent chat' })
      .props.onClick(),
  );
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Rename chat' }).props.onClick(),
  );
  await act(async () =>
    root.root.findByType('form').props.onSubmit({ preventDefault() {} }),
  );
  expect(
    root.root.findByProps({ 'aria-label': 'Chat name' }).props.disabled,
  ).toBeFalsy();
  expect(
    root.root.findByProps({ 'aria-label': 'Save name' }).props.disabled,
  ).toBeFalsy();
  await act(async () => reject(new Error('Try again')));
  expect(root.root.findByProps({ 'aria-label': 'Chat name' }).props.value).toBe(
    'Recent chat',
  );
  expect(JSON.stringify(root.toJSON())).toContain('Try again');
  await act(async () => root.unmount());
});
