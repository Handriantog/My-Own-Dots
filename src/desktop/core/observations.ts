import { z } from 'zod';
import type { GeometrySnapshot, Rect } from '../shared/contracts.js';

/** Conservatively reject hidden slivers and Dock's full-screen CG container. */
export function isDockFootprint(r: Rect, d: Rect): boolean {
  const right = r.x + r.width,
    bottom = r.y + r.height;
  const screenRight = d.x + d.width,
    screenBottom = d.y + d.height;
  if (
    ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
    r.width < 12 ||
    r.height < 12 ||
    r.x < d.x - 1 ||
    r.y < d.y - 1 ||
    right > screenRight + 1 ||
    bottom > screenBottom + 1
  )
    return false;
  return r.width >= r.height
    ? r.height < d.height / 2 && Math.abs(bottom - screenBottom) <= 24
    : r.width < d.width / 2 &&
        (Math.abs(r.x - d.x) <= 24 || Math.abs(right - screenRight) <= 24);
}

const coordinate = z.number().finite().min(-100_000).max(100_000);
const rect = z.object({
  x: coordinate,
  y: coordinate,
  width: z.number().positive().max(100_000),
  height: z.number().positive().max(100_000),
});
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const snapshot = z.object({
  protocolVersion: z.literal(1),
  helperSession: z.string().min(1).max(128),
  seq: integer,
  observedAtMs: z.number().finite().nonnegative(),
  sceneRevision: integer,
  pollIntervalMs: z.number().min(33).max(500),
  accessibility: z.boolean(),
  sceneValid: z.boolean(),
  displays: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        bounds: rect,
        workArea: rect,
        scaleFactor: z.number().min(0.5).max(8),
      }),
    )
    .min(1)
    .max(32),
  windows: z
    .array(
      z.object({
        id: integer,
        ownerPid: integer,
        generation: integer,
        bounds: rect,
        opaque: z.boolean(),
      }),
    )
    .max(2048),
  docks: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        displayId: z.string().min(1).max(128),
        bounds: rect,
      }),
    )
    .max(32)
    .optional(),
});

/** Supervision, not an arbitrary incoming payload, authorizes a new helper session. */
export class ObservationStream {
  private latest: GeometrySnapshot | null = null;
  private clockOffset = Infinity;
  accept(value: unknown, receivedAtMs: number): GeometrySnapshot | null {
    if (!Number.isFinite(receivedAtMs)) return null;
    const parsed = snapshot.safeParse(value);
    if (!parsed.success) return null;
    const next = parsed.data;
    if (
      this.latest &&
      (next.helperSession !== this.latest.helperSession ||
        next.seq <= this.latest.seq ||
        next.sceneRevision < this.latest.sceneRevision ||
        next.observedAtMs < this.latest.observedAtMs)
    )
      return null;
    const dockIds = new Set<string>();
    for (const dock of next.docks ?? []) {
      const identity = `${dock.displayId}:${dock.id}`;
      const display = next.displays.find((d) => d.id === dock.displayId);
      if (
        dockIds.has(identity) ||
        !display ||
        !isDockFootprint(dock.bounds, display.bounds)
      )
        return null;
      dockIds.add(identity);
    }
    if (
      new Set(next.windows.map((w) => `${w.ownerPid}:${w.id}`)).size !==
        next.windows.length ||
      new Set(next.displays.map((d) => d.id)).size !== next.displays.length
    )
      return null;
    // Process clocks have different origins. The smallest observed transport
    // offset maps helper uptime onto host monotonic time; queued output can
    // never move that mapping forward and make an old scene fresh again.
    const offset = Math.min(this.clockOffset, receivedAtMs - next.observedAtMs);
    if (
      receivedAtMs - (next.observedAtMs + offset) >
      Math.max(500, 3 * next.pollIntervalMs)
    )
      return null;
    this.clockOffset = offset;
    this.latest = next;
    return next;
  }
  current(nowMs: number): GeometrySnapshot | null {
    if (
      !this.latest ||
      nowMs - (this.latest.observedAtMs + this.clockOffset) >
        Math.max(500, 3 * this.latest.pollIntervalMs)
    )
      return null;
    return this.latest;
  }
  resetSession(): void {
    this.latest = null;
    this.clockOffset = Infinity;
  }
}
