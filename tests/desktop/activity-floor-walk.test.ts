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

const reviewBounds = { x: 0, y: 0, width: 1000, height: 650 };
const reviewArea = { x: 0, y: 25, width: 1000, height: 525 };
it.each(['left', 'right'] as const)(
  'keeps %s downward carries grounded by shortening only the blocked reach',
  (hand) => {
    const activity = structuredClone(floor);
    activity.pointer!.hand = hand;
    for (const frame of activity.keyframes) {
      frame.pose.leftArm = frame.pose.rightArm = 0;
      frame.pose.leftArmLength = frame.pose.rightArmLength = 70;
    }
    const f = sampleActivity(
      activity,
      6000,
      { x: 500, y: 200 },
      reviewBounds,
      false,
      reviewArea,
    );
    expect(f.root.y).toBeCloseTo(549, 9);
    const soles = [f.pose.leftFoot, f.pose.rightFoot].map(
      (p) => rigPointToWorld(p, f.root, f.pose).y,
    );
    expect(Math.max(...soles)).toBeCloseTo(549, 9);
    expect(f.pointer!.y).toBeCloseTo(549, 9);
    expect(palmPosition(f.root, f.pose, hand).y).toBeCloseTo(f.pointer!.y, 9);
    const length = hand === 'left' ? 'leftArmLength' : 'rightArmLength';
    const other = hand === 'left' ? 'rightArmLength' : 'leftArmLength';
    expect(f.pose[length]).toBeLessThan(70);
    expect(f.pose[length]).toBeGreaterThan(45);
    expect(f.pose[other]).toBe(70);
    expect(f.pose.leftArm).toBe(0);
    expect(f.pose.rightArm).toBe(0);
    // Any longer reach would put the palm below the floor: adjust only enough.
    expect(
      palmPosition(f.root, { ...f.pose, [length]: f.pose[length] + 0.01 }, hand)
        .y,
    ).toBeGreaterThan(549);
    for (const frame of activity.keyframes)
      frame.pose[hand === 'left' ? 'leftArm' : 'rightArm'] = -1.3;
    const fitting = sampleActivity(
      activity,
      6000,
      { x: 500, y: 200 },
      reviewBounds,
      false,
      reviewArea,
    );
    expect(fitting.pose[length]).toBe(70);
    expect(fitting.pose[other]).toBe(70);
    expect(fitting.root.y).toBeCloseTo(549, 9);
  },
);
it.each(['left', 'right'] as const)(
  'keeps the floor and palm continuous as the %s arm crosses the floor limit',
  (hand) => {
    const activity = structuredClone(floor);
    activity.pointer!.hand = hand;
    const angle = hand === 'left' ? 'leftArm' : 'rightArm';
    const length = hand === 'left' ? 'leftArmLength' : 'rightArmLength';
    activity.keyframes = [0, 0.5, 1].map((at) => ({
      ...activity.keyframes[0],
      at,
      pose: {
        ...activity.keyframes[0].pose,
        [angle]: at === 0.5 ? 0 : -1.3,
        [length]: 70,
      },
    }));
    const sample = (ms: number) =>
      sampleActivity(
        activity,
        ms,
        { x: 500, y: 200 },
        reviewBounds,
        false,
        reviewArea,
      );
    expect(sample(0).pointer).toEqual({ x: 500, y: 200 });
    let previous = sample(2400),
      shortened = false,
      unchanged = false;
    for (let ms = 2416; ms <= 48000; ms += 16) {
      const f = sample(ms);
      expect(f.root.y).toBeCloseTo(549, 9);
      expect(
        Math.max(
          ...[f.pose.leftFoot, f.pose.rightFoot].map(
            (p) => rigPointToWorld(p, f.root, f.pose).y,
          ),
        ),
      ).toBeCloseTo(549, 9);
      expect(f.pointer!.y).toBeLessThanOrEqual(549.000000001);
      expect(f.pointer!.y).toBeGreaterThanOrEqual(25);
      const palm = palmPosition(f.root, f.pose, hand);
      expect(palm.x).toBeCloseTo(f.pointer!.x, 9);
      expect(palm.y).toBeCloseTo(f.pointer!.y, 9);
      expect(Math.abs(f.pose[length] - previous.pose[length])).toBeLessThan(
        0.5,
      );
      expect(
        Math.hypot(
          f.pointer!.x - previous.pointer!.x,
          f.pointer!.y - previous.pointer!.y,
        ),
      ).toBeLessThan(2);
      shortened ||= f.pose[length] < 69;
      unchanged ||= f.pose[length] === 70;
      previous = f;
    }
    expect({ shortened, unchanged }).toEqual({
      shortened: true,
      unchanged: true,
    });
  },
);
