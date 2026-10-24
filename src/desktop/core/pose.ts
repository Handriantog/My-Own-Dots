import type { Action, Point, RigPose } from '../shared/contracts.js';
import type { CompanionVoiceState } from '../shared/voice-contract.js';

export function initialPose(): RigPose {
  return {
    bodyY: 0,
    seated: 0,
    look: { x: 0, y: 0 },
    love: 0,
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
    speech: 0,
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
  look?: Point;
  loved?: boolean;
  voice?: CompanionVoiceState;
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function foot(phase: number): Point {
  phase = ((phase % 1) + 1) % 1;
  if (phase < 0.6) return { x: 12 - phase * 40, y: 0 };
  const t = (phase - 0.6) / 0.4;
  return { x: -12 + 24 * t, y: -Math.sin(t * Math.PI) * 6 };
}
/** Distance-driven world-space contacts shared by normal and activity walking. */
export function walkingGait(distance: number, facing: number) {
  const phase = distance / 40;
  const l = foot(phase),
    r = foot(phase + 0.5);
  return {
    phase,
    left: { x: -18 + l.x * facing, y: l.y },
    right: { x: 18 + r.x * facing, y: r.y },
    bounce: 0.012 * Math.cos(phase * Math.PI * 4),
  };
}
export function samplePose(
  previous: RigPose,
  input: PoseInput,
  dt: number,
): RigPose {
  const { action, age, facing, time, reducedMotion } = input;
  const held = action === 'held',
    climb = action === 'climb' || action === 'hang' || action === 'pull_up';
  const walking =
    (action === 'walk' || action === 'pet') && Math.abs(input.speed) > 0.5;
  const sleepy = action === 'sleep',
    sitting = action === 'sit' || sleepy;
  const easing = 1 - Math.exp(-dt / 0.105);
  const landing = action === 'land' ? Math.exp(-age * 10) : 0;
  const gait = walkingGait(input.distance, facing);
  const phase = gait.phase;
  const secondary = reducedMotion ? 0.15 : 1;
  const lean = held
    ? input.sway
    : climb
      ? facing * 0.025
      : action === 'walk'
        ? input.speed / 4000
        : action === 'peek'
          ? facing * 0.11
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
        : sitting
          ? -0.5
          : action === 'groom'
            ? -1.25 + Math.sin(age * 7) * 0.12
            : action === 'headphones'
              ? 2.15 + Math.sin(age * 4) * 0.08
              : -armSwing;
  const targetRight = held
    ? 0.14
    : climb
      ? -facing *
        (0.7 + 0.15 * Math.sin((Math.max(0, age - 0.55) * Math.PI * 2) / 0.8))
      : action === 'stretch'
        ? -1.8
        : sitting
          ? 0.5
          : action === 'wave'
            ? -2.25 + Math.sin(age * 8) * 0.25 * secondary
            : action === 'groom'
              ? 0.55
              : action === 'headphones'
                ? -2.15 - Math.sin(age * 4) * 0.08
                : armSwing;
  const targetFoot = (side: -1 | 1): Point =>
    walking
      ? side === -1
        ? gait.left
        : gait.right
      : {
          x:
            side * (sitting ? 31 : 20) +
            (climb ? facing * (side === facing ? 24 : 8) : 0),
          y: held
            ? 7
            : sitting
              ? 0
              : climb
                ? -7 -
                  (1 +
                    side *
                      Math.sin((Math.max(0, age - 0.55) * Math.PI * 2) / 0.8)) *
                    3
                : 0,
        };
  const lf = targetFoot(-1),
    rf = targetFoot(1);
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
  const bounce = walking ? gait.bounce : 0;
  const look =
    input.look ??
    (action === 'look_around'
      ? { x: Math.sin(age * 1.7) * 0.85, y: Math.cos(age * 2.1) * 0.35 }
      : action === 'peek'
        ? { x: facing * 0.5, y: 1 }
        : { x: 0, y: 0 });
  const next: RigPose = {
    bodyY: 0,
    seated: mix(previous.seated, sitting ? 1 : 0, easing),
    look: {
      x: mix(previous.look.x, look.x, easing),
      y: mix(previous.look.y, look.y, easing),
    },
    love: mix(previous.love, input.loved || action === 'pet' ? 1 : 0, easing),
    lean: mix(previous.lean, lean, easing),
    stretch: mix(
      previous.stretch,
      held ? 1.09 : sitting ? 0.97 : 1 - landing * 0.12 - pat * 0.09 + bounce,
      easing,
    ),
    squash: mix(
      previous.squash,
      held
        ? 0.97
        : sitting
          ? 1.07
          : 1 + landing * 0.1 + pat * 0.07 - bounce * 0.5,
      easing,
    ),
    gait: phase,
    leftArm:
      previous.leftArm +
      Math.max(
        -6 * dt,
        Math.min(6 * dt, (targetLeft - previous.leftArm) * easing),
      ),
    rightArm:
      previous.rightArm +
      Math.max(
        -6 * dt,
        Math.min(6 * dt, (targetRight - previous.rightArm) * easing),
      ),
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
    speech: mix(previous.speech, 0, 1 - Math.exp(-dt / 0.045)),
    effort: mix(previous.effort, effort, easing),
    pinch: mix(previous.pinch, held ? 1 : 0, easing),
    facing: mix(previous.facing, facing, easing),
    breathing: Math.sin(time * 2.2) * secondary * (sleepy ? 1.8 : 0.65),
  };
  if (input.voice) {
    const thinking = input.voice === 'thinking' || input.voice === 'connecting';
    const speaking = input.voice === 'speaking';
    const listening = input.voice === 'listening';
    const wave = reducedMotion ? 0 : Math.sin(time * 2.5);
    next.lean = mix(
      previous.lean,
      listening ? -0.055 : thinking ? 0.045 : wave * 0.018,
      easing,
    );
    next.look = {
      x: mix(previous.look.x, thinking ? 0.35 : 0, easing),
      y: mix(previous.look.y, thinking ? -0.55 : -0.05, easing),
    };
    next.eyeOpen = mix(
      previous.eyeOpen,
      thinking ? 0.65 : blink * 1.08,
      easing,
    );
    next.mouth = mix(previous.mouth, 0, easing);
    // A varied, soft syllable rhythm with occasional closed-mouth pauses.
    // This is a stylized speaking cue, not phoneme/audio synchronization.
    const syllable =
      (1 + Math.sin(time * 18 + 0.65 * Math.sin(time * 2.3))) / 2;
    const phrase = Math.max(0, Math.min(1, (Math.sin(time * 2.1) + 0.86) * 5));
    const opening = reducedMotion
      ? 0.3
      : Math.pow(syllable, 1.5) *
        (0.55 + 0.25 * Math.sin(time * 4.1) ** 2) *
        phrase;
    next.speech = mix(
      previous.speech,
      speaking ? opening : 0,
      1 - Math.exp(-dt / 0.045),
    );
    // A hand cupped toward the headphones means listening; a tucked hand and
    // upward gaze mean thinking. Speech opens/closes the mouth and gestures.
    next.leftArm = mix(
      previous.leftArm,
      listening ? 1.85 : thinking ? -1.15 : 0.15 + wave * 0.12,
      easing,
    );
    next.rightArm = mix(
      previous.rightArm,
      input.voice === 'approval' ? -1.9 : speaking ? -0.35 - wave * 0.15 : 0,
      easing,
    );
  }
  // The rump rests on the surface; seated feet remain in front on that same
  // surface. This lowers the body by its actual sole gap rather than crushing it.
  next.bodyY = next.seated * 7 * next.stretch * Math.cos(next.lean);
  if (!held && !climb && action !== 'fall' && action !== 'jump') {
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
  return { x: root.x + x * c - y * s, y: root.y + pose.bodyY + x * s + y * c };
}
export function worldPointToRig(
  point: Point,
  root: Point,
  pose: RigPose,
): Point {
  const x = point.x - root.x,
    y = point.y - root.y - pose.bodyY;
  const c = Math.cos(pose.lean),
    s = Math.sin(pose.lean);
  return {
    x: (x * c + y * s) / pose.squash,
    y: (-x * s + y * c) / pose.stretch,
  };
}
