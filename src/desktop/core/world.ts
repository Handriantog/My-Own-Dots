import {
  BODY,
  type DesktopDisplay,
  type GeometrySnapshot,
  type NativeWindow,
  type Platform,
  type World,
  type Wall,
} from '../shared/contracts.js';
import { isDockFootprint } from './observations.js';

type Interval = [number, number];
function subtract(
  intervals: Interval[],
  start: number,
  end: number,
): Interval[] {
  return intervals.flatMap(([a, b]) => {
    if (end <= a || start >= b) return [[a, b] as Interval];
    const pieces: Interval[] = [];
    if (start > a) pieces.push([a, Math.min(start, b)]);
    if (end < b) pieces.push([Math.max(end, a), b]);
    return pieces;
  });
}
const right = (rect: NativeWindow['bounds']) => rect.x + rect.width;
const bottom = (rect: NativeWindow['bounds']) => rect.y + rect.height;
const stable = (n: number) => Math.round(n * 2) / 2;

/** Platform x1/x2 are permissible BODY CENTER positions, already foot-inset.
 * Walls expose hand-height intervals, with external body-clearance occlusion.
 * Caller passes ObservationStream.current(now), never an unchecked old snapshot.
 */
export function buildWorld(
  snapshot: GeometrySnapshot | null,
  displays: DesktopDisplay[],
  _nowMs: number,
  excludedOwners = new Set<number>(),
): World {
  const platforms: Platform[] = displays.map((d) => ({
    id: `floor:${d.id}`,
    x1: d.bounds.x + BODY.width / 2,
    x2: right(d.bounds) - BODY.width / 2,
    y: bottom(d.bounds),
    displayId: d.id,
  }));
  const world: World = {
    platforms,
    walls: [],
    displays,
    revision: `${snapshot?.helperSession ?? 'none'}:${snapshot?.sceneRevision ?? 0}:${snapshot?.seq ?? 0}`,
    tracking: 'floor',
  };
  if (!snapshot?.sceneValid) return world;
  for (const dock of snapshot.docks ?? []) {
    const display = displays.find((d) => d.id === dock.displayId);
    if (!display || !isDockFootprint(dock.bounds, display.bounds)) continue;
    const x1 = Math.max(
      dock.bounds.x + BODY.footHalf,
      display.bounds.x + BODY.width / 2,
    );
    const x2 = Math.min(
      right(dock.bounds) - BODY.footHalf,
      right(display.bounds) - BODY.width / 2,
    );
    if (x2 - x1 >= 2 && dock.bounds.y >= display.bounds.y + BODY.height)
      platforms.push({
        id: `dock:${display.id}:${dock.id}`,
        x1: stable(x1),
        x2: stable(x2),
        y: stable(dock.bounds.y),
        displayId: display.id,
      });
  }
  if (!snapshot.accessibility) return world;
  world.tracking = 'windows';
  const windows = snapshot.windows.filter(
    (w) => !excludedOwners.has(w.ownerPid),
  );
  for (const [index, window] of windows.entries()) {
    const r = window.bounds;
    const windowKey = `${snapshot.helperSession}:${window.ownerPid}:${window.id}:${window.generation}`;
    const occluders = windows.slice(0, index).filter((w) => w.opaque);
    for (const display of displays) {
      const d = display.workArea;
      if (
        right(r) < d.x ||
        r.x > right(d) ||
        bottom(r) < d.y ||
        r.y > bottom(d)
      )
        continue;
      if (r.y >= d.y + BODY.height && r.y <= bottom(d)) {
        let tops: Interval[] = [
          [
            Math.max(r.x + BODY.footHalf, d.x + BODY.width / 2),
            Math.min(right(r) - BODY.footHalf, right(d) - BODY.width / 2),
          ],
        ];
        for (const { bounds: o } of occluders) {
          if (o.y < r.y + 1 && bottom(o) > r.y - BODY.height + 1)
            tops = subtract(
              tops,
              o.x - BODY.width / 2,
              right(o) + BODY.width / 2,
            );
        }
        tops
          .filter(([a, b]) => b - a >= 2)
          .forEach(([x1, x2], segment) =>
            platforms.push({
              id: `${windowKey}:top:${display.id}:${segment}`,
              windowKey,
              x1: stable(x1),
              x2: stable(x2),
              y: stable(r.y),
              displayId: display.id,
            }),
          );
      }
      for (const side of [-1, 1] as const) {
        const x = side === -1 ? r.x : right(r);
        const exterior = x + (side * BODY.width) / 2;
        if (
          exterior - BODY.width / 2 < d.x ||
          exterior + BODY.width / 2 > right(d)
        )
          continue;
        let sides: Interval[] = [
          [
            Math.max(r.y, d.y + BODY.height / 2),
            Math.min(bottom(r), bottom(d) - BODY.height / 2),
          ],
        ];
        for (const { bounds: o } of occluders) {
          if (
            o.x < exterior + BODY.width / 2 + 1 &&
            right(o) > exterior - BODY.width / 2 - 1
          )
            sides = subtract(
              sides,
              o.y - BODY.height / 2,
              bottom(o) + BODY.height / 2,
            );
        }
        sides
          .filter(([a, b]) => b - a >= 24)
          .forEach(([y1, y2], segment) =>
            world.walls.push({
              id: `${windowKey}:side:${side}:${display.id}:${segment}`,
              windowKey,
              x: stable(x),
              y1: stable(y1),
              y2: stable(y2),
              side,
              displayId: display.id,
            }),
          );
      }
    }
  }
  return world;
}

export function supportAt(
  world: World,
  x: number,
  y: number,
  displayId: string,
  tolerance = 2,
): Platform | null {
  return (
    world.platforms.find(
      (p) =>
        p.displayId === displayId &&
        x >= p.x1 - 0.01 &&
        x <= p.x2 + 0.01 &&
        Math.abs(p.y - y) <= tolerance,
    ) ?? null
  );
}

/** A climb must finish on an exposed, body-clear top on the same display. */
export function climbTop(world: World, wall: Wall): Platform | undefined {
  return world.platforms.find(
    (p) =>
      p.windowKey === wall.windowKey &&
      p.displayId === wall.displayId &&
      p.x2 - p.x1 >= 10 &&
      Math.abs(p.y - wall.y1) < 3 &&
      (wall.side === -1 ? p.x1 < wall.x + 80 : p.x2 > wall.x - 80),
  );
}
