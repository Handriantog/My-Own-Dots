import type { ActivitySample } from './activity.js';
import type { Point, Rect, RigPose } from '../shared/contracts.js';
import { walkingGait, worldPointToRig } from './pose.js';
import { palmPosition } from './rig-model.js';
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Cosine legs meet at zero velocity; total distance never resets at a pose loop. */
function route(
  start: number,
  lo: number,
  hi: number,
  seconds: number,
  speed: number,
) {
  if (hi - lo < 0.001) return { x: start, velocity: 0, distance: 0 };
  // Bound acceleration as well as speed, including tiny edge/narrow-area legs.
  const legDuration = (length: number) =>
    Math.max(
      (length * Math.PI) / (2 * speed),
      Math.sqrt((length * Math.PI * Math.PI) / 120),
    );
  const first = hi - start,
    firstTime = legDuration(first);
  let from = start,
    to = hi,
    distance = 0,
    age = seconds,
    duration = firstTime;
  if (seconds >= firstTime) {
    const span = hi - lo,
      legTime = legDuration(span);
    age = seconds - firstTime;
    const leg = Math.floor(age / legTime);
    age -= leg * legTime;
    duration = legTime;
    from = leg % 2 === 0 ? hi : lo;
    to = leg % 2 === 0 ? lo : hi;
    distance = first + leg * span;
  }
  const phase = duration > 0 ? age / duration : 0;
  const displacement = ((to - from) * (1 - Math.cos(phase * Math.PI))) / 2;
  return {
    x: from + displacement,
    velocity:
      (((to - from) * Math.PI) / (2 * duration)) * Math.sin(phase * Math.PI),
    distance: distance + Math.abs(displacement),
  };
}

export function sampleFloorWalk(
  motion: { kind: 'floor-walk'; speed: number; descendMs: number },
  hand: 'left' | 'right' | undefined,
  elapsed: number,
  anchor: Point,
  bounds: Rect,
  area: Rect,
  authored: RigPose,
  pickup: Pick<
    RigPose,
    'leftArm' | 'rightArm' | 'leftArmLength' | 'rightArmLength'
  >,
  reduced: boolean,
): ActivitySample {
  // Compress only on physically smaller-than-rig work areas. Arms remain authored.
  const sx = Math.min(1, Math.max(1, area.width - 1) / 240),
    sy = Math.min(1, Math.max(1, area.height - 1) / 180);
  const pose = {
    ...authored,
    bodyY: 0,
    lean: 0,
    stretch: sy,
    squash: sx,
    leftFoot: { x: -20, y: 0 },
    rightFoot: { x: 20, y: 0 },
  };
  const offset = hand
    ? palmPosition({ x: 0, y: 0 }, { ...pose, ...pickup }, hand)
    : { x: 0, y: 0 };
  const margin = 120 * sx,
    lo = area.x + margin,
    hi = Math.max(lo, area.x + area.width - margin);
  const start = clamp(anchor.x - offset.x, lo, hi);
  const floor = area.y + area.height - 1;
  const travel = route(
    start,
    lo,
    hi,
    Math.max(0, elapsed - motion.descendMs) / 1000,
    motion.speed * (reduced ? 0.15 : 1),
  );
  const blend = clamp(Math.abs(travel.velocity) / 10, 0, 1);
  const facing = Math.tanh(travel.velocity / 8);
  const gait = walkingGait(travel.distance, facing);
  pose.facing = facing;
  pose.gait = gait.phase;
  pose.lean = (travel.velocity / 4000) * (reduced ? 0.15 : 1);
  const bounce = gait.bounce * blend * (reduced ? 0.15 : 1);
  pose.stretch = sy * (1 + bounce);
  pose.squash = sx * (1 - bounce * 0.5);
  // Compensate the same full rig transform used by normal walking and rendering.
  pose.leftFoot = worldPointToRig(
    { x: mix(-20, gait.left.x, blend) * sx, y: gait.left.y * blend * sy },
    { x: 0, y: 0 },
    pose,
  );
  pose.rightFoot = worldPointToRig(
    { x: mix(20, gait.right.x, blend) * sx, y: gait.right.y * blend * sy },
    { x: 0, y: 0 },
    pose,
  );
  const palm = hand ? palmPosition({ x: 0, y: 0 }, pose, hand) : { x: 0, y: 0 };
  const progress = clamp(elapsed / motion.descendMs, 0, 1),
    settle = progress * progress * (3 - 2 * progress);
  // Interpolate the held point, not a separately clamped root: contact stays exact.
  const point = {
    x: clamp(
      mix(anchor.x, travel.x + palm.x, settle),
      bounds.x,
      bounds.x + bounds.width - 1,
    ),
    y: clamp(
      mix(anchor.y, floor + Math.min(0, palm.y), settle),
      bounds.y,
      bounds.y + bounds.height - 1,
    ),
  };
  const root = { x: point.x - palm.x, y: point.y - palm.y };
  return {
    root,
    pose,
    ...(hand ? { pointer: point } : {}),
    action: elapsed >= motion.descendMs ? 'walk' : 'idle',
    velocity: { x: travel.velocity, y: 0 },
  };
}
