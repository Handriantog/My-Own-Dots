import type { Action, Point, RigPose } from '../shared/contracts.js';

export function initialPose(): RigPose {
  return {
    lean: 0,
    stretch: 1,
    squash: 1,
    gait: 0,
    leftArm: 0,
    rightArm: 0,
    leftArmLength: 34,
    rightArmLength: 34,
    leftFoot: { x: -20, y: 0 },
    rightFoot: { x: 20, y: 0 },
    eyeOpen: 1,
    mouth: 0,
    effort: 0,
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
  if (phase < 0.6) return { x: 12 - phase * 40, y: 0 };
  const t = (phase - 0.6) / 0.4;
  return { x: -12 + 24 * t, y: -Math.sin(t * Math.PI) * 6 };
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
  const phase = input.distance / 40;
  const l = foot(phase),
    r = foot(phase + 0.5);
  const secondary = reducedMotion ? 0.15 : 1;
  const lean = held
    ? input.sway
    : climb
      ? facing * 0.025
      : action === 'walk'
        ? input.speed / 4000
        : 0;
  const blinkPhase = time % 4.7;
  const blink = blinkPhase < 0.12 ? Math.abs(blinkPhase - 0.06) / 0.06 : 1;
  const armSwing = walking ? Math.sin(phase * Math.PI * 2) * 0.18 : 0;
  const targetLeft = held
    ? -0.14
    : climb
      ? -facing *
        (0.7 + 0.15 * Math.sin((Math.max(0, age - 0.55) * Math.PI * 2) / 0.8))
      : action === 'stretch'
        ? 1.8
        : -armSwing;
  const targetRight = held
    ? 0.14
    : climb
      ? -facing *
        (0.7 + 0.15 * Math.sin((Math.max(0, age - 0.55) * Math.PI * 2) / 0.8))
      : action === 'stretch'
        ? -1.8
        : armSwing;
  const targetFoot = (side: -1 | 1, f: Point): Point =>
    walking
      ? { x: side * 18 + f.x * facing, y: f.y }
      : {
          x:
            side * (sitting ? 28 : 20) +
            (climb ? facing * (side === facing ? 24 : 8) : 0),
          y: held
            ? 7
            : sitting
              ? -2
              : climb
                ? -7 -
                  (1 +
                    side *
                      Math.sin((Math.max(0, age - 0.55) * Math.PI * 2) / 0.8)) *
                    3
                : 0,
        };
  const lf = targetFoot(-1, l),
    rf = targetFoot(1, r);
  const pat =
    action === 'pat' ? Math.sin(Math.min(1, age / 0.45) * Math.PI) : 0;
  const continuousFoot = (from: Point, to: Point): Point => {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const amount = Math.min(1, (180 * dt) / (distance || 1));
    return { x: mix(from.x, to.x, amount), y: mix(from.y, to.y, amount) };
  };
  const effort = climb
    ? 0.35 +
      (action === 'climb'
        ? 0.15 * Math.sin((Math.max(0, age - 0.55) * Math.PI * 2) / 0.8)
        : 0.1)
    : 0;
  const bounce = walking ? 0.012 * Math.cos(phase * Math.PI * 4) : 0;
  const next: RigPose = {
    lean: mix(previous.lean, lean, easing),
    stretch: mix(
      previous.stretch,
      held ? 1.09 : sitting ? 0.83 : 1 - landing * 0.12 - pat * 0.09 + bounce,
      easing,
    ),
    squash: mix(
      previous.squash,
      held
        ? 0.97
        : sitting
          ? 1.08
          : 1 + landing * 0.1 + pat * 0.07 - bounce * 0.5,
      easing,
    ),
    gait: phase,
    leftArm: mix(previous.leftArm, targetLeft, easing),
    rightArm: mix(previous.rightArm, targetRight, easing),
    leftArmLength: mix(previous.leftArmLength, 34, easing),
    rightArmLength: mix(previous.rightArmLength, 34, easing),
    leftFoot: walking
      ? previous.leftFoot
      : {
          x: mix(previous.leftFoot.x, lf.x, easing),
          y: mix(previous.leftFoot.y, lf.y, easing),
        },
    rightFoot: walking
      ? previous.rightFoot
      : {
          x: mix(previous.rightFoot.x, rf.x, easing),
          y: mix(previous.rightFoot.y, rf.y, easing),
        },
    eyeOpen: mix(
      previous.eyeOpen,
      sleepy ? 0.06 : blink * (held ? 1.14 : 1 - effort * 0.3),
      1 - Math.exp(-dt / 0.025),
    ),
    mouth: mix(
      previous.mouth,
      action === 'yawn' || held || action === 'fall' ? 1 : effort * 0.8,
      easing,
    ),
    effort: mix(previous.effort, effort, easing),
    pinch: mix(previous.pinch, held ? 1 : 0, easing),
    facing: mix(previous.facing, facing, easing),
    breathing: Math.sin(time * 2.2) * secondary * (sleepy ? 1.8 : 0.65),
  };
  if (walking) {
    const origin = { x: 0, y: 0 };
    // Foot contacts live in world space; plush sway and squash must not tilt
    // the planted soles into or above their supporting surface.
    next.leftFoot = worldPointToRig(
      continuousFoot(rigPointToWorld(previous.leftFoot, origin, previous), lf),
      origin,
      next,
    );
    next.rightFoot = worldPointToRig(
      continuousFoot(rigPointToWorld(previous.rightFoot, origin, previous), rf),
      origin,
      next,
    );
  }
  return next;
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
