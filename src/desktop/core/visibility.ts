export interface VisibilityPose {
  alpha: number;
  scaleX: number;
  scaleY: number;
  eyeOpen: number;
  circle: number;
  /** Ripple progress; 1 is finished/invisible. */
  burst: number;
  popId: number | null;
  active: boolean;
}

type Shape = Pick<
  VisibilityPose,
  'alpha' | 'scaleX' | 'scaleY' | 'eyeOpen' | 'circle'
>;
const shown: Shape = { alpha: 1, scaleX: 1, scaleY: 1, eyeOpen: 1, circle: 0 };
const circle: Shape = {
  alpha: 1,
  scaleX: 0.25,
  scaleY: 0.25,
  eyeOpen: 0,
  circle: 1,
};
const hidden: Shape = { ...circle, alpha: 0, scaleX: 0, scaleY: 0 };
function blend(from: Shape, to: Shape, t: number): Shape {
  const ease = t * t * (3 - 2 * t);
  return {
    alpha: from.alpha + (to.alpha - from.alpha) * ease,
    scaleX: from.scaleX + (to.scaleX - from.scaleX) * ease,
    scaleY: from.scaleY + (to.scaleY - from.scaleY) * ease,
    eyeOpen: from.eyeOpen + (to.eyeOpen - from.eyeOpen) * ease,
    circle: from.circle + (to.circle - from.circle) * ease,
  };
}

/** Root-anchored circle transformation, with an idempotent timed sound cue. */
export class CompanionVisibility {
  private visible = false;
  private from: Shape = hidden;
  private fromBurst = 1;
  private started = 0;
  private duration = 0;
  private reducedMotion = false;
  private id = 0;
  private popAt: number | null = null;
  private unfolding = false;

  setVisible(
    visible: boolean,
    now: number,
    reducedMotion = false,
    immediate = false,
  ): void {
    if (visible === this.visible && !immediate) return;
    const current = this.sample(now);
    this.from = current;
    this.fromBurst = current.burst;
    this.visible = visible;
    this.started = now;
    this.reducedMotion = reducedMotion;
    this.unfolding = visible && current.circle < 0.99 && current.alpha > 0;
    this.duration =
      immediate || (!visible && current.alpha === 0)
        ? 0
        : reducedMotion
          ? 140
          : this.unfolding
            ? 280
            : 400;
    this.popAt =
      !this.duration || this.unfolding
        ? null
        : visible
          ? 0
          : reducedMotion
            ? 20
            : 272;
    this.id++;
  }

  sample(now: number): VisibilityPose {
    const elapsed = Math.max(0, now - this.started);
    const t = this.duration ? Math.min(1, elapsed / this.duration) : 1;
    const destination = this.visible ? shown : hidden;
    const popId =
      t < 1 && this.popAt !== null && elapsed >= this.popAt ? this.id : null;
    const burst =
      this.reducedMotion || t === 1
        ? 1
        : popId !== null
          ? Math.min(1, (elapsed - this.popAt!) / 128)
          : Math.min(1, this.fromBurst + elapsed / 128);
    if (this.reducedMotion)
      return {
        ...shown,
        alpha: blend(this.from, destination, t).alpha,
        burst: 1,
        popId,
        active: t < 1,
      };
    if (t === 1)
      return { ...destination, burst: 1, popId: null, active: false };
    const stretch = { ...shown, scaleX: 0.985, scaleY: 1.035 };
    const keys: [number, Shape][] = this.visible
      ? this.unfolding
        ? [
            [0, this.from],
            [0.85, stretch],
            [1, shown],
          ]
        : [
            [0, this.from],
            [0.2, { ...circle, scaleX: 0.28, scaleY: 0.28 }],
            [0.32, circle],
            [0.9, stretch],
            [1, shown],
          ]
      : [
          [0, this.from],
          [0.6, circle],
          [0.68, circle],
          [0.74, { ...circle, scaleX: 0.29, scaleY: 0.29 }],
          [0.84, { ...hidden, alpha: 1 }],
          [0.9, { ...hidden, alpha: 1 }],
          [1, hidden],
        ];
    const end = keys.findIndex(([at]) => at > t);
    const [startAt, startShape] = keys[end - 1];
    const [endAt, endShape] = keys[end];
    return {
      ...blend(startShape, endShape, (t - startAt) / (endAt - startAt)),
      burst,
      popId,
      active: true,
    };
  }
}
