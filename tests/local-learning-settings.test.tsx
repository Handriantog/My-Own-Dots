import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalLearningSettings } from '../src/client/LocalLearningSettings';
const request = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api: request }));
let root: ReactTestRenderer;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  request.mockReset();
});
it('saves automatic learning independently from memory-use permission', async () => {
  request.mockResolvedValue({
    revision: 1,
    learningEnabled: false,
    autoCompact: true,
    autoDream: true,
    publicationPolicy: 'hybrid',
    compactThreshold: 0.75,
    compactIdleMs: 120000,
    compactExchanges: 8,
    compactNewTokens: 4000,
    dreamIntervalMs: 7200000,
    dreamIdleMs: 300000,
    automaticJobsPerDay: 4,
    timeZone: 'UTC',
  });
  await act(async () => {
    root = create(<LocalLearningSettings dotId="d" onChanged={() => {}} />);
  });
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Learn from new conversations' })
      .props.onChange({ target: { checked: true } }),
  );
  await act(async () =>
    root.root
      .findByProps({ 'aria-label': 'Save learning settings' })
      .props.onClick(),
  );
  expect(request.mock.lastCall?.[2]).toMatchObject({
    expectedRevision: 1,
    patch: { learningEnabled: true },
  });
  expect(request.mock.lastCall?.[2].patch).not.toHaveProperty('memoryAllowed');
});
