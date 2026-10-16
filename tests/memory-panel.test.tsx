import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryPanel } from '../src/client/MemoryPanel';
const request = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api: request }));
let root: ReactTestRenderer;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  request.mockReset();
});
it('loads active records and keeps a new memory draft when saving fails', async () => {
  request.mockResolvedValue({ items: [] });
  await act(async () => {
    root = create(<MemoryPanel dotId="d" onChanged={() => {}} />);
  });
  expect(request.mock.calls[0][0]).toContain('status=active');
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'New memory text' })
      .props.onChange({ target: { value: 'Keep this draft' } }),
  );
  request.mockRejectedValueOnce(new Error('Storage unavailable'));
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Add memory' })
      .props.onSubmit({ preventDefault() {} }),
  );
  expect(
    root.root.findByProps({ 'aria-label': 'New memory text' }).props.value,
  ).toBe('Keep this draft');
  expect(JSON.stringify(root.toJSON())).toContain('Storage unavailable');
});
