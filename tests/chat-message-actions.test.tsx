import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatTranscript } from '../src/client/ChatTranscript';

afterEach(() => vi.unstubAllGlobals());
it('offers independent pin and bookmark actions on every text message, including grouped rows', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const actions: unknown[] = [];
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      createElement(ChatTranscript, {
        messages: [
          { id: 'a', role: 'user', content: 'First' },
          { id: 'b', role: 'user', content: 'Second' },
          { id: 'tools', role: 'assistant', content: '' },
        ],
        calls: [],
        marks: [
          {
            threadId: 'thread',
            messageId: 'a',
            role: 'user',
            content: 'First',
            pinnedAt: 1,
            bookmarkedAt: null,
            threadTitle: 'Chat',
            dotId: 'dot',
            dotName: 'Dot',
          },
        ],
        onMark: (id, kind, active) => actions.push({ id, kind, active }),
      }),
    );
  });
  const buttons = root.root.findAllByType('button');
  expect(buttons.map((button) => button.props['aria-label'])).toEqual([
    'Unpin message',
    'Bookmark message',
    'Pin message',
    'Bookmark message',
  ]);
  expect(buttons[0].props['aria-pressed']).toBe(true);
  await act(async () => buttons[0].props.onClick());
  await act(async () => buttons[3].props.onClick());
  expect(actions).toEqual([
    { id: 'a', kind: 'pin', active: false },
    { id: 'b', kind: 'bookmark', active: true },
  ]);
  await act(async () => root.unmount());
});
