import type { Action, Point, RigPose } from '../shared/contracts.js';

export function initialPose(): RigPose {
  return {
    lean: 0,
    stretch: 1,
    squash: 1,
    gait: 0,
    leftArm: 0,
    rightArm: 0,
    leftFoot: { x: -20, y: 0 },
    rightFoot: { x: 20, y: 0 },
    eyeOpen: 1,
    mouth: 0,
    pinch: 0,
    facing: 1,
    breathing: 0,
  };
}
export interface PoseInput {
  action: Action;
  age: number;
  speed: number;
  distance: number;
  facing: -1 | 1;
  time: number;
  sway: number;
  reducedMotion: boolean;
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function foot(phase: number): Point {
  phase = ((phase % 1) + 1) % 1;
  if (phase < 0.6) return { x: 18 - phase * 60, y: 0 };
  const t = (phase - 0.6) / 0.4;
  return { x: -18 + 36 * t, y: -Math.sin(t * Math.PI) * 10 };
}
export function samplePose(
  previous: RigPose,
  input: PoseInput,
  dt: number,
): RigPose {
  const { action, age, facing, time, reducedMotion } = input;
  const held = action === 'held',
    climb = action === 'climb' || action === 'hang' || action === 'pull_up';
  const walking = action === 'walk' && Math.abs(input.speed) > 0.5;
  const sleepy = action === 'sleep',
    sitting = action === 'sit' || sleepy;
  const easing = 1 - Math.exp(-dt / 0.105);
  const landing = action === 'land' ? Math.exp(-age * 10) : 0;
  const phase = input.distance / 60;
  const l = foot(phase),
    r = foot(phase + 0.5);
  const secondary = reducedMotion ? 0.15 : 1;
  const lean = held
    ? input.sway
    : climb
      ? -facing * 0.09
      : action === 'walk'
        ? input.speed / 1600
        : 0;
  const blinkPhase = time % 4.7;
  const blink = blinkPhase < 0.12 ? Math.abs(blinkPhase - 0.06) / 0.06 : 1;
  const armSwing = walking ? Math.sin(phase * Math.PI * 2) * 0.3 : 0;
  const targetLeft = held
    ? -0.14
    : climb
      ? 2.2
      : action === 'stretch'
        ? 1.8
        : -armSwing;
  const targetRight = held
    ? 0.14
    : climb
      ? -2.2
      : action === 'stretch'
        ? -1.8
        : -armSwing;
  const targetFoot = (side: -1 | 1, f: Point): Point =>
    walking
      ? { x: side * 20 + f.x * facing, y: f.y }
      : {
          x: side * (sitting ? 28 : 20),
          y: held
            ? 7
            : sitting
              ? -2
              : climb
                ? -12 + side * Math.sin(age * 5) * 9
                : 0,
        };
  const lf = targetFoot(-1, l),
    rf = targetFoot(1, r);
  const continuousFoot = (from: Point, to: Point): Point => {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const amount = Math.min(1, (180 * dt) / (distance || 1));
    return { x: mix(from.x, to.x, amount), y: mix(from.y, to.y, amount) };
  };
  return {
    lean: mix(previous.lean, lean, easing),
    stretch: mix(
      previous.stretch,
      held ? 1.09 : sitting ? 0.83 : 1 - landing * 0.12,
      easing,
    ),
    squash: mix(
      previous.squash,
      held ? 0.97 : sitting ? 1.08 : 1 + landing * 0.1,
      easing,
    ),
    gait: phase,
    leftArm: mix(previous.leftArm, targetLeft, easing),
    rightArm: mix(previous.rightArm, targetRight, easing),
    leftFoot: walking
      ? continuousFoot(previous.leftFoot, lf)
      : {
          x: mix(previous.leftFoot.x, lf.x, easing),
          y: mix(previous.leftFoot.y, lf.y, easing),
        },
    rightFoot: walking
      ? continuousFoot(previous.rightFoot, rf)
      : {
          x: mix(previous.rightFoot.x, rf.x, easing),
          y: mix(previous.rightFoot.y, rf.y, easing),
        },
    eyeOpen: mix(
      previous.eyeOpen,
      sleepy ? 0.06 : blink,
      1 - Math.exp(-dt / 0.025),
    ),
    mouth: mix(
      previous.mouth,
      action === 'yawn' || (held && age < 0.7) || action === 'fall' ? 1 : 0,
      easing,
    ),
    pinch: mix(previous.pinch, held ? 1 : 0, easing),
    facing: mix(previous.facing, facing, easing),
    breathing: Math.sin(time * 2.2) * secondary * (sleepy ? 1.8 : 0.65),
  };
}

export function rigPointToWorld(
  local: Point,
  root: Point,
  pose: RigPose,
): Point {
  const x = local.x * pose.squash,
    y = local.y * pose.stretch;
  const c = Math.cos(pose.lean),
    s = Math.sin(pose.lean);
  return { x: root.x + x * c - y * s, y: root.y + x * s + y * c };
}
export function worldPointToRig(
  point: Point,
  root: Point,
  pose: RigPose,
): Point {
  const x = point.x - root.x,
    y = point.y - root.y;
  const c = Math.cos(pose.lean),
    s = Math.sin(pose.lean);
  return {
    x: (x * c + y * s) / pose.squash,
    y: (-x * s + y * c) / pose.stretch,
  };
}
