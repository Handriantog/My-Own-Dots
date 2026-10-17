import { describe, expect, it } from 'vitest';
import { PettingGesture } from '../../src/desktop/core/affection.js';
import { CompanionSimulation } from '../../src/desktop/core/simulation.js';
import { buildWorld } from '../../src/desktop/core/world.js';
import {
  initialPose,
  rigPointToWorld,
  samplePose,
  worldPointToRig,
} from '../../src/desktop/core/pose.js';
import {
  chooseIntention,
  seededRandom,
} from '../../src/desktop/core/behavior.js';
import { display } from './fixtures.js';

describe('affection and curiosity', () => {
  it('accepts active petting after nearby attention has ended and walking resumes', () => {
    const sim = new CompanionSimulation(buildWorld(null, [display], 0), 7);
    sim.advance(0);
    let time = 0;
    while (time < 10000) {
      const root = sim.frame().root;
      sim.pointer({
        kind: 'hover',
        point: { x: root.x + 100, y: root.y - 60 },
        atMs: time + 16,
      });
      sim.advance((time += 16));
      if (time > 1200 && Math.abs(sim.frame().velocity.x) > 40) break;
    }
    expect(sim.frame().action).toBe('walk');
    for (let n = 1; n <= 50; n++) {
      const root = sim.frame().root;
      sim.pointer({
        kind: 'hover',
        point: { x: root.x + Math.sin(n / 5) * 20, y: root.y - 75 },
        atMs: time + 16,
      });
      sim.advance((time += 16));
    }
    expect(sim.frame().action).toBe('pet');
  });
  it('keeps both soles on a ledge while peeking and returning upright', () => {
    let pose = initialPose();
    for (let n = 0; n < 240; n++) {
      pose = samplePose(
        pose,
        {
          action: n < 120 ? 'peek' : 'idle',
          age: n / 120,
          speed: 0,
          distance: 0,
          facing: 1,
          time: 1,
          sway: 0,
          reducedMotion: false,
        },
        1 / 120,
      );
      for (const foot of [pose.leftFoot, pose.rightFoot])
        expect(
          Math.abs(rigPointToWorld(foot, { x: 0, y: 0 }, pose).y),
        ).toBeLessThan(0.05);
    }
  });
  it('moves a waving/grooming paw continuously between distant gestures', () => {
    let pose = initialPose(),
      previous: { x: number; y: number } | undefined;
    for (let n = 0; n < 240; n++) {
      pose = samplePose(
        pose,
        {
          action: n < 120 ? 'headphones' : 'groom',
          age: n / 60,
          speed: 0,
          distance: 0,
          facing: 1,
          time: 1,
          sway: 0,
          reducedMotion: false,
        },
        1 / 60,
      );
      const x = -5.06,
        y = pose.leftArmLength * 0.86;
      const palm = rigPointToWorld(
        {
          x: -39 + x * Math.cos(pose.leftArm) - y * Math.sin(pose.leftArm),
          y: -45 + x * Math.sin(pose.leftArm) + y * Math.cos(pose.leftArm),
        },
        { x: 0, y: 0 },
        pose,
      );
      if (previous)
        expect(
          Math.hypot(palm.x - previous.x, palm.y - previous.y),
        ).toBeLessThan(8);
      previous = palm;
    }
  });
  it('requires repeated strokes, not a stationary hover or a single pass', () => {
    const pet = new PettingGesture();
    for (let n = 0; n < 60; n++)
      expect(pet.sample({ x: 0, y: 0 }, n * 16, true)).toBe(false);
    for (let n = 0; n < 10; n++)
      expect(pet.sample({ x: n * 4, y: 0 }, 1000 + n * 16, true)).toBe(false);
    pet.reset();
    const hits: number[] = [];
    for (let n = 0; n < 90; n++)
      if (pet.sample({ x: Math.sin(n / 5) * 20, y: 0 }, n * 16, true))
        hits.push(n * 16);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits[0]).toBeGreaterThan(250);
  });
  it('does not accumulate strokes outside the body, during drag, or across a discontinuity', () => {
    const pet = new PettingGesture();
    for (let n = 0; n < 60; n++)
      expect(pet.sample({ x: Math.sin(n / 5) * 20, y: 0 }, n * 16, false)).toBe(
        false,
      );
    expect(pet.sample({ x: 10000, y: 0 }, 1000, true)).toBe(false);
    expect(pet.sample({ x: 0, y: 0 }, 1016, true)).toBe(false);
  });
  it('tracks the nearby pointer smoothly and returns gaze when it leaves', () => {
    const sim = new CompanionSimulation(buildWorld(null, [display], 0), 1);
    sim.setOptions({ paused: true, reducedMotion: false });
    sim.advance(0);
    const root = sim.frame().root;
    for (let n = 1; n <= 30; n++) {
      sim.pointer({
        kind: 'hover',
        point: { x: root.x + 80, y: root.y - 90 },
        atMs: n * 16,
      });
      sim.advance(n * 16);
    }
    const pose = sim.frame().pose;
    expect(pose.look.x).toBeGreaterThan(0.4);
    expect(pose.look.y).toBeLessThan(-0.1);
    sim.pointer({
      kind: 'hover',
      point: { x: root.x + 800, y: root.y },
      atMs: 500,
    });
    for (let n = 31; n < 70; n++) sim.advance(n * 16);
    expect(Math.abs(sim.frame().pose.look.x)).toBeLessThan(0.03);
  });
  it('rubbing emits bounded heart bubbles and one cue per burst, then expires without replay', () => {
    const sim = new CompanionSimulation(buildWorld(null, [display], 0), 1);
    sim.setOptions({ paused: true, reducedMotion: false });
    sim.advance(0);
    sim.drainEvents();
    const root = sim.frame().root;
    for (let n = 1; n <= 90; n++) {
      sim.pointer({
        kind: 'hover',
        point: { x: root.x + Math.sin(n / 5) * 20, y: root.y - 78 },
        atMs: n * 16,
      });
      sim.advance(n * 16);
    }
    const frame = sim.frame();
    expect(frame.action).toBe('pet');
    expect(frame.pose.love).toBeGreaterThan(0.5);
    expect(frame.hearts.length).toBeGreaterThan(0);
    expect(frame.hearts.length).toBeLessThanOrEqual(3);
    expect(frame.hearts[0].origin.x).toBeGreaterThan(root.x);
    expect(
      sim.drainEvents().filter((e) => e.name === 'pat').length,
    ).toBeLessThanOrEqual(2);
    sim.suspend();
    sim.resume(10000);
    sim.advance(10016);
    expect(sim.frame().hearts).toHaveLength(0);
    expect(sim.drainEvents()).toHaveLength(0);
  });
  it('seats the rump at the floor with feet in front instead of shrinking the whole body', () => {
    for (const action of ['sit', 'sleep'] as const) {
      let pose = initialPose();
      for (let n = 0; n < 180; n++)
        pose = samplePose(
          pose,
          {
            action,
            age: n / 120,
            speed: 0,
            distance: 0,
            facing: 1,
            time: 1,
            sway: 0,
            reducedMotion: false,
          },
          1 / 120,
        );
      expect(pose.seated).toBeGreaterThan(0.99);
      expect(pose.stretch).toBeGreaterThan(0.94);
      expect(
        rigPointToWorld({ x: 0, y: -7 }, { x: 0, y: 0 }, pose).y,
      ).toBeCloseTo(0, 1);
      expect(
        rigPointToWorld(pose.leftFoot, { x: 0, y: 0 }, pose).y,
      ).toBeCloseTo(0, 1);
      const local = { x: 17, y: -83 },
        root = { x: -500, y: 400 };
      const roundtrip = worldPointToRig(
        rigPointToWorld(local, root, pose),
        root,
        pose,
      );
      expect(roundtrip.x).toBeCloseTo(local.x);
      expect(roundtrip.y).toBeCloseTo(local.y);
    }
  });
  it('offers varied playful rests and only peeks when a ledge supports it', () => {
    const w = buildWorld(null, [display], 0),
      sim = new CompanionSimulation(w, 1),
      random = seededRandom(42);
    const actions = new Set<string>();
    for (let n = 0; n < 1000; n++) {
      const i = chooseIntention(sim.frame(), w, random);
      if (i.kind === 'rest') actions.add(i.action);
    }
    for (const action of ['look_around', 'wave', 'groom', 'headphones'])
      expect(actions.has(action)).toBe(true);
    expect(actions.has('peek')).toBe(false);
  });
});
