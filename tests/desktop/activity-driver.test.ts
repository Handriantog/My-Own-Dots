import { describe, expect, it } from 'vitest';
import {
  DesktopActivityDriver,
  type ActivityEnvironment,
  type PhysicalPointer,
} from '../../src/desktop/host/activity-driver.js';
import { CompanionSimulation } from '../../src/desktop/core/simulation.js';
import { buildWorld } from '../../src/desktop/core/world.js';
import { definition } from './activity-fixture.js';
const display = {
  id: '1',
  bounds: { x: 0, y: 0, width: 1000, height: 800 },
  workArea: { x: 0, y: 0, width: 1000, height: 800 },
  scaleFactor: 2,
};
function fixture() {
  let now = 0,
    selected = 'dot',
    available = true,
    awake = 0;
  let physical: PhysicalPointer = {
    point: { x: 500, y: 400 },
    down: false,
    revision: 1,
    sampledAtMs: 1000,
    idleMs: 10000,
  };
  const moves: unknown[] = [],
    ends: number[] = [];
  const sim = new CompanionSimulation(buildWorld(null, [display], 0), 1, {
    x: 200,
    y: 700,
  });
  const env: ActivityEnvironment = {
    now: () => now,
    selectedDot: () => selected,
    available: () => available,
    accessibility: () => true,
    display: () => display,
    frame: () => sim.frame(),
    reducedMotion: () => false,
    handoff: (frame) => sim.adoptActivity(frame),
    changed: () => {},
    sleep: {
      start: () => ++awake,
      stop: () => {
        awake--;
      },
    },
    pointer: {
      begin: async () => physical,
      move: async (...args) => {
        moves.push(args);
        return true;
      },
      end: (g) => {
        ends.push(g);
      },
    },
  };
  const driver = new DesktopActivityDriver(env);
  return {
    driver,
    env,
    sim,
    moves,
    ends,
    get awake() {
      return awake;
    },
    set now(v: number) {
      now = v;
    },
    set selected(v: string) {
      selected = v;
    },
    set available(v: boolean) {
      available = v;
    },
    input: (input: Partial<PhysicalPointer>) => {
      physical = { ...physical, ...input };
      driver.physical(physical);
    },
    render: () => driver.frame(sim.frame(), now),
  };
}
describe('desktop activity driver', () => {
  it('releases local effects immediately but awaits native retirement before stop resolves', async () => {
    const f = fixture();
    await f.driver.start({ bindingId: 'b', dotId: 'dot' }, definition);
    let retire!: () => void;
    f.env.pointer.end = () =>
      new Promise<void>((resolve) => {
        retire = resolve;
      });
    let stopped = false;
    const stopping = Promise.resolve(f.driver.stop()).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(f.awake).toBe(0);
    expect(f.driver.status('b')).toBe('inactive');
    expect(stopped).toBe(false);
    retire();
    await stopping;
    expect(stopped).toBe(true);
  });
  it('cancels a replacement waiting for old retirement without starting or retiring a provisional native generation', async () => {
    const f = fixture();
    await f.driver.start({ bindingId: 'old', dotId: 'dot' }, definition);
    let retire!: () => void;
    const ended: number[] = [];
    f.env.pointer.end = (generation) => {
      ended.push(generation);
      return new Promise<void>((r) => {
        retire = r;
      });
    };
    const replacement = f.driver.start(
      { bindingId: 'new', dotId: 'dot' },
      definition,
    );
    const rejected = expect(replacement).rejects.toThrow(/stopped/);
    const stopping = f.driver.stop('new');
    expect(f.awake).toBe(0);
    expect(ended).toEqual([1]);
    retire();
    await rejected;
    await stopping;
  });
  it('keeps ordinary facial animation ticking without advancing activity-owned physics', () => {
    const f = fixture();
    f.sim.setOptions({ paused: false, reducedMotion: false, activity: true });
    f.sim.advance(0);
    f.sim.advance(100);
    expect(f.sim.frame().root).toEqual({ x: 200, y: 700 });
    expect(f.sim.frame().pose.breathing).toBeGreaterThan(0);
  });
  it('preserves responsive voice and face cues without changing authored contact transforms', async () => {
    const f = fixture();
    await f.driver.start({ bindingId: 'b', dotId: 'dot' }, definition);
    f.sim.setOptions({
      paused: false,
      reducedMotion: false,
      activity: true,
      voice: 'speaking',
    });
    f.sim.advance(0);
    f.sim.advance(100);
    f.now = 700;
    const base = f.sim.frame(),
      frame = f.driver.frame(base, 700);
    expect(base.pose.speech).toBeGreaterThan(0);
    expect(base.root).toEqual({ x: 200, y: 700 });
    for (const key of [
      'speech',
      'mouth',
      'eyeOpen',
      'look',
      'breathing',
      'love',
    ] as const)
      expect(frame.pose[key]).toEqual(base.pose[key]);
    expect(frame.pose.rightArm).toBeCloseTo(0.2);
    await f.driver.presented(frame);
    expect((f.moves[0] as unknown[])[1]).toEqual({ x: 520, y: 390 });
    f.driver.stop();
  });
  it('retains newer physical input received while a native start acknowledgement is pending', async () => {
    const f = fixture();
    let resolve!: (p: PhysicalPointer) => void;
    f.env.pointer.begin = () =>
      new Promise((r) => {
        resolve = r;
      });
    const pending = f.driver.start(
      { bindingId: 'b', dotId: 'dot' },
      definition,
    );
    await Promise.resolve();
    f.input({ revision: 2, down: false, idleMs: 0, sampledAtMs: 2000 });
    resolve({
      point: { x: 500, y: 400 },
      revision: 1,
      down: false,
      idleMs: 10000,
      sampledAtMs: 1000,
    });
    await pending;
    f.now = 2000;
    f.render();
    expect(f.driver.status('b')).toBe('paused');
    f.driver.stop();
  });
  it('acquires a scoped sleep assertion and moves only the presented frame palm', async () => {
    const f = fixture();
    await f.driver.start({ bindingId: 'b', dotId: 'dot' }, definition);
    expect(f.awake).toBe(1);
    expect(f.driver.status('b')).toBe('approaching');
    const initial = f.render();
    await f.driver.presented(initial);
    expect(f.moves).toHaveLength(0);
    f.now = 500;
    const painted = f.render();
    f.now = 700;
    f.render();
    expect(f.moves).toHaveLength(0);
    await f.driver.presented(painted);
    expect(f.moves).toHaveLength(1);
    expect((f.moves[0] as unknown[]).slice(0, 2)).toEqual([
      1,
      { x: 500, y: 400 },
    ]);
    f.driver.stop();
    expect(f.awake).toBe(0);
    expect(f.driver.status('b')).toBe('inactive');
    await f.driver.presented(painted);
    expect(f.moves).toHaveLength(1);
  });
  it('pauses immediately on physical input, preserves sleep and resumes only after idle with no held button', async () => {
    const f = fixture();
    await f.driver.start({ bindingId: 'b', dotId: 'dot' }, definition);
    f.now = 500;
    const old = f.render();
    f.input({ revision: 2, idleMs: 0, down: true });
    expect(f.driver.status('b')).toBe('paused');
    expect(f.awake).toBe(1);
    await f.driver.presented(old);
    expect(f.moves).toHaveLength(0);
    f.now = 7000;
    f.input({ idleMs: 6000 });
    f.render();
    expect(f.driver.status('b')).toBe('paused');
    f.input({ down: false, idleMs: 0, revision: 3 });
    f.render();
    expect(f.driver.status('b')).toBe('paused');
    f.input({ idleMs: 5000 });
    f.render();
    expect(f.driver.status('b')).toBe('approaching');
    f.driver.stop();
  });
  it('does not acquire pointer while a button is already held', async () => {
    const f = fixture();
    f.input({ down: true });
    await f.driver.start({ bindingId: 'b', dotId: 'dot' }, definition);
    expect(f.driver.status('b')).toBe('paused');
    f.now = 10000;
    await f.driver.presented(f.render());
    expect(f.moves).toEqual([]);
    f.driver.stop();
  });
  it('cleans up a start that resolves after stop and cannot end a newer generation', async () => {
    const f = fixture();
    let resolve!: (p: PhysicalPointer) => void;
    f.env.pointer.begin = () =>
      new Promise((r) => {
        resolve = r;
      });
    const pending = f.driver.start(
      { bindingId: 'b', dotId: 'dot' },
      definition,
    );
    await Promise.resolve();
    f.driver.stop();
    expect(f.awake).toBe(0);
    resolve({
      point: { x: 1, y: 2 },
      down: false,
      revision: 1,
      sampledAtMs: 1,
      idleMs: 10000,
    });
    await expect(pending).rejects.toThrow(/stopped/);
    expect(f.ends).toContain(1);
  });
  it.each(['hidden', 'replacement', 'helper', 'renderer', 'lock', 'suspend'])(
    'releases all effects on %s loss',
    async (reason) => {
      const f = fixture();
      await f.driver.start({ bindingId: 'b', dotId: 'dot' }, definition);
      if (reason === 'replacement') f.selected = 'another';
      else f.available = false;
      f.render();
      expect(f.awake).toBe(0);
      expect(f.ends).toContain(1);
      expect(f.driver.status('b')).toBe('inactive');
    },
  );
  it('releases assertion when transport start or move fails and rejects missing access', async () => {
    const f = fixture();
    f.env.pointer.begin = async () => {
      throw Error('helper lost');
    };
    await expect(
      f.driver.start({ bindingId: 'b', dotId: 'dot' }, definition),
    ).rejects.toThrow('helper lost');
    expect(f.awake).toBe(0);
    f.env.accessibility = () => false;
    await expect(
      f.driver.start({ bindingId: 'b', dotId: 'dot' }, definition),
    ).rejects.toThrow(/Accessibility/);
    const g = fixture();
    await g.driver.start({ bindingId: 'b', dotId: 'dot' }, definition);
    g.env.pointer.move = async () => {
      throw Error('timeout');
    };
    g.now = 500;
    await g.driver.presented(g.render());
    expect(g.awake).toBe(0);
  });
  it('does not rewind a resumed approach with a frame queued before manual release', async () => {
    const f = fixture();
    await f.driver.start({ bindingId: 'b', dotId: 'dot' }, definition);
    f.now = 500;
    const old = f.render();
    f.input({ revision: 2, idleMs: 0, point: { x: 800, y: 300 } });
    f.now = 6000;
    f.input({ idleMs: 5000 });
    f.render();
    const before = f.sim.frame();
    await f.driver.presented(old);
    f.driver.stop();
    expect(f.moves).toEqual([]);
    expect(f.sim.frame().root).toEqual(before.root);
  });
  it('ignores a late presented frame from a previous generation', async () => {
    const f = fixture();
    await f.driver.start({ bindingId: 'old', dotId: 'dot' }, definition);
    f.now = 500;
    const old = f.render();
    f.driver.stop();
    const original = f.sim.frame();
    await f.driver.start({ bindingId: 'new', dotId: 'dot' }, definition);
    await f.driver.presented(old);
    f.driver.stop();
    expect(f.moves).toEqual([]);
    expect(f.sim.frame().root).toEqual(original.root);
  });
  it('eases an authored body offset back into ordinary physics after release', async () => {
    const f = fixture(),
      lifted = structuredClone(definition);
    for (const keyframe of lifted.keyframes) keyframe.pose.bodyY = 10;
    await f.driver.start({ bindingId: 'b', dotId: 'dot' }, lifted);
    f.now = 500;
    await f.driver.presented(f.render());
    f.driver.stop();
    f.sim.advance(1000);
    f.sim.advance(1016);
    expect(f.sim.frame().pose.bodyY).toBeGreaterThan(8);
    expect(f.sim.frame().pose.bodyY).toBeLessThan(10);
  });
  it('returns simulation at the latest rig position without rewinding cursor', async () => {
    const f = fixture();
    await f.driver.start({ bindingId: 'b', dotId: 'dot' }, definition);
    f.now = 900;
    const last = f.render();
    await f.driver.presented(last);
    f.driver.stop();
    expect(f.sim.frame().root).toEqual(last.root);
    expect(f.sim.frame().pose).toEqual(last.pose);
    f.sim.advance(1000);
    f.sim.advance(1016);
    expect(f.sim.frame().root.x).toBeCloseTo(last.root.x, 0);
  });
});

