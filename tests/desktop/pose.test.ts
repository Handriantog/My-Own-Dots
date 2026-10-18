import { describe, expect, it } from 'vitest';
import {
  initialPose,
  samplePose,
  rigPointToWorld,
  worldPointToRig,
} from '../../src/desktop/core/pose.js';

describe('continuous rig pose', () => {
  it('speaks with small, smooth mouth movements and rests back in a smile', () => {
    let pose = initialPose();
    const openings: number[] = [];
    const input = {
      action: 'idle' as const,
      age: 1,
      speed: 0,
      distance: 0,
      facing: 1 as const,
      time: 0,
      sway: 0,
      reducedMotion: false,
      voice: 'speaking' as const,
    };
    for (let n = 0; n < 360; n++) {
      const next = samplePose(pose, { ...input, time: n / 60 }, 1 / 60);
      expect(Math.abs(next.speech - pose.speech)).toBeLessThan(0.23);
      expect(next.mouth).toBe(0); // Speech does not use the surprise/yawn oval.
      openings.push(next.speech);
      pose = next;
    }
    expect(Math.max(...openings)).toBeGreaterThan(0.45);
    expect(Math.max(...openings)).toBeLessThan(0.85);
    expect(Math.min(...openings.slice(60))).toBeLessThan(0.04);
    for (let n = 0; n < 60; n++)
      pose = samplePose(pose, { ...input, voice: 'listening' }, 1 / 60);
    expect(pose.speech).toBeLessThan(0.001);
  });
  it('keeps the speaking mouth still with reduced motion enabled', () => {
    let pose = initialPose();
    const openings: number[] = [];
    for (let n = 0; n < 240; n++) {
      pose = samplePose(
        pose,
        {
          action: 'idle',
          age: 1,
          speed: 0,
          distance: 0,
          facing: 1,
          time: n / 60,
          sway: 0,
          reducedMotion: true,
          voice: 'speaking',
        },
        1 / 60,
      );
      if (n > 120) openings.push(pose.speech);
    }
    expect(openings[0]).toBeGreaterThan(0);
    expect(Math.max(...openings) - Math.min(...openings)).toBeLessThan(0.001);
  });
  it('keeps a gentle wide-eyed awe expression throughout a long pickup', () => {
    let pose = initialPose();
    for (let n = 0; n < 600; n++)
      pose = samplePose(
        pose,
        {
          action: 'held',
          age: n / 120,
          speed: 0,
          distance: 0,
          facing: 1,
          time: n / 120 + 1,
          sway: 0,
          reducedMotion: false,
        },
        1 / 120,
      );
    expect(pose.mouth).toBeGreaterThan(0.9);
    expect(pose.eyeOpen).toBeGreaterThan(1.05);
  });
  it('keeps little walking feet beneath the body and counter-swings the arms', () => {
    let pose = initialPose();
    let maxReach = 0,
      oppositeSwing = 0;
    for (let n = 0; n < 480; n++) {
      pose = samplePose(
        pose,
        {
          action: 'walk',
          age: n / 120,
          speed: 60,
          distance: n / 2,
          facing: 1,
          time: n / 120 + 1,
          sway: 0,
          reducedMotion: false,
        },
        1 / 120,
      );
      maxReach = Math.max(
        maxReach,
        Math.abs(pose.leftFoot.x),
        Math.abs(pose.rightFoot.x),
      );
      if (pose.leftArm * pose.rightArm < -0.005) oppositeSwing++;
    }
    expect(maxReach).toBeLessThanOrEqual(33);
    expect(oppositeSwing).toBeGreaterThan(100);
  });
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
    expect(rigPointToWorld(p1.leftFoot, { x: 100, y: 0 }, p1).x).toBeCloseTo(
      rigPointToWorld(p2.leftFoot, { x: 101, y: 0 }, p2).x,
      3,
    );
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
