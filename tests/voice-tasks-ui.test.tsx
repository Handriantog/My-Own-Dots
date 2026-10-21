import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { VoiceTasks } from '../src/client/local-voice/VoiceTasks.js';
vi.mock('../src/client/api', () => ({
  authHeaders: () => ({ Authorization: 'Bearer owner' }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('links a waiting task to its approval conversation and can explicitly stop it after hangup', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  let status = 'approval';
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer owner' });
    if (url.endsWith('/stop')) status = 'cancelled';
    return new Response(
      JSON.stringify(
        url.endsWith('/stop')
          ? {}
          : [
              {
                id: 'job',
                dotId: 'dot',
                workerThreadId: 'worker',
                request: 'Fix login',
                status,
              },
            ],
      ),
      { headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetcher);
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(VoiceTasks, { threadId: 'parent' }));
  });
  expect(root.root.findByType('a').props.href).toBe('#/chat/dot/worker');
  expect(JSON.stringify(root.toJSON())).toContain('Needs approval');
  await act(async () => {
    await root.root.findByType('button').props.onClick();
  });
  expect(
    fetcher.mock.calls.some(
      ([url, init]) => url.endsWith('/job/stop') && init?.method === 'POST',
    ),
  ).toBe(true);
  expect(JSON.stringify(root.toJSON())).toContain('Stopped');
  await act(async () => root.unmount());
});
