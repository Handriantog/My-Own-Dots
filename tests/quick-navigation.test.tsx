import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QuickNavigation } from '../src/client/QuickNavigation';
import type { WorkspaceState } from '../src/shared/types';
let root: ReactTestRenderer;
const previousFocus = vi.fn();
const inputFocus = vi.fn();
const workspace = {
  dots: [{ id: 'd', name: 'Research' }],
  spaces: [{ id: 's', name: 'Design' }],
  conversations: [{ id: 't', dotId: 'd', title: 'Launch notes' }],
} as WorkspaceState;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { activeElement: { focus: previousFocus } });
  previousFocus.mockClear();
  inputFocus.mockClear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});
it('supports real search, arrows, Enter, Escape and focus restoration', async () => {
  const choose = vi.fn(),
    close = vi.fn();
  await act(async () => {
    root = create(
      createElement(QuickNavigation, {
        workspace,
        onChoose: choose,
        onClose: close,
      }),
      {
        createNodeMock: (el) =>
          el.type === 'input'
            ? { focus: inputFocus }
            : el.type === 'div'
              ? { querySelector: () => null }
              : null,
      },
    );
  });
  expect(inputFocus).toHaveBeenCalledOnce();
  const dialog = root.root.findByProps({ role: 'dialog' });
  const key = (key: string) => ({ key, preventDefault: vi.fn() });
  await act(async () => dialog.props.onKeyDown(key('ArrowDown')));
  await act(async () => dialog.props.onKeyDown(key('Enter')));
  expect(choose).toHaveBeenLastCalledWith(
    expect.objectContaining({ label: 'Spaces' }),
  );
  await act(async () =>
    root.root
      .findByType('input')
      .props.onChange({ target: { value: 'launch' } }),
  );
  expect(root.root.findAllByProps({ role: 'option' })).toHaveLength(1);
  await act(async () => dialog.props.onKeyDown(key('Enter')));
  expect(choose).toHaveBeenLastCalledWith(
    expect.objectContaining({ destination: { dotId: 'd', threadId: 't' } }),
  );
  await act(async () => dialog.props.onKeyDown(key('Escape')));
  expect(close).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  expect(previousFocus).toHaveBeenCalledOnce();
});
