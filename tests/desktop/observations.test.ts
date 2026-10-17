import { describe, expect, it } from 'vitest';
import { ObservationStream } from '../../src/desktop/core/observations.js';

export function scene(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    helperSession: 'session-a',
    seq: 1,
    observedAtMs: 500,
    sceneRevision: 0,
    pollIntervalMs: 100,
    accessibility: true,
    sceneValid: true,
    displays: [
      {
        id: '1',
        bounds: { x: -1440, y: 0, width: 1440, height: 900 },
        workArea: { x: -1440, y: 25, width: 1440, height: 825 },
        scaleFactor: 2,
      },
    ],
    windows: [
      {
        id: 3,
        ownerPid: 42,
        generation: 1,
        bounds: { x: -1100, y: 240, width: 600, height: 400 },
        opaque: true,
      },
    ],
    ...overrides,
  };
}

describe('native observation stream', () => {
  it('accepts global coordinates and maps the helper clock to the host clock', () => {
    const stream = new ObservationStream();
    expect(stream.accept(scene(), 8000)?.displays[0].bounds.x).toBe(-1440);
    expect(stream.current(8499)?.seq).toBe(1);
    expect(stream.current(8501)).toBeNull();
  });
  it('rejects malformed, nonfinite and oversized scenes without replacing good data', () => {
    const stream = new ObservationStream();
    stream.accept(scene(), 0);
    for (const invalid of [
      null,
      {},
      scene({ protocolVersion: 2 }),
      scene({ seq: -1 }),
      scene({ observedAtMs: Infinity }),
      scene({ windows: Array(2049).fill(scene().windows[0]) }),
      scene({ displays: [{ ...scene().displays[0], scaleFactor: 0 }] }),
    ]) {
      expect(stream.accept(invalid, 100)).toBeNull();
    }
    expect(stream.current(200)?.seq).toBe(1);
  });
  it('rejects duplicate/out-of-order frames and unsolicited session switches', () => {
    const stream = new ObservationStream();
    stream.accept(scene({ seq: 4 }), 0);
    expect(stream.accept(scene({ seq: 3 }), 100)).toBeNull();
    expect(stream.accept(scene({ seq: 4 }), 100)).toBeNull();
    expect(
      stream.accept(scene({ helperSession: 'session-b', seq: 5 }), 100),
    ).toBeNull();
    stream.resetSession();
    expect(stream.accept(scene({ helperSession: 'session-b' }), 100)?.seq).toBe(
      1,
    );
  });
  it('uses idle grace but immediately publishes permission and scene invalidation', () => {
    const stream = new ObservationStream();
    stream.accept(scene({ pollIntervalMs: 500 }), 10);
    expect(stream.current(1509)).not.toBeNull();
    expect(stream.current(1511)).toBeNull();
    stream.accept(
      scene({ seq: 2, observedAtMs: 2490, accessibility: false }),
      2000,
    );
    expect(stream.current(2001)?.accessibility).toBe(false);
    stream.accept(
      scene({ seq: 3, observedAtMs: 2500, sceneValid: false }),
      2010,
    );
    expect(stream.current(2011)?.sceneValid).toBe(false);
  });
  it('does not revive queued observations after a host stall, but accepts a fresh sample', () => {
    const stream = new ObservationStream();
    stream.accept(scene({ observedAtMs: 1000 }), 0);
    expect(stream.current(10000)).toBeNull();
    expect(
      stream.accept(scene({ seq: 2, observedAtMs: 1100 }), 10000),
    ).toBeNull();
    expect(stream.current(10000)).toBeNull();
    expect(
      stream.accept(scene({ seq: 3, observedAtMs: 11000 }), 10001)?.seq,
    ).toBe(3);
    expect(stream.current(10501)).toBeNull();
  });
  it('tightens the session clock offset when delivery gets faster, including idle cadence', () => {
    const stream = new ObservationStream();
    stream.accept(scene({ observedAtMs: 1000, pollIntervalMs: 500 }), 200);
    stream.accept(
      scene({ seq: 2, observedAtMs: 2000, pollIntervalMs: 500 }),
      1000,
    );
    expect(stream.current(2501)).toBeNull();
    expect(
      stream.accept(
        scene({ seq: 3, observedAtMs: 2100, pollIntervalMs: 500 }),
        3000,
      ),
    ).toBeNull();
    stream.resetSession();
    expect(
      stream.accept(scene({ helperSession: 'new', observedAtMs: 20 }), 3100)
        ?.seq,
    ).toBe(1);
  });
  it('rejects backward scene revisions, duplicate window identities and absurd geometry', () => {
    const stream = new ObservationStream();
    stream.accept(scene({ sceneRevision: 2 }), 0);
    expect(stream.accept(scene({ seq: 2, sceneRevision: 1 }), 1)).toBeNull();
    expect(
      stream.accept(
        scene({
          seq: 2,
          sceneRevision: 2,
          windows: [scene().windows[0], scene().windows[0]],
        }),
        1,
      ),
    ).toBeNull();
    expect(
      stream.accept(
        scene({
          seq: 2,
          sceneRevision: 2,
          windows: [
            {
              ...scene().windows[0],
              bounds: { x: 0, y: 0, width: -1, height: 10 },
            },
          ],
        }),
        1,
      ),
    ).toBeNull();
  });
});
