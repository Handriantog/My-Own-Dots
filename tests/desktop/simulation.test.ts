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
  it.each(['walk', 'fall', 'climb'])(
    'holds its position during %s until the interaction freeze ends',
    (action) => {
      const sim = new CompanionSimulation(world(), 5, {
        x: 500,
        y: action === 'fall' ? 600 : 900,
      });
      let time = 0;
      sim.advance(time);
      while (sim.frame().action !== action && time < 60000)
        sim.advance((time += 17));
      expect(sim.frame().action).toBe(action);
      const position = sim.frame().root;
      sim.setOptions({ paused: true, reducedMotion: false, frozen: true });
      for (let i = 0; i < 180; i++) sim.advance((time += 17));
      expect(sim.frame().root).toEqual(position);
      sim.setOptions({ paused: false, reducedMotion: false, frozen: false });
      for (
        let i = 0;
        i < 1800 &&
        JSON.stringify(sim.frame().root) === JSON.stringify(position);
        i++
      )
        sim.advance((time += 17));
      expect(sim.frame().root).not.toEqual(position);
    },
  );
  it('stays in place when its support disappears during an interaction freeze', () => {
    const sim = resting(world(), 400, 300);
    sim.setOptions({ paused: true, reducedMotion: false, frozen: true });
    sim.setWorld(world([]));
    run(sim, 17, 2000);
    expect(sim.frame().root).toEqual({ x: 400, y: 300 });
    sim.setOptions({ paused: true, reducedMotion: false, frozen: false });
    run(sim, 2034, 1000);
    expect(sim.frame().root.y).toBeGreaterThan(300);
  });
  it('lands on the measured Dock top and drops past both ends to the real screen floor', () => {
    const w = buildWorld(
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
    for (const [x, y, support] of [
      [600, 830, 'dock:1:list'],
      [418, 900, 'floor:1'],
      [982, 900, 'floor:1'],
    ] as const) {
      const sim = resting(w, x, 650);
      run(sim, 17, 1500);
      expect(sim.frame().root).toEqual({ x, y });
      expect(sim.frame().support?.id).toBe(support);
      expect(
        sim.drainEvents().filter((event) => event.name.startsWith('land_')),
      ).toHaveLength(1);
    }
  });
  it('falls continuously to the real floor when a Dock perch hides', () => {
    const w = buildWorld(
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
    const sim = resting(w, 600, 830);
    expect(sim.frame().support?.id).toBe('dock:1:list');
    sim.setWorld(buildWorld(snapshot([], { docks: [] }), [display], 0));
    expect(sim.frame().root).toEqual({ x: 600, y: 830 });
    expect(sim.frame().support).toBeNull();
    sim.advance(17);
    expect(sim.frame().root.y).toBeGreaterThan(830);
    expect(sim.frame().root.y).toBeLessThan(831);
    run(sim, 34, 1000);
    expect(sim.frame().root.y).toBe(900);
    expect(sim.frame().support?.id).toBe('floor:1');
  });
  it('does not start a climb with no usable top above the window', () => {
    for (const windows of [
      [windowRect(1, 200, 33, 700, 800)],
      [windowRect(2, 150, 200, 800, 120), windowRect(1, 200, 300, 700, 500)],
    ]) {
      const w = world(windows);
      const sim = resting(w, 700, 900);
      const intents = Array.from({ length: 100 }, () =>
        chooseIntention(sim.frame(), w, () => 0.1),
      );
      expect(intents.some((i) => i.kind === 'climb')).toBe(false);
    }
  });
  it('plants a climb hand during the body pull instead of sliding it up the wall', () => {
    const sim = new CompanionSimulation(world(), 5, { x: 500, y: 900 });
    sim.advance(0);
    let time = 0;
    while (sim.frame().action !== 'climb' && time < 60000)
      sim.advance((time += 17));
    let planted = 0;
    for (let n = 0; n < 120; n++) {
      const before = sim.frame();
      sim.advance((time += 17));
      const after = sim.frame();
      if (
        before.climb &&
        after.climb &&
        after.action === 'climb' &&
        Math.abs(after.climb.hand.y - before.climb.hand.y) < 0.01 &&
        after.root.y < before.root.y - 0.1
      )
        planted++;
    }
    expect(planted).toBeGreaterThan(30);
  });
  it('settles securely on a window after pulling up across fresh observations', () => {
    const sim = new CompanionSimulation(world(), 5, { x: 500, y: 900 });
    sim.advance(0);
    let time = 0;
    while (sim.frame().action !== 'pull_up' && time < 60000)
      sim.advance((time += 17));
    expect(sim.frame().action).toBe('pull_up');
    while (sim.frame().action === 'pull_up' && time < 65000) {
      sim.setWorld(world());
      sim.advance((time += 17));
    }
    const perch = sim.frame().support;
    expect(perch?.windowKey).toBeTruthy();
    for (let n = 0; n < 140; n++) {
      sim.setWorld(world());
      sim.advance((time += 17));
      expect(sim.frame().support?.windowKey).toBe(perch!.windowKey);
      expect(sim.frame().root.y).toBe(perch!.y);
    }
  });
  it('lands a hop back on the narrow end of its window perch', () => {
    // Begin at the right-end perch. Seed 25 chooses an outward hop first;
    // this isolates its landing from unrelated idle/route scheduling.
    const sim = new CompanionSimulation(world(), 25, { x: 876, y: 300 });
    sim.advance(0);
    let time = 0;
    while (sim.frame().action !== 'jump' && time < 2000)
      sim.advance((time += 17));
    expect(sim.frame().action).toBe('jump');
    while (!sim.frame().support && time < 4000) sim.advance((time += 17));
    expect(sim.frame().support?.windowKey).toBe('a:42:1:1');
    expect(sim.frame().root.y).toBe(300);
  });
  it('resumes an unfinished climbing stroke without catching up a suspended clock', () => {
    for (const suspend of [false, true]) {
      const sim = new CompanionSimulation(world(), 5, { x: 500, y: 900 });
      sim.advance(0);
      let time = 0;
      while (
        !(sim.frame().action === 'climb' && sim.frame().actionAge > 0.65) &&
        time < 60000
      )
        sim.advance((time += 17));
      const before = sim.frame();
      if (suspend) {
        sim.suspend();
        sim.resume(time + 10000);
      } else sim.advance(time + 10000);
      sim.advance(time + 10017);
      const after = sim.frame();
      expect(Math.abs(after.root.y - before.root.y)).toBeLessThan(2);
      expect(Math.abs(after.climb!.hand.y - before.climb!.hand.y)).toBeLessThan(
        4,
      );
    }
  });
  it('continues a mid-wall climb after a brief pause instead of pulling to a distant top', () => {
    const sim = new CompanionSimulation(world(), 5, { x: 500, y: 900 });
    sim.advance(0);
    let time = 0;
    while (
      !(sim.frame().action === 'climb' && sim.frame().actionAge > 1) &&
      time < 60000
    )
      sim.advance((time += 17));
    sim.setOptions({ paused: true, reducedMotion: false });
    sim.advance((time += 17));
    expect(sim.frame().action).toBe('hang');
    expect(sim.frame().climb!.hand.y).toBeGreaterThan(600);
    sim.setOptions({ paused: false, reducedMotion: false });
    while (sim.frame().action === 'hang' && time < 65000)
      sim.advance((time += 17));
    expect(sim.frame().action).toBe('climb');
    expect(sim.frame().climb!.hand.y).toBeGreaterThan(600);
  });
  it('restores the actual display when monitors overlap horizontally', () => {
    const upper = {
      ...display,
      id: 'upper',
      bounds: { ...display.bounds, y: -900 },
      workArea: { ...display.workArea, y: -875 },
    };
    for (const monitors of [
      [display, upper],
      [upper, display],
    ]) {
      const w = buildWorld(null, monitors, 0);
      const above = new CompanionSimulation(w, 5, { x: 400, y: -50 });
      expect(above.frame().displayId).toBe('upper');
      expect(above.frame().support).toBeNull();
      above.setOptions({ paused: true, reducedMotion: false });
      above.advance(0);
      run(above, 17, 1000);
      expect(above.frame().root).toEqual({ x: 400, y: 0 });
      expect(above.frame().displayId).toBe('upper');
      expect(above.frame().support?.id).toBe('floor:upper');
      expect(
        new CompanionSimulation(w, 5, { x: 400, y: 900 }).frame().displayId,
      ).toBe('1');
      expect(
        new CompanionSimulation(w, 5, { x: 400, y: 0 }).frame().displayId,
      ).toBe('1');
      const restored = new CompanionSimulation(
        w,
        5,
        { x: 400, y: 0 },
        'upper',
      ).frame();
      expect(restored.displayId).toBe('upper');
      expect(restored.support?.id).toBe('floor:upper');
      expect(
        new CompanionSimulation(w, 5, { x: 400, y: 900 }, 'upper').frame()
          .displayId,
      ).toBe('1');
    }
  });
  it('drops continuously if a foreground window covers an active pull-up destination', () => {
    const sim = new CompanionSimulation(world(), 5, { x: 500, y: 900 });
    sim.advance(0);
    let time = 0;
    while (sim.frame().action !== 'pull_up' && time < 60000)
      sim.advance((time += 17));
    expect(sim.frame().action).toBe('pull_up');
    const before = sim.frame();
    const covered = world([
      windowRect(2, 100, 200, 750, 150),
      windowRect(1, 200, 300, 700, 500),
    ]);
    expect(
      covered.walls.some(
        (w) => w.windowKey === before.climb!.wall.windowKey && w.side === 1,
      ),
    ).toBe(true);
    expect(
      covered.platforms.some(
        (p) => p.windowKey === before.climb!.wall.windowKey,
      ),
    ).toBe(false);
    sim.setWorld(covered);
    expect(sim.frame().root).toEqual(before.root);
    expect(sim.frame().climb).toBeNull();
    run(sim, time + 17, 1600);
    const support = sim.frame().support;
    if (support) expect(covered.platforms).toContainEqual(support);
  });
  it('refreshes a walking climb target before attaching to a moved window', () => {
    const sim = new CompanionSimulation(world(), 8, { x: 500, y: 900 });
    sim.advance(0);
    run(sim, 17, 1000);
    expect(sim.frame().action).toBe('walk');
    const moved = world([windowRect(1, 260, 300, 700, 500)]);
    sim.setWorld(moved);
    let time = 1037;
    while (!sim.frame().climb && time < 12000) sim.advance((time += 17));
    expect(sim.frame().climb?.wall.x).toBe(960);
    expect(Math.abs(sim.frame().root.x - 1012)).toBeLessThan(2);
  });
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
    const sim = resting(world([]), 400, 900);
    sim.pointer({ kind: 'down', point: { x: 400, y: 820 }, atMs: 0 });
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
    const sim = resting(buildWorld(null, [display, left], 0), 400, 900);
    sim.pointer({ kind: 'down', point: { x: 400, y: 830 }, atMs: 0 });
    sim.pointer({ kind: 'move', point: { x: -200, y: 300 }, atMs: 16 });
    sim.advance(17);
    expect(sim.frame().displayId).toBe('2');
    expect(sim.frame().grip?.anchor.x).toBe(-200);
  });
  it('chooses only reachable routes and covers walking, climbing, jumps and rests', () => {
    const w = world();
    const random = seededRandom(12);
    const sim = resting(w, 700, 900);
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
    const sim = new CompanionSimulation(world(), 5, { x: 500, y: 900 });
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
