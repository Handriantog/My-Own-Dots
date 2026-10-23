import { describe, expect, it } from 'vitest';
import { definition } from './activity-fixture.js';
import {
  sampleActivity,
  approachActivity,
} from '../../src/desktop/core/activity.js';
import { palmPosition } from '../../src/desktop/core/rig-model.js';
import { initialPose } from '../../src/desktop/core/pose.js';

const bounds = { x: -1000, y: -300, width: 1000, height: 800 };
describe('definition-driven activity geometry', () => {
  it('has a hand-checked pickup and interpolates package poses and paths', () => {
    const start = sampleActivity(
      definition,
      0,
      { x: -500, y: 0 },
      bounds,
      false,
    );
    expect(start.pointer).toEqual({ x: -500, y: 0 });
    expect(start.root.x).toBeCloseTo(-544.06);
    expect(start.root.y).toBeCloseTo(15.76);
    const half = sampleActivity(
      definition,
      500,
      { x: -500, y: 0 },
      bounds,
      false,
    );
    expect(half.pointer).toEqual({ x: -450, y: -25 });
    expect(half.pose.rightArm).toBe(0.5);
    expect(half.pose.rightFoot.y).toBe(-4);
    expect(palmPosition(half.root, half.pose, 'right')).toEqual(half.pointer);
  });
  it('keeps cursor bounded at negative-origin display edges without a pickup jump', () => {
    for (const anchor of [
      { x: -1000, y: -300 },
      { x: -1, y: 499 },
    ]) {
      expect(
        sampleActivity(definition, 0, anchor, bounds, false).pointer,
      ).toEqual(anchor);
      for (let ms = 0; ms < 5000; ms += 17) {
        const f = sampleActivity(definition, ms, anchor, bounds, false);
        expect(f.pointer!.x).toBeGreaterThanOrEqual(-1000);
        expect(f.pointer!.x).toBeLessThanOrEqual(-1);
        expect(f.pointer!.y).toBeGreaterThanOrEqual(-300);
        expect(f.pointer!.y).toBeLessThanOrEqual(499);
        const palm = palmPosition(f.root, f.pose, 'right');
        expect(palm.x).toBeCloseTo(f.pointer!.x, 10);
        expect(palm.y).toBeCloseTo(f.pointer!.y, 10);
      }
    }
  });
  it('brings an edge pickup gently back into visible bounds', () => {
    const anchor = { x: -1000, y: -300 };
    const early = sampleActivity(definition, 1, anchor, bounds, false);
    expect(Math.abs(early.pointer!.x - anchor.x)).toBeLessThan(1);
    const settled = sampleActivity(definition, 4000, anchor, bounds, false);
    expect(settled.root.x).toBeGreaterThanOrEqual(bounds.x + 60);
    expect(settled.root.y).toBeGreaterThanOrEqual(bounds.y + 112);
  });
  it('executes another definition, loops continuously and reduces motion', () => {
    const other = structuredClone(definition);
    other.pointer!.hand = 'left';
    other.motion = { width: 80, height: 300 };
    other.keyframes[1].pose.leftArm = -2;
    other.keyframes[1].x = -1;
    other.keyframes[1].y = 1;
    const f = sampleActivity(other, 1000, { x: -500, y: 0 }, bounds, false);
    expect(f.pointer).toEqual({ x: -540, y: 150 });
    expect(f.pose.leftArm).toBe(-2);
    expect(
      sampleActivity(other, 2000, { x: -500, y: 0 }, bounds, false),
    ).toEqual(sampleActivity(other, 0, { x: -500, y: 0 }, bounds, false));
    const reduced = sampleActivity(
      other,
      1000,
      { x: -500, y: 0 },
      bounds,
      true,
    );
    expect(Math.abs(reduced.pointer!.y)).toBeLessThan(150);
  });
  it('approaches smoothly from actual rig pose without moving cursor before contact', () => {
    const target = sampleActivity(
      definition,
      0,
      { x: -500, y: 0 },
      bounds,
      false,
    );
    const from = { root: { x: -800, y: 400 }, pose: initialPose() };
    expect(approachActivity(from, target, 0)).toMatchObject(from);
    expect(approachActivity(from, target, 1)).toMatchObject({
      root: target.root,
      pose: target.pose,
    });
    expect(approachActivity(from, target, 0.5).root.x).toBeCloseTo(
      (from.root.x + target.root.x) / 2,
    );
  });
});
