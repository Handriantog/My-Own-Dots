import { describe, expect, it } from 'vitest';
import { sampleActivity } from '../../src/desktop/core/activity.js';
import { palmPosition } from '../../src/desktop/core/rig-model.js';
import { rigPointToWorld } from '../../src/desktop/core/pose.js';
import { floor } from './activity-floor-fixture.js';
const bounds = { x: -1000, y: -300, width: 1000, height: 800 };
const workArea = { x: -900, y: -275, width: 800, height: 675 };
const anchor = { x: -990, y: -290 };
const sample = (ms: number, d = floor, reduced = false, area = workArea) =>
  sampleActivity(d, ms, anchor, bounds, reduced, area);
describe('floor walk', () => {
  it('picks up exactly and descends continuously to the usable floor in 2400ms', () => {
    expect(sample(0).pointer).toEqual(anchor);
    expect(sample(1200).root.y).toBeLessThan(399);
    expect(sample(2400).root.y).toBeCloseTo(399, 9);
    let previous = sample(0);
    for (let ms = 16; ms <= 3000; ms += 16) {
      const next = sample(ms);
      expect(
        Math.hypot(
          next.pointer!.x - previous.pointer!.x,
          next.pointer!.y - previous.pointer!.y,
        ),
      ).toBeLessThan(10);
      previous = next;
    }
  });
  it('walks in both directions with grounded distance-driven feet and continuous turns and loops', () => {
    let previous = sample(2400),
      left = false,
      right = false,
      lift = false;
    for (let ms = 2416; ms < 100000; ms += 16) {
      const f = sample(ms),
        dx = f.root.x - previous.root.x;
      left ||= dx < -0.1;
      right ||= dx > 0.1;
      expect(Math.abs(dx)).toBeLessThanOrEqual(66 * 0.016 + 0.001);
      expect(Math.abs(f.pose.facing - previous.pose.facing)).toBeLessThan(0.15);
      for (const foot of [f.pose.leftFoot, f.pose.rightFoot]) {
        const point = rigPointToWorld(foot, f.root, f.pose);
        expect(point.y).toBeLessThanOrEqual(399.000001);
        lift ||= point.y < 398;
      }
      expect(
        Math.min(
          ...[f.pose.leftFoot, f.pose.rightFoot].map((foot) =>
            Math.abs(rigPointToWorld(foot, f.root, f.pose).y - 399),
          ),
        ),
      ).toBeLessThan(0.00001);
      expect(f.pose.rightArm).toBe(-1.05);
      const palm = palmPosition(f.root, f.pose, 'right');
      expect(palm.x).toBeCloseTo(f.pointer!.x, 9);
      expect(palm.y).toBeCloseTo(f.pointer!.y, 9);
      previous = f;
    }
    expect({ left, right, lift }).toEqual({
      left: true,
      right: true,
      lift: true,
    });
    for (const ms of [24000, 48000, 72000])
      expect(
        Math.hypot(
          sample(ms).root.x - sample(ms - 1).root.x,
          sample(ms).root.y - sample(ms - 1).root.y,
        ),
      ).toBeLessThan(0.1);
  });
  it.each(['left', 'right', undefined] as const)(
    'bounds %s hands and pointerless travel, including narrow areas',
    (hand) => {
      const d = {
        ...floor,
        pointer: hand ? { hand, idleMs: 5000 } : undefined,
      };
      for (const area of [
        workArea,
        { x: -600, y: -200, width: 100, height: 500 },
        { x: -600, y: -200, width: 20, height: 40 },
      ])
        for (let ms = 2400; ms < 60000; ms += 137) {
          const f = sample(ms, d, false, area);
          for (const p of [f.root, ...(f.pointer ? [f.pointer] : [])]) {
            expect(Number.isFinite(p.x + p.y)).toBe(true);
            expect(p.x).toBeGreaterThanOrEqual(area.x);
            expect(p.x).toBeLessThan(area.x + area.width);
            expect(p.y).toBeGreaterThanOrEqual(area.y);
            expect(p.y).toBeLessThan(area.y + area.height);
          }
          if (!hand) expect(f.pointer).toBeUndefined();
        }
    },
  );
  it('reduces travel while retaining movement, and freezes non-loop motion at duration', () => {
    const normal = Math.abs(sample(6000).root.x - sample(2400).root.x),
      reduced = Math.abs(
        sample(6000, floor, true).root.x - sample(2400, floor, true).root.x,
      );
    expect(reduced).toBeGreaterThan(0);
    expect(reduced).toBeLessThan(normal);
    const once = { ...floor, loop: false };
    expect(sample(50000, once)).toEqual(sample(24000, once));
  });
});

it('decelerates smoothly even when the available route is only one pixel wide', () => {
  const area = { x: -600, y: -200, width: 100, height: 500 };
  let previous = sample(2400, floor, false, area);
  for (let ms = 2416; ms < 10000; ms += 16) {
    const next = sample(ms, floor, false, area);
    expect(
      Math.abs(next.velocity!.x - previous.velocity!.x),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(next.pose.facing - previous.pose.facing)).toBeLessThan(
      0.15,
    );
    previous = next;
  }
});
