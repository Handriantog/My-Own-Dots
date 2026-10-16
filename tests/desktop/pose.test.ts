import { describe, expect, it } from 'vitest';
import {
  initialPose,
  samplePose,
  rigPointToWorld,
  worldPointToRig,
} from '../../src/desktop/core/pose.js';

describe('continuous rig pose', () => {
  it('blends pickup from the current pose instead of resetting it', () => {
    const pose = { ...initialPose(), lean: 0.2, leftArm: 0.6 };
    const next = samplePose(
      pose,
      {
        action: 'held',
        age: 0,
        speed: 0,
        distance: 0,
        facing: 1,
        time: 0,
        sway: -0.2,
        reducedMotion: false,
      },
      1 / 120,
    );
    expect(Math.abs(next.lean - pose.lean)).toBeLessThan(0.05);
    expect(next.pinch).toBeGreaterThan(0);
    expect(next.pinch).toBeLessThan(0.2);
    expect(next.stretch).toBeLessThan(1.03);
  });
  it('keeps a stance foot planted as the body advances', () => {
    const input = {
      action: 'walk' as const,
      age: 1,
      speed: 60,
      distance: 6,
      facing: 1 as const,
      time: 1,
      sway: 0,
      reducedMotion: false,
    };
    const p1 = samplePose(initialPose(), input, 1);
    const p2 = samplePose(p1, { ...input, distance: 7 }, 1 / 60);
    expect(100 + p1.leftFoot.x).toBeCloseTo(101 + p2.leftFoot.x, 3);
  });
  it('round-trips a grip through bounded rotation and stretch', () => {
    const pose = { ...initialPose(), lean: 0.2, stretch: 1.1, squash: 0.95 };
    const root = { x: -300, y: 400 },
      local = { x: 30, y: -80 };
    const p = worldPointToRig(rigPointToWorld(local, root, pose), root, pose);
    expect(p.x).toBeCloseTo(local.x);
    expect(p.y).toBeCloseTo(local.y);
  });
  it('does not snap either foot when beginning a walk from rest', () => {
    const previous = initialPose();
    const next = samplePose(
      previous,
      {
        action: 'walk',
        age: 0,
        speed: 2,
        distance: 0.01,
        facing: 1,
        time: 1,
        sway: 0,
        reducedMotion: false,
      },
      1 / 120,
    );
    expect(
      Math.hypot(
        next.leftFoot.x - previous.leftFoot.x,
        next.leftFoot.y - previous.leftFoot.y,
      ),
    ).toBeLessThan(2);
    expect(
      Math.hypot(
        next.rightFoot.x - previous.rightFoot.x,
        next.rightFoot.y - previous.rightFoot.y,
      ),
    ).toBeLessThan(2);
  });
  it('gives a click a visible soft acknowledgment without moving the feet', () => {
    const pose = samplePose(
      initialPose(),
      {
        action: 'pat',
        age: 0.12,
        speed: 0,
        distance: 0,
        facing: 1,
        time: 1,
        sway: 0,
        reducedMotion: false,
      },
      0.1,
    );
    expect(pose.stretch).toBeLessThan(0.98);
    expect(pose.squash).toBeGreaterThan(1.02);
    expect(pose.leftFoot.y).toBe(0);
    expect(pose.rightFoot.y).toBe(0);
  });
});
