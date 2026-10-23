import { afterEach, expect, it, vi } from 'vitest';
import {
  SpotifyDucking,
  permitsSpotifyDucking,
} from '../../src/desktop/host/abilities/spotify-ducking.js';

const binding = {
  dotId: 'jane',
  digest: 'abc',
  enabled: true,
  restored: false,
  grants: ['music'],
  manifest: {
    permissions: [
      {
        id: 'music',
        kind: 'app-control',
        application: 'com.spotify.client',
        actions: ['volume'],
      },
    ],
  },
};
const catalog = () => ({
  bindings: [structuredClone(binding)],
  installed: [{ digest: 'abc', enabled: true, restored: false }],
});
function fixture(
  authorize = async (_dot: string, _signal: AbortSignal) => true,
) {
  vi.useFakeTimers();
  let volume = 80;
  const history: number[] = [];
  const leases: {
    heartbeat: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const duck = new SpotifyDucking(authorize, () => {
    const original = volume;
    volume = Math.floor(original / 4);
    history.push(volume);
    const lease = {
      heartbeat: vi.fn(),
      close: vi.fn(async () => {
        volume = original;
        history.push(volume);
      }),
    };
    leases.push(lease);
    return lease;
  });
  return { duck, leases, history };
}
afterEach(() => vi.useRealTimers());
it('ducks only an enabled, approved volume grant for the active Dot and installation', () => {
  expect(permitsSpotifyDucking(catalog(), 'jane')).toBe(true);
  expect(permitsSpotifyDucking(catalog(), 'bob')).toBe(false);
  for (const change of [
    (c: ReturnType<typeof catalog>) => {
      c.bindings[0].enabled = false;
    },
    (c: ReturnType<typeof catalog>) => {
      c.bindings[0].restored = true;
    },
    (c: ReturnType<typeof catalog>) => {
      c.bindings[0].grants = [];
    },
    (c: ReturnType<typeof catalog>) => {
      c.bindings[0].manifest.permissions[0].actions = ['play'];
    },
    (c: ReturnType<typeof catalog>) => {
      c.installed[0].enabled = false;
    },
    (c: ReturnType<typeof catalog>) => {
      c.installed[0].restored = true;
    },
    (c: ReturnType<typeof catalog>) => {
      c.installed = [];
    },
  ]) {
    const data = catalog();
    change(data);
    expect(permitsSpotifyDucking(data, 'jane')).toBe(false);
  }
});
it('holds the original volume across short audio gaps and restores after speech', async () => {
  const { duck, history } = fixture();
  duck.playback('jane', true);
  await vi.advanceTimersByTimeAsync(0);
  expect(history).toEqual([20]);
  duck.playback('jane', false);
  await vi.advanceTimersByTimeAsync(100);
  duck.playback('jane', true);
  await vi.advanceTimersByTimeAsync(100);
  expect(history).toEqual([20]);
  duck.playback('jane', false);
  await vi.advanceTimersByTimeAsync(250);
  expect(history).toEqual([20, 80]);
  await duck.stop();
});
it('fails closed and restores when permission is revoked during speech', async () => {
  let allowed = true;
  const { duck, history } = fixture(async () => allowed);
  duck.playback('jane', true);
  await vi.advanceTimersByTimeAsync(0);
  allowed = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(history).toEqual([20, 80]);
  await duck.stop();
});
it('does not start after an asynchronous approval check outlives the call', async () => {
  let allow!: (value: boolean) => void;
  const { duck, history } = fixture(
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  duck.playback('jane', true);
  await vi.advanceTimersByTimeAsync(0);
  const stopped = duck.stop();
  allow(true);
  await stopped;
  expect(history).toEqual([]);
});
it('serializes restoration before another Dot can start and ignores old stop events', async () => {
  const { duck, history } = fixture();
  duck.playback('jane', true);
  await vi.advanceTimersByTimeAsync(0);
  duck.playback('bob', true);
  await vi.advanceTimersByTimeAsync(0);
  duck.playback('jane', false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(history).toEqual([20, 80, 20]);
  await duck.stop();
  expect(history).toEqual([20, 80, 20, 80]);
});
it('never opens a lease after denied or failed authorization', async () => {
  for (const authorize of [
    async () => false,
    async () => {
      throw new Error('offline');
    },
  ]) {
    const { duck, history } = fixture(authorize);
    duck.playback('jane', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(history).toEqual([]);
    await duck.stop();
  }
});
