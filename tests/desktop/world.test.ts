import { describe, expect, it } from 'vitest';
import { buildWorld, supportAt } from '../../src/desktop/core/world.js';
import { display, snapshot, windowRect } from './fixtures.js';

describe('exposed playground', () => {
  it('offers floor and a window top with foot clearance, never a solid window interior', () => {
    const world = buildWorld(snapshot([windowRect(1, 200, 250)]), [display], 0);
    expect(world.platforms.map((p) => [p.x1, p.x2, p.y])).toEqual([
      [52, 1388, 900],
      [219, 681, 250],
    ]);
    expect(world.walls).toHaveLength(2);
  });
  it('subtracts occlusion and body clearance from the lower window', () => {
    const world = buildWorld(
      snapshot([
        windowRect(2, 450, 200, 200, 400),
        windowRect(1, 100, 350, 900),
      ]),
      [display],
      0,
    );
    const lower = world.platforms.filter((p) => p.windowKey?.includes(':1:'));
    expect(lower.map((p) => [p.x1, p.x2])).toEqual([
      [119, 398],
      [702, 981],
    ]);
    expect(lower.every((p) => p.x2 <= 398 || p.x1 >= 702)).toBe(true);
  });
  it('rejects narrow edges and ceiling perches', () => {
    const world = buildWorld(
      snapshot([windowRect(1, 0, 25, 1440), windowRect(2, 50, 300, 30)]),
      [display],
      0,
    );
    expect(world.platforms.filter((p) => p.windowKey)).toHaveLength(0);
  });
  it('uses actual screen edges including negative display coordinates', () => {
    const left = {
      ...display,
      id: '2',
      bounds: { ...display.bounds, x: -1440 },
      workArea: { ...display.workArea, x: -1440 },
    };
    expect(buildWorld(null, [left], 0).platforms[0]).toMatchObject({
      x1: -1388,
      x2: -52,
      y: 900,
      displayId: '2',
    });
  });
  it('limits a Dock perch to its observed footprint and keeps the real floor below its ends', () => {
    const world = buildWorld(
      snapshot([], {
        docks: [
          {
            id: 'list',
            displayId: '1',
            bounds: { x: 400, y: 830, width: 600, height: 70 },
          },
        ],
      }),
      [display],
      0,
    );
    expect(world.platforms).toEqual([
      { id: 'floor:1', x1: 52, x2: 1388, y: 900, displayId: '1' },
      { id: 'dock:1:list', x1: 419, x2: 981, y: 830, displayId: '1' },
    ]);
    expect(supportAt(world, 418, 830, '1')).toBeNull();
    expect(supportAt(world, 982, 830, '1')).toBeNull();
    expect(supportAt(world, 418, 900, '1')?.id).toBe('floor:1');
    expect(world.walls).toHaveLength(0);
  });
  it('removes Dock support on invalidation, hide, or expired observations', () => {
    const docks = [
      {
        id: 'list',
        displayId: '1',
        bounds: { x: 400, y: 830, width: 600, height: 70 },
      },
    ];
    for (const scene of [
      null,
      snapshot([], { docks: [] }),
      snapshot([], { docks, sceneValid: false }),
    ]) {
      expect(
        buildWorld(scene, [display], 0).platforms.map((p) => p.id),
      ).toEqual(['floor:1']);
    }
  });
  it('never treats a full-screen Dock backing container as a platform', () => {
    const world = buildWorld(
      snapshot([], {
        docks: [{ id: 'backing', displayId: '1', bounds: display.bounds }],
      }),
      [display],
      0,
    );
    expect(world.platforms.map((p) => p.id)).toEqual(['floor:1']);
  });
  it('keeps a measured Dock footprint independent of application-window tracking', () => {
    const world = buildWorld(
      snapshot([], {
        accessibility: false,
        docks: [
          {
            id: 'list',
            displayId: '1',
            bounds: { x: 400, y: 830, width: 600, height: 70 },
          },
        ],
      }),
      [display],
      0,
    );
    expect(supportAt(world, 600, 830, '1')?.id).toBe('dock:1:list');
    expect(world.tracking).toBe('floor');
  });
  it('handles side Dock geometry without moving the screen floor inwards', () => {
    const left = {
      ...display,
      bounds: { x: -1440, y: -100, width: 1440, height: 900 },
      workArea: { x: -1370, y: -75, width: 1370, height: 875 },
    };
    const world = buildWorld(
      snapshot([], {
        docks: [
          {
            id: 'side',
            displayId: '1',
            bounds: { x: -1440, y: 200, width: 70, height: 450 },
          },
        ],
      }),
      [left],
      0,
    );
    expect(world.platforms[0]).toMatchObject({ x1: -1388, x2: -52, y: 800 });
    expect(world.platforms).toHaveLength(1);
    const wide = buildWorld(
      snapshot([], {
        docks: [
          {
            id: 'side',
            displayId: '1',
            bounds: { x: -1440, y: 200, width: 120, height: 450 },
          },
        ],
      }),
      [left],
      0,
    );
    expect(wide.platforms[1]).toMatchObject({ x1: -1388, x2: -1339, y: 200 });
  });
  it('uses only floors for absent/unauthorized/invalid scenes', () => {
    for (const scene of [
      null,
      snapshot([windowRect(1, 100, 300)], { accessibility: false }),
      snapshot([windowRect(1, 100, 300)], { sceneValid: false }),
    ]) {
      const world = buildWorld(scene, [display], 0);
      expect(world.platforms).toHaveLength(1);
      expect(world.walls).toHaveLength(0);
      expect(world.tracking).toBe('floor');
    }
  });
  it('does not inherit a contact after window identity reuse or a helper restart', () => {
    const first = buildWorld(snapshot([windowRect(1, 100, 300)]), [display], 0)
      .platforms[1];
    const reused = buildWorld(
      snapshot([{ ...windowRect(1, 100, 300), generation: 2 }]),
      [display],
      0,
    ).platforms[1];
    const restarted = buildWorld(
      snapshot([windowRect(1, 100, 300)], { helperSession: 'b' }),
      [display],
      0,
    ).platforms[1];
    expect(first.windowKey).not.toBe(reused.windowKey);
    expect(first.windowKey).not.toBe(restarted.windowKey);
  });
  it('excludes owned windows and removes covered climb edges', () => {
    const world = buildWorld(
      snapshot([
        windowRect(2, 50, 200, 200, 400),
        windowRect(1, 100, 300, 500, 400),
      ]),
      [display],
      0,
    );
    const left = world.walls.filter(
      (w) => w.windowKey.includes(':1:') && w.side === -1,
    );
    expect(left.every((w) => w.y1 >= 656)).toBe(true);
    expect(
      buildWorld(
        snapshot([windowRect(1, 100, 300)]),
        [display],
        0,
        new Set([42]),
      ).walls,
    ).toHaveLength(0);
  });
});
