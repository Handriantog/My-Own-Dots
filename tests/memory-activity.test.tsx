import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryActivity } from '../src/client/MemoryActivity';
const request = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api: request }));
let root: ReactTestRenderer;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  request.mockReset();
  vi.useRealTimers();
});
it('shows durable queued jobs, blocks conflicting restore, and stops polling on unmount', async () => {
  vi.useFakeTimers();
  const status = {
    jobs: [
      {
        id: 'j',
        kind: 'dream',
        state: 'queued',
        modelCalls: 0,
        origin: 'manual',
        createdAt: 1,
      },
    ],
    coverage: { complete: true, indexedRuns: 1, totalRuns: 1 },
    changes: [{ id: 'c', changes: [], createdAt: 1 }],
  };
  request.mockResolvedValue(status);
  await act(async () => {
    root = create(<MemoryActivity dotId="d" threadId="t" />);
  });
  expect(JSON.stringify(root.toJSON())).toContain('Queued');
  request.mockResolvedValueOnce({
    id: 'p',
    changeSetId: 'c',
    conflicts: ['newer'],
    changes: [],
    expectedRevisions: { newer: 1 },
  });
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Preview restore c' })
      .props.onClick(),
  );
  expect(JSON.stringify(root.toJSON())).toContain('Review before restoring');
  expect(
    root.root.findByProps({ 'aria-label': 'Confirm memory restore' }).props
      .disabled,
  ).toBe(true);
  await act(async () => root.unmount());
  const count = request.mock.calls.length;
  await act(async () => {
    vi.advanceTimersByTime(10000);
  });
  expect(request).toHaveBeenCalledTimes(count);
});
