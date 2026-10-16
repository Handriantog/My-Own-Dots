import { describe, expect, it } from 'vitest';
import { CompanionSimulation } from '../../src/desktop/core/simulation.js';
import { buildWorld } from '../../src/desktop/core/world.js';
import {
  chooseIntention,
  seededRandom,
} from '../../src/desktop/core/behavior.js';
import { rigPointToWorld } from '../../src/desktop/core/pose.js';
import { display, snapshot, windowRect } from './fixtures.js';
import type { World } from '../../src/desktop/shared/contracts.js';

const world = (windows = [windowRect(1, 200, 300, 700, 500)]) =>
  buildWorld(snapshot(windows), [display], 0);
function run(sim: CompanionSimulation, from: number, duration: number) {
  for (let time = from; time <= from + duration; time += 1000 / 60)
    sim.advance(time);
}
function resting(w: World, x = 400, y = 300) {
  const sim = new CompanionSimulation(w, 123, { x, y });
  sim.setOptions({ paused: true, reducedMotion: false });
  sim.advance(0);
  return sim;
}

describe('continuous companion simulation', () => {
  it('timestamps arrival at first presentation without replaying it after sleep', () => {
    const sim = new CompanionSimulation(world([]), 1);
    sim.resume(8000);
    expect(sim.drainEvents().find((e) => e.name === 'appear')?.atMs).toBe(8000);
    sim.suspend();
    sim.resume(16000);
    expect(sim.drainEvents()).toHaveLength(0);
  });
  it('sweeps a fast fall onto the first platform and emits one landing', () => {
    const sim = resting(world(), 450, 130);
    run(sim, 16, 1800);
    expect(sim.frame().root.y).toBe(300);
    expect(sim.frame().support?.windowKey).toBeTruthy();
    expect(
      sim.drainEvents().filter((e) => e.name.startsWith('land_')),
    ).toHaveLength(1);
    expect(sim.drainEvents()).toHaveLength(0);
  });
  it('falls from the current position when resting support disappears or becomes covered', () => {
    for (const next of [
      world([]),
      world([windowRect(2, 100, 200, 1000), windowRect(1, 200, 300, 700, 500)]),
    ]) {
      const sim = resting(world());
      sim.setWorld(next);
      expect(sim.frame().root).toEqual({ x: 400, y: 300 });
      run(sim, 16, 500);
      expect(sim.frame().root.y).toBeGreaterThan(300);
    }
  });
  it('follows a small support movement continuously but detaches from a large move', () => {
    const sim = resting(world());
    sim.setWorld(world([windowRect(1, 205, 303, 700, 500)]));
    expect(sim.frame().root).toEqual({ x: 400, y: 300 });
    sim.advance(17);
    expect(sim.frame().root.x).toBeGreaterThan(400);
    expect(sim.frame().root.x).toBeLessThanOrEqual(405);
    const old = sim.frame().root;
    sim.setWorld(world([windowRect(1, 700, 500, 700, 500)]));
    expect(sim.frame().root).toEqual(old);
    expect(sim.frame().support).toBeNull();
  });
  it('does not catch up hours of elapsed time after a stall or suspension', () => {
    const sim = resting(world(), 400, 100);
    sim.advance(16);
    const p = sim.frame().root;
    sim.advance(3_600_000);
    expect(sim.frame().root).toEqual(p);
    sim.suspend();
    sim.advance(4_000_000);
    sim.resume(4_000_000);
    expect(sim.frame().root).toEqual(p);
  });
  it('distinguishes a click from a drag with a four-pixel threshold', () => {
    const sim = resting(world());
    sim.pointer({ kind: 'down', point: { x: 400, y: 230 }, atMs: 0 });
    sim.pointer({ kind: 'move', point: { x: 403, y: 230 }, atMs: 10 });
    sim.pointer({ kind: 'up', point: { x: 403, y: 230 }, atMs: 20 });
    expect(sim.drainEvents().filter((e) => e.name === 'pat')).toHaveLength(1);
    sim.pointer({ kind: 'down', point: { x: 400, y: 230 }, atMs: 30 });
    sim.pointer({ kind: 'move', point: { x: 405, y: 230 }, atMs: 40 });
    run(sim, 50, 200);
    sim.pointer({ kind: 'up', point: { x: 405, y: 230 }, atMs: 260 });
    const names = sim.drainEvents().map((e) => e.name);
    expect(names.filter((n) => n === 'pickup')).toHaveLength(1);
    expect(names.filter((n) => n === 'release')).toHaveLength(1);
    expect(names).not.toContain('pat');
  });
  it('keeps the actual off-center grip anchored through stretching and sway', () => {
    const sim = resting(world());
    sim.pointer({ kind: 'down', point: { x: 430, y: 260 }, atMs: 0 });
    sim.pointer({ kind: 'move', point: { x: 440, y: 240 }, atMs: 16 });
    for (let t = 17; t < 1000; t += 17) {
      sim.advance(t);
      const f = sim.frame();
      expect(f.grip).not.toBeNull();
      const actual = rigPointToWorld(f.grip!.local, f.root, f.pose);
      expect(actual.x).toBeCloseTo(440, 5);
      expect(actual.y).toBeCloseTo(240, 5);
    }
    const earlyLean = Math.abs(sim.frame().pose.lean);
    run(sim, 1000, 4000);
    expect(Math.abs(sim.frame().pose.lean)).toBeLessThanOrEqual(
      earlyLean + 0.01,
    );
  });
  it('bounds release speed and releases only once on capture loss', () => {
    const sim = resting(world());
    sim.pointer({ kind: 'down', point: { x: 400, y: 220 }, atMs: 0 });
    sim.pointer({ kind: 'move', point: { x: 1000, y: 200 }, atMs: 1 });
    sim.advance(17);
    sim.pointer({ kind: 'cancel', point: { x: 1000, y: 200 }, atMs: 18 });
    sim.pointer({ kind: 'cancel', point: { x: 1000, y: 200 }, atMs: 19 });
    expect(
      Math.hypot(sim.frame().velocity.x, sim.frame().velocity.y),
    ).toBeLessThanOrEqual(651);
    expect(sim.frame().grip).toBeNull();
    expect(sim.drainEvents().filter((e) => e.name === 'release')).toHaveLength(
      1,
    );
  });
  it('plays one falling cue after release and cancels it when landing', () => {
    const sim = resting(world([]), 400, 850);
    sim.pointer({ kind: 'down', point: { x: 400, y: 770 }, atMs: 0 });
    sim.pointer({ kind: 'move', point: { x: 400, y: 180 }, atMs: 16 });
    sim.advance(17);
    sim.pointer({ kind: 'up', point: { x: 400, y: 180 }, atMs: 18 });
    run(sim, 34, 2000);
    const events = sim.drainEvents();
    expect(events.filter((e) => e.name === 'fall')).toHaveLength(1);
    expect(
      events.find((e) => e.name.startsWith('land_'))?.cancelScopes,
    ).toContain('fall');
  });
  it('transfers a held creature to a negative-coordinate monitor without changing the grip', () => {
    const left = {
      ...display,
      id: '2',
      bounds: { ...display.bounds, x: -1440 },
      workArea: { ...display.workArea, x: -1440 },
      scaleFactor: 1,
    };
    const sim = resting(buildWorld(null, [display, left], 0), 400, 850);
    sim.pointer({ kind: 'down', point: { x: 400, y: 780 }, atMs: 0 });
    sim.pointer({ kind: 'move', point: { x: -200, y: 300 }, atMs: 16 });
    sim.advance(17);
    expect(sim.frame().displayId).toBe('2');
    expect(sim.frame().grip?.anchor.x).toBe(-200);
  });
  it('chooses only reachable routes and covers walking, climbing, jumps and rests', () => {
    const w = world();
    const random = seededRandom(12);
    const sim = resting(w, 700, 850);
    const intents = Array.from({ length: 200 }, () =>
      chooseIntention(sim.frame(), w, random),
    );
    expect(intents.some((i) => i.kind === 'walk')).toBe(true);
    expect(intents.some((i) => i.kind === 'climb')).toBe(true);
    expect(intents.some((i) => i.kind === 'jump')).toBe(true);
    expect(intents.some((i) => i.kind === 'rest')).toBe(true);
    const ceiling = world([windowRect(1, 200, 100, 700, 200)]);
    expect(
      Array.from({ length: 50 }, () =>
        chooseIntention(sim.frame(), ceiling, random),
      ).some((i) => i.kind === 'climb'),
    ).toBe(false);
  });
  it('keeps seeded exploration finite and continuous for ten minutes', () => {
    const sim = new CompanionSimulation(world(), 5, { x: 500, y: 850 });
    sim.advance(0);
    let previous = sim.frame().root;
    const actions = new Set<string>();
    for (let t = 17; t < 600_000; t += 17) {
      sim.advance(t);
      const f = sim.frame();
      actions.add(f.action);
      expect(Number.isFinite(f.root.x + f.root.y)).toBe(true);
      expect(
        Math.hypot(f.root.x - previous.x, f.root.y - previous.y),
      ).toBeLessThan(24);
      previous = f.root;
      sim.drainEvents();
    }
    expect(actions.has('walk')).toBe(true);
    expect(actions.has('climb')).toBe(true);
    expect(actions.has('fall')).toBe(true);
    expect(actions.has('pull_up')).toBe(true);
  });
});
