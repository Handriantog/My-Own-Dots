import {
  BODY,
  type SimulationFrame,
  type Wall,
  type World,
} from '../shared/contracts.js';

export type Intention =
  | { kind: 'walk'; x: number }
  | { kind: 'climb'; wall: Wall; x: number }
  | { kind: 'jump'; x: number }
  | {
      kind: 'rest';
      action: 'idle' | 'sit' | 'stretch' | 'yawn' | 'sleep';
      duration: number;
    };
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function chooseIntention(
  frame: SimulationFrame,
  world: World,
  random: () => number,
): Intention {
  const support = frame.support;
  if (!support) return { kind: 'rest', action: 'idle', duration: 1 };
  const roll = random();
  const walls = world.walls.filter(
    (w) =>
      w.displayId === frame.displayId &&
      w.windowKey !== support.windowKey &&
      w.y1 < frame.root.y - 65 &&
      w.y2 >= frame.root.y - 65 - 150 &&
      w.x + (w.side * BODY.width) / 2 >= support.x1 &&
      w.x + (w.side * BODY.width) / 2 <= support.x2,
  );
  if (roll < 0.3 && walls.length) {
    const wall = walls[Math.floor(random() * walls.length)];
    return { kind: 'climb', wall, x: wall.x + (wall.side * BODY.width) / 2 };
  }
  if (roll < 0.65) {
    const margin = Math.min(15, (support.x2 - support.x1) / 3);
    return {
      kind: 'walk',
      x:
        support.x1 +
        margin +
        random() * Math.max(0, support.x2 - support.x1 - margin * 2),
    };
  }
  if (roll < 0.76) {
    const direction = random() < 0.5 ? -1 : 1;
    return {
      kind: 'jump',
      x: Math.min(
        support.x2,
        Math.max(support.x1, frame.root.x + direction * (40 + random() * 100)),
      ),
    };
  }
  const rests = ['idle', 'sit', 'stretch', 'yawn', 'sleep'] as const;
  const action = rests[Math.floor(random() * rests.length)];
  return {
    kind: 'rest',
    action,
    duration: action === 'sleep' ? 8 + random() * 8 : 1.2 + random() * 3.5,
  };
}
