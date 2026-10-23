import type { ActivityDefinition } from '../../shared/abilities/activity.js';
import type { Point, Rect, RigPose } from '../shared/contracts.js';
import { initialPose } from './pose.js';
import { palmPosition } from './rig-model.js';

export interface ActivitySample {
  root: Point;
  pose: RigPose;
  pointer?: Point;
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

/** Global logical pixels throughout: backing scale never changes palm geometry. */
export function sampleActivity(
  definition: ActivityDefinition,
  elapsedMs: number,
  anchor: Point,
  bounds: Rect,
  reducedMotion: boolean,
  workArea: Rect = bounds,
): ActivitySample {
  const progress = definition.loop
    ? (Math.max(0, elapsedMs) % definition.durationMs) / definition.durationMs
    : clamp(elapsedMs / definition.durationMs, 0, 1);
  const frames = definition.keyframes;
  const right = frames.findIndex((f) => f.at >= progress);
  const b = frames[Math.max(1, right)],
    a = frames[Math.max(1, right) - 1];
  const t = (progress - a.at) / (b.at - a.at);
  const pose = initialPose();
  for (const key of [
    'leftArm',
    'rightArm',
    'leftArmLength',
    'rightArmLength',
    'lean',
    'bodyY',
  ] as const)
    pose[key] = mix(a.pose[key], b.pose[key], t);
  pose.leftFoot.y = mix(a.pose.leftFootY, b.pose.leftFootY, t);
  pose.rightFoot.y = mix(a.pose.rightFootY, b.pose.rightFootY, t);
  const motion = reducedMotion ? 0.15 : 1;
  const point = {
    x: clamp(
      anchor.x +
        (((mix(a.x, b.x, t) - frames[0].x) * definition.motion.width) / 2) *
          motion,
      bounds.x,
      bounds.x + bounds.width - 1,
    ),
    y: clamp(
      anchor.y +
        (((mix(a.y, b.y, t) - frames[0].y) * definition.motion.height) / 2) *
          motion,
      bounds.y,
      bounds.y + bounds.height - 1,
    ),
  };
  const offset = definition.pointer
    ? palmPosition({ x: 0, y: 0 }, pose, definition.pointer.hand)
    : { x: 0, y: 0 };
  // Pickup uses the full display. Ease both the rig and its held pointer into
  // usable space afterward, so an anchor over the Dock never jumps at contact.
  const p = clamp(elapsedMs / 2000, 0, 1),
    settle = p * p * (3 - 2 * p);
  const root = { x: point.x - offset.x, y: point.y - offset.y };
  const target = {
    x: clamp(
      clamp(root.x, workArea.x + 70, workArea.x + workArea.width - 70) +
        offset.x,
      workArea.x,
      workArea.x + workArea.width - 1,
    ),
    y: clamp(
      clamp(root.y, workArea.y + 130, workArea.y + workArea.height - 20) +
        offset.y,
      workArea.y,
      workArea.y + workArea.height - 1,
    ),
  };
  point.x = clamp(
    mix(point.x, target.x, settle),
    bounds.x,
    bounds.x + bounds.width - 1,
  );
  point.y = clamp(
    mix(point.y, target.y, settle),
    bounds.y,
    bounds.y + bounds.height - 1,
  );
  return {
    root: { x: point.x - offset.x, y: point.y - offset.y },
    pose,
    ...(definition.pointer ? { pointer: point } : {}),
  };
}

export function approachActivity(
  from: ActivitySample,
  to: ActivitySample,
  progress: number,
): ActivitySample {
  if (progress <= 0) return structuredClone(from);
  if (progress >= 1)
    return { root: { ...to.root }, pose: structuredClone(to.pose) };
  const p = clamp(progress, 0, 1),
    t = p * p * (3 - 2 * p);
  const pose = structuredClone(from.pose);
  for (const key of Object.keys(pose) as (keyof RigPose)[]) {
    const a = from.pose[key],
      b = to.pose[key];
    if (typeof a === 'number' && typeof b === 'number')
      (pose as unknown as Record<string, unknown>)[key] = mix(a, b, t);
    else if (typeof a === 'object' && typeof b === 'object')
      (pose as unknown as Record<string, unknown>)[key] = {
        x: mix(a.x, b.x, t),
        y: mix(a.y, b.y, t),
      };
  }
  return {
    root: {
      x: mix(from.root.x, to.root.x, t),
      y: mix(from.root.y, to.root.y, t),
    },
    pose,
  };
}
