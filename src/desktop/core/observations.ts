import { z } from 'zod';
import type { GeometrySnapshot } from '../shared/contracts.js';

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
});

/** Supervision, not an arbitrary incoming payload, authorizes a new helper session. */
export class ObservationStream {
  private latest: GeometrySnapshot | null = null;
  private receivedAt = -Infinity;
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
    if (
      new Set(next.windows.map((w) => `${w.ownerPid}:${w.id}`)).size !==
        next.windows.length ||
      new Set(next.displays.map((d) => d.id)).size !== next.displays.length
    )
      return null;
    this.latest = next;
    this.receivedAt = receivedAtMs;
    return next;
  }
  current(nowMs: number): GeometrySnapshot | null {
    if (
      !this.latest ||
      nowMs - this.receivedAt > Math.max(500, 3 * this.latest.pollIntervalMs)
    )
      return null;
    return this.latest;
  }
  resetSession(): void {
    this.latest = null;
    this.receivedAt = -Infinity;
  }
}
