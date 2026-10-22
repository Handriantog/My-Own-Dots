import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
import { PageReviewCard } from '../src/client/PageReviewCard';

const draft = { title: 'Brief', content: 'Evidence', spaceId: 'space' };
const text = (node: unknown): string =>
  typeof node === 'string'
    ? node
    : Array.isArray(node)
      ? node.map(text).join('')
      : node && typeof node === 'object' && 'children' in node
        ? text((node as { children: unknown }).children)
        : '';

beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

it('keeps a pending draft open, then collapses its receipt without hiding the saved page action', async () => {
  api.mockResolvedValue(null);
  const props = {
    args: draft,
    status: 'executing',
    respond: async () => {},
    threadId: 'thread',
    toolCallId: 'call',
    onSaved: () => {},
  };
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(PageReviewCard, props));
  });
  expect(root.root.findByType('details').props.open).toBe(true);
  api.mockResolvedValue({
    id: 'page',
    spaceId: 'space',
    title: 'Brief',
    content: 'Evidence',
    reviewDraft: draft,
  });
  const approve = root.root
    .findAllByType('button')
    .find((button) => text(button.props.children).includes('Approve & save'))!;
  await act(async () => {
    await approve.props.onClick();
  });
  await act(async () => {
    root.update(
      createElement(PageReviewCard, { ...props, status: 'complete' }),
    );
  });
  expect(root.root.findByType('details').props.open).toBe(false);
  expect(text(root.root.findByType('summary').children)).toContain('Brief');
  expect(text(root.root.findByType('footer').children)).toContain('Open page');
  expect(text(root.toJSON())).toContain('Evidence');
  await act(async () => {
    root.unmount();
  });
});

it('drops the saved page when a refreshed receipt reports it deleted', async () => {
  const saved = {
    id: 'page',
    spaceId: 'space',
    parentId: null,
    title: 'Brief',
    content: 'Evidence',
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    sourceThreadId: null,
    reviewDraft: draft,
  };
  api.mockResolvedValueOnce(saved).mockResolvedValueOnce({
    deleted: true,
    pageId: 'page',
    spaceId: 'space',
    reviewDraft: draft,
  });
  const respond = vi.fn(async () => {});
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      createElement(PageReviewCard, {
        args: draft,
        status: 'executing',
        respond,
        threadId: 'thread',
        toolCallId: 'call',
        onSaved: () => {},
      }),
    );
  });
  expect(text(root.toJSON())).toContain('Open page');
  const button = root.root.findAll(
    (node) =>
      node.type === 'button' && text(node.props.children).includes('Continue'),
  )[0];
  await act(async () => {
    await button.props.onClick();
  });
  const view = text(root.toJSON());
  expect(view).toContain('Saved, then deleted');
  expect(view).not.toContain('Open page');
  expect(respond).toHaveBeenCalledWith(
    expect.objectContaining({ approved: true, deleted: true }),
  );
});
