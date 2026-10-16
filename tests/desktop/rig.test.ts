import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deformFurVertex,
  hitTestRig,
  layerTint,
  parseRig,
} from '../../src/desktop/core/rig-model.js';
import { CompanionSimulation } from '../../src/desktop/core/simulation.js';
import { buildWorld } from '../../src/desktop/core/world.js';
import { display } from './fixtures.js';

const rigData = () =>
  JSON.parse(
    readFileSync(
      new URL('../../public/desktop-dot/rig.json', import.meta.url),
      'utf8',
    ),
  );
describe('master plush asset contract', () => {
  it('requires every separate layer with valid atlas bounds and pivots', () => {
    const data = rigData();
    expect(parseRig(data).layers.body.tint).toBe(true);
    delete data.layers.headphones;
    expect(() => parseRig(data)).toThrow();
    const invalid = rigData();
    invalid.layers.body.frame.width = 99999;
    expect(() => parseRig(invalid)).toThrow();
  });
  it('colors body and limbs without altering protected facial/accessory layers', () => {
    const rig = parseRig(rigData());
    for (const color of ['#161625', '#f8f8ed', '#f04d82']) {
      expect(layerTint(rig.layers.body, color)).not.toBe(0xffffff);
      expect(layerTint(rig.layers.leftArm, color)).toBe(
        layerTint(rig.layers.body, color),
      );
      expect(layerTint(rig.layers.eyes, color)).toBe(0xffffff);
      expect(layerTint(rig.layers.headphones, color)).toBe(0xffffff);
    }
  });
  it('gathers fur locally without shifting the contact vertex or tearing distant mesh', () => {
    const anchor = { x: 12, y: -75 };
    expect(deformFurVertex(anchor, anchor, 1)).toEqual(anchor);
    const near = deformFurVertex({ x: 20, y: -70 }, anchor, 1);
    expect(near.x).toBeLessThan(20);
    expect(Math.hypot(near.x - 20, near.y + 70)).toBeLessThan(3);
    expect(deformFurVertex({ x: -45, y: -10 }, anchor, 1)).toEqual({
      x: -45,
      y: -10,
    });
  });
  it('keeps transparent overlay margins click-through and accepts the visible body', () => {
    const sim = new CompanionSimulation(buildWorld(null, [display], 0), 1, {
      x: 400,
      y: 850,
    });
    expect(hitTestRig({ x: 400, y: 790 }, sim.frame())).toBe(true);
    expect(hitTestRig({ x: 490, y: 790 }, sim.frame())).toBe(false);
    expect(hitTestRig({ x: 400, y: 700 }, sim.frame())).toBe(false);
  });
  it('accepts raised limbs beyond the resting silhouette', () => {
    const sim = new CompanionSimulation(buildWorld(null, [display], 0), 1, {
      x: 400,
      y: 850,
    });
    const frame = sim.frame();
    frame.pose.leftArm = 1.8;
    expect(hitTestRig({ x: 335, y: 800 }, frame)).toBe(true);
  });
});
