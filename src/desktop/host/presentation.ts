import { z } from 'zod';
import type { PointerInput, PresentationFrame } from '../shared/contracts.js';

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
  ack(sequence: number): PresentationFrame | null {
    if (!this.inFlight || sequence !== this.inFlight.sequence) return null;
    this.inFlight = this.pending;
    this.pending = null;
    return this.inFlight;
  }
  stalled(nowMs: number): boolean {
    return !!this.inFlight && nowMs - this.inFlight.sentAtMs > 500;
  }
  reset(): void {
    this.inFlight = null;
    this.pending = null;
  }
}
