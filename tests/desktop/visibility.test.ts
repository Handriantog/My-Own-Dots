import { describe, expect, it } from 'vitest';
import { CompanionVisibility } from '../../src/desktop/core/visibility.js';

describe('companion visibility animation', () => {
  it('pops in as a circle before unfolding into the full Dot', () => {
    const motion = new CompanionVisibility();
    motion.setVisible(true, 0);
    expect(motion.sample(0).alpha).toBe(0);
    expect(motion.sample(0).scaleY).toBeLessThan(1);
    expect(motion.sample(90)).toMatchObject({ circle: 1, alpha: 1 });
    expect(motion.sample(90).scaleX).toBeLessThan(0.35);
    expect(motion.sample(320).circle).toBeLessThan(0.2);
    expect(motion.sample(400)).toMatchObject({
      alpha: 1,
      scaleX: 1,
      scaleY: 1,
      eyeOpen: 1,
      active: false,
    });
  });
  it('gathers into a visible circle before the pop cue and vanishes afterward', () => {
    const motion = new CompanionVisibility();
    motion.setVisible(true, 0, false, true);
    motion.setVisible(false, 10);
    expect(motion.sample(10).alpha).toBe(1);
    const tuck = motion.sample(70);
    expect(tuck.eyeOpen).toBeLessThan(1);
    expect(tuck.scaleY).toBeLessThan(1);
    expect(tuck.alpha).toBeGreaterThan(0.5);
    expect(motion.sample(270)).toMatchObject({
      circle: 1,
      alpha: 1,
      popId: null,
    });
    expect(motion.sample(270).scaleX).toBeCloseTo(0.25);
    expect(motion.sample(310).burst).toBeGreaterThan(0);
    expect(motion.sample(310).popId).not.toBeNull();
    expect(motion.sample(410)).toMatchObject({ alpha: 0, active: false });
  });
  it('reverses from the current shape and opacity without a jump or stale completion', () => {
    const motion = new CompanionVisibility();
    motion.setVisible(true, 0, false, true);
    motion.setVisible(false, 100);
    const hiding = motion.sample(200);
    motion.setVisible(true, 200);
    expect(motion.sample(200)).toEqual(hiding);
    expect(motion.sample(330).scaleX).toBeGreaterThan(hiding.scaleX);
    const showing = motion.sample(330);
    motion.setVisible(false, 330);
    expect(motion.sample(330)).toEqual(showing);
    expect(motion.sample(730).alpha).toBe(0);
  });
  it('uses only opacity for reduced motion and can hide immediately for a lock', () => {
    const motion = new CompanionVisibility();
    motion.setVisible(true, 0, true);
    expect(motion.sample(70)).toMatchObject({
      scaleX: 1,
      scaleY: 1,
      eyeOpen: 1,
      active: true,
    });
    expect(motion.sample(70).alpha).toBeGreaterThan(0);
    motion.setVisible(false, 70, true, true);
    expect(motion.sample(70)).toMatchObject({ alpha: 0, active: false });
    expect(motion.sample(1000).alpha).toBe(0);
    expect(motion.sample(1000).popId).toBeNull();
  });
  it('does not emit the canceled hide pop after reversing before the circle bursts', () => {
    const motion = new CompanionVisibility();
    motion.setVisible(true, 0, false, true);
    motion.setVisible(false, 10);
    expect(motion.sample(150).popId).toBeNull();
    motion.setVisible(true, 150);
    for (let time = 150; time < 600; time += 20)
      expect(motion.sample(time).popId).toBeNull();
  });
});
