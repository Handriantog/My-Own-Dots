import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryDetails } from '../src/client/MemoryDetails';
const request = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api: request }));
let root: ReactTestRenderer;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  request.mockReset();
});
const item = {
  id: 'm',
  scope: { kind: 'dot', id: 'd' },
  kind: 'fact',
  status: 'active',
  title: 'Preference',
  text: 'Original',
  pinned: false,
  revision: 1,
  sources: [],
  createdAt: 1,
  updatedAt: 1,
};
it('keeps corrections after a pin capacity error and submits revision-checked changes', async () => {
  request.mockResolvedValue({ item, revisions: [item], sources: [] });
  await act(async () => {
    root = create(
      <MemoryDetails id="m" onChanged={() => {}} onClose={() => {}} />,
    );
  });
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Memory text' })
      .props.onChange({ target: { value: 'Corrected preference' } }),
  );
  request.mockRejectedValueOnce(new Error('Pinned memory capacity exceeded'));
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Pin memory' }).props.onClick(),
  );
  expect(JSON.stringify(root.toJSON())).toContain(
    'Pinned memory capacity exceeded',
  );
  expect(
    root.root.findByProps({ 'aria-label': 'Memory text' }).props.value,
  ).toBe('Corrected preference');
  request.mockResolvedValue({
    ...item,
    text: 'Corrected preference',
    revision: 2,
  });
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Save memory correction' })
      .props.onClick(),
  );
  expect(request).toHaveBeenLastCalledWith('/memory-items/m', 'PATCH', {
    expectedRevision: 1,
    patch: { title: 'Preference', text: 'Corrected preference' },
  });
});
it('reviews a pending proposal through the explicit review route', async () => {
  request.mockResolvedValue({
    item: { ...item, status: 'pending' },
    revisions: [],
    sources: [],
  });
  await act(async () => {
    root = create(
      <MemoryDetails id="m" onChanged={() => {}} onClose={() => {}} />,
    );
  });
  request.mockResolvedValue(item);
  await act(async () =>
    root.root.findByProps({ 'aria-label': 'Approve memory' }).props.onClick(),
  );
  expect(request).toHaveBeenLastCalledWith('/memory-items/m/review', 'POST', {
    expectedRevision: 1,
    decision: 'approve',
  });
});
