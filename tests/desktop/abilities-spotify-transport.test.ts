import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { createSpotifyTransport } from '../../src/desktop/host/abilities/spotify.ts';
const state = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: state.exec }));
beforeEach(() => {
  state.exec.mockReset();
});
function fake(reply: unknown) {
  const child = Object.assign(new EventEmitter(), {
    stdin: { end: vi.fn(), on: vi.fn() },
    kill: vi.fn(),
  });
  state.exec.mockImplementation((_file, _args, _opts, callback) => {
    queueMicrotask(() =>
      callback(null, JSON.stringify(reply), 'sensitive native error'),
    );
    return child;
  });
  return child;
}
it('sends JSON over stdin to a fixed executable without shell or inherited credentials', async () => {
  const child = fake({ ok: true, kind: 'app-control', status: 'success' });
  expect(
    await createSpotifyTransport('/bundle/native/spotify-control')(
      { action: 'pause' },
      new AbortController().signal,
    ),
  ).toEqual({ ok: true, kind: 'app-control', status: 'success' });
  expect(state.exec.mock.calls[0][0]).toBe('/bundle/native/spotify-control');
  expect(state.exec.mock.calls[0][1]).toEqual([]);
  expect(state.exec.mock.calls[0][2].shell).toBe(false);
  expect(child.stdin.end).toHaveBeenCalledWith('{"action":"pause"}');
});
it('denies malformed input before starting an owned process', async () => {
  expect(
    await createSpotifyTransport('/fixed')(
      { action: 'pause', script: 'anything' } as never,
      new AbortController().signal,
    ),
  ).toEqual({ ok: false, code: 'permission_denied' });
  expect(state.exec).not.toHaveBeenCalled();
});
it('does not retry or leak unexpected output after delivery', async () => {
  fake({ secret: 'private output' });
  expect(
    await createSpotifyTransport('/fixed')(
      { action: 'pause' },
      new AbortController().signal,
    ),
  ).toEqual({ ok: true, kind: 'app-control', status: 'uncertain' });
  expect(state.exec).toHaveBeenCalledTimes(1);
});
it('kills on cancellation and ignores success arriving after abort', async () => {
  const child = fake({ ok: true, kind: 'app-control', status: 'success' }),
    controller = new AbortController();
  const result = createSpotifyTransport('/fixed')(
    { action: 'pause' },
    controller.signal,
  );
  controller.abort();
  expect(await result).toEqual({
    ok: true,
    kind: 'app-control',
    status: 'uncertain',
  });
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});
