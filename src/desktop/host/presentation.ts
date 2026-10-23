import { z } from 'zod';
import { BODY } from '../shared/contracts.js';
import type {
  DesktopDisplay,
  Point,
  PointerInput,
  PresentationFrame,
} from '../shared/contracts.js';

const pointer = z.object({
  kind: z.enum(['down', 'move', 'up', 'cancel', 'hover']),
  point: z.object({
    x: z.number().finite().min(-100000).max(100000),
    y: z.number().finite().min(-100000).max(100000),
  }),
  atMs: z.number().finite().nonnegative(),
});
export function validPointerInput(value: unknown): value is PointerInput {
  return pointer.safeParse(value).success;
}
export class PresentationMailbox {
  private inFlight: PresentationFrame | null = null;
  private acknowledging = false;
  private pending: PresentationFrame | null = null;
  offer(frame: PresentationFrame): PresentationFrame | null {
    if (!this.inFlight) {
      this.inFlight = frame;
      return frame;
    }
    const events = new Map(
      [...(this.pending?.events ?? []), ...frame.events].map((e) => [e.id, e]),
    );
    this.pending = {
      ...frame,
      events: [...events.values()]
        .filter((e) => frame.sentAtMs - e.atMs < 1000)
        .slice(-64),
    };
    return null;
  }
  beginAck(sequence: number): PresentationFrame | null {
    if (this.inFlight?.sequence !== sequence || this.acknowledging) return null;
    this.acknowledging = true;
    return this.inFlight;
  }
  ack(sequence: number): PresentationFrame | null {
    if (!this.inFlight || sequence !== this.inFlight.sequence) return null;
    this.acknowledging = false;
    this.inFlight = this.pending;
    this.pending = null;
    return this.inFlight;
  }
  isAwaiting(sequence: number): boolean {
    return this.inFlight?.sequence === sequence;
  }
  stalled(nowMs: number): boolean {
    return !!this.inFlight && nowMs - this.inFlight.sentAtMs > 500;
  }
  reset(): void {
    this.acknowledging = false;
    this.inFlight = null;
    this.pending = null;
  }
}

/** Keep the compact native surface on one monitor, including mixed-DPI seams.
 * Rendering still uses the actual native origin; the creature's world root is
 * never clamped or moved to compensate for window-manager placement.
 */
export function overlayOrigin(
  root: Point,
  display: DesktopDisplay,
  dragging = false,
  visualHeight: number = BODY.height,
): Point {
  const area = display.bounds;
  // V8's native integer conversion rejects -0, which Math.round produces
  // while the panel crosses zero. Adding positive zero canonicalizes it.
  const nativePixel = (value: number) => Math.round(value) + 0;
  // The pointer can enter a new screen before the off-center grabbed body.
  // Keep the previous root-centered capture surface through that handoff and
  // the bounded offscreen release recovery; never clip it to the pointer's screen.
  if (
    dragging ||
    root.x - BODY.width / 2 < area.x ||
    root.x + BODY.width / 2 > area.x + area.width ||
    root.y - visualHeight < area.y ||
    root.y > area.y + area.height
  )
    return { x: nativePixel(root.x - 160), y: nativePixel(root.y - 200) };
  const clamp = (n: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, n));
  return {
    x: nativePixel(clamp(root.x - 160, area.x, area.x + area.width - 320)),
    y: nativePixel(clamp(root.y - 200, area.y, area.y + area.height - 320)),
  };
}