it.each([
  {
    name: 'bottom Dock',
    bounds: { x: 0, y: 0, width: 1000, height: 800 },
    workArea: { x: 0, y: 25, width: 1000, height: 675 },
    anchor: { x: 500, y: 780 },
  },
  {
    name: 'negative-origin side Dock',
    bounds: { x: -1000, y: -300, width: 1000, height: 800 },
    workArea: { x: -900, y: -275, width: 900, height: 775 },
    anchor: { x: -990, y: 0 },
  },
])(
  'driver preserves $name pickup before usable-area travel',
  async ({ bounds, workArea, anchor }) => {
    const f = fixture();
    f.env.display = () => ({ ...display, bounds, workArea });
    f.input({ point: anchor });
    await f.driver.start({ bindingId: 'b', dotId: 'dot' }, definition);
    f.now = definition.approachMs;
    await f.driver.presented(f.render());
    expect((f.moves[0] as unknown[])[1]).toEqual(anchor);
    f.now = definition.approachMs + 4000;
    const settled = f.render();
    await f.driver.presented(settled);
    for (const point of [
      settled.root,
      (f.moves[1] as unknown[])[1] as { x: number; y: number },
    ]) {
      expect(point.x).toBeGreaterThanOrEqual(workArea.x);
      expect(point.x).toBeLessThan(workArea.x + workArea.width);
      expect(point.y).toBeGreaterThanOrEqual(workArea.y);
      expect(point.y).toBeLessThan(workArea.y + workArea.height);
    }
    await f.driver.stop();
  },
);
