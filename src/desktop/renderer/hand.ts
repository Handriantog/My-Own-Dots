import { Container, Graphics } from 'pixi.js';

// Original vector artwork. The thumb/index contact is always local (0, 0).
export const OPEN_HAND_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="38" height="42" viewBox="-16 -32 38 42"><path d="M-7 4C-15-3-14-10-9-10L-5-4L-5-24Q-5-29-1-28Q2-28 2-24L3-12L6-26Q7-30 10-28Q12-27 11-23L9-10L12-21Q14-25 17-23Q19-22 17-18L13-5Q20-15 22-10L19 1Q16 8 7 9Z" fill="#f8d4b8" stroke="#6b4b3c" stroke-width="1.5" stroke-linejoin="round"/></svg>')}" ) 16 32, grab`;

export class PinchHand {
  readonly container = new Container();
  private drawing = new Graphics();
  constructor() {
    this.container.addChild(this.drawing);
  }
  update(closed: number): void {
    const t = Math.max(0, Math.min(1, closed));
    const g = this.drawing.clear();
    // A curved index finger approaches from above; thumb closes from the left.
    g.moveTo(4, -25)
      .bezierCurveTo(16, -22, 19, -11, 15, -5)
      .lineTo(10, 4)
      .bezierCurveTo(7, 8, -1, 7, -4, 3)
      .lineTo(-10 + t * 5, -3 + t * 2)
      .bezierCurveTo(-14 + t * 4, -6, -12 + t * 5, -11, -8 + t * 4, -9)
      .lineTo(-3 + t * 3, -3 + t * 3)
      .bezierCurveTo(0 + t * 3, -4, 4, -6, 5, -9)
      .lineTo(2 - t * 2, -4 + t * 4)
      .bezierCurveTo(-2 - t * 2, -3, -4, -5, -2, -9)
      .lineTo(3, -17)
      .bezierCurveTo(0, -20, 0, -24, 4, -25)
      .closePath()
      .fill({ color: 0xf8d4b8 })
      .stroke({ color: 0x765447, width: 1.1, join: 'round' });
    g.moveTo(9, -17)
      .quadraticCurveTo(12, -12, 10, -8)
      .stroke({ color: 0xd1a58a, width: 1 });
    g.roundRect(1, -28, 9, 6, 2)
      .fill(0xf1e6d5)
      .stroke({ color: 0x8b8176, width: 0.8 });
  }
}
