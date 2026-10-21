import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { SavedMessages } from '../src/client/SavedMessages';
import { useMessageMarks } from '../src/client/useMessageMarks';
import type { MessageMark } from '../src/shared/message-marks';

const network = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/client/api', () => ({ api: network.api }));
afterEach(() => {
  vi.unstubAllGlobals();
  network.api.mockReset();
});

const mark: MessageMark = {
  threadId: 'first',
  messageId: 'one',
  role: 'assistant',
  content: 'Saved answer',
  pinnedAt: 10,
  bookmarkedAt: 10,
  threadTitle: 'First chat',
  dotId: 'dot',
  dotName: 'Dot',
};

it('keeps pins local while showing bookmarks from other conversations', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const opened: string[] = [];
  const props = {
    threadId: 'second',
    marks: [mark],
    kind: 'pin' as const,
    onKind: () => {},
    onClose: () => {},
    onOpen: (item: MessageMark) => opened.push(item.threadId),
    onRemove: () => {},
    busy: false,
    loading: false,
  };
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(SavedMessages, props));
  });
  expect(
    root.root.findAllByProps({ className: 'saved-message-link' }),
  ).toHaveLength(0);
  await act(async () => {
    root.update(createElement(SavedMessages, { ...props, kind: 'bookmark' }));
  });
  const link = root.root.findByProps({ className: 'saved-message-link' });
  expect(link.findByType('p').children.join('')).toBe('Saved answer');
  await act(async () => link.props.onClick());
  expect(opened).toEqual(['first']);
  await act(async () => root.unmount());
});

it('preserves the existing bookmark when saving fails and permits a retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  network.api.mockImplementation(async (_path: string, method = 'GET') => {
    if (method === 'GET') return [mark];
    throw new Error('Storage unavailable');
  });
  let state!: ReturnType<typeof useMessageMarks>;
  function Harness() {
    state = useMessageMarks('first');
    return createElement('p', null, state.error);
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(Harness));
  });
  await act(async () => {
    await state.update('first', 'one', 'bookmark', false);
  });
  expect(state.marks).toEqual([mark]);
  expect(JSON.stringify(root.toJSON())).toContain('Storage unavailable');
  expect(state.saving).toBe(false);
  network.api.mockResolvedValueOnce({ ...mark, bookmarkedAt: null });
  await act(async () => {
    await state.update('first', 'one', 'bookmark', false);
  });
  expect(state.marks).toEqual([{ ...mark, bookmarkedAt: null }]);
  expect(state.error).toBe('');
  await act(async () => root.unmount());
});
