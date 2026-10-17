import type { Point } from '../shared/contracts.js';

/** Recognize gentle back-and-forth strokes without capturing the mouse. */
export class PettingGesture {
  private previous: { point: Point; at: number } | null = null;
  private direction: Point | null = null;
  private start = 0;
  private distance = 0;
  private reversals = 0;
  private cooldown = -Infinity;
  reset(): void {
    this.previous = null;
    this.direction = null;
    this.distance = 0;
    this.reversals = 0;
  }
  sample(point: Point, at: number, eligible: boolean): boolean {
    if (!eligible) {
      this.reset();
      return false;
    }
    const previous = this.previous;
    this.previous = { point: { ...point }, at };
    if (!previous) {
      this.start = at;
      return false;
    }
    const dx = point.x - previous.point.x,
      dy = point.y - previous.point.y;
    const distance = Math.hypot(dx, dy),
      gap = at - previous.at;
    if (gap <= 0 || gap > 150 || distance > 45 || at - this.start > 1400) {
      this.reset();
      this.previous = { point: { ...point }, at };
      this.start = at;
      return false;
    }
    if (distance < 1.5) return false;
    const direction = { x: dx / distance, y: dy / distance };
    if (
      this.direction &&
      direction.x * this.direction.x + direction.y * this.direction.y < -0.35
    )
      this.reversals++;
    this.direction = direction;
    this.distance += distance;
    if (
      this.distance >= 65 &&
      this.reversals >= 2 &&
      at - this.start >= 250 &&
      at >= this.cooldown
    ) {
      this.cooldown = at + 1200;
      this.reset();
      return true;
    }
    return false;
  }
}
