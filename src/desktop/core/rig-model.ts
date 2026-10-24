import { z } from 'zod';
import type { Point, RigPose, SimulationFrame } from '../shared/contracts.js';
import { rigPointToWorld, worldPointToRig } from './pose.js';

const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const layer = z.object({
  frame: z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  size: point,
  position: point,
  pivot: point,
  tint: z.boolean(),
});
const schema = z.object({
  version: z.literal(1),
  atlas: z.literal('plush-atlas.png'),
  atlasWidth: z.number().int().positive(),
  atlasHeight: z.number().int().positive(),
  layers: z.object({
    body: layer,
    headphones: layer,
    eyes: layer,
    mouth: layer,
    leftArm: layer,
    rightArm: layer,
    leftFoot: layer,
    rightFoot: layer,
    tuft: layer,
  }),
});
export type RigDefinition = z.infer<typeof schema>;
export type LayerDefinition = z.infer<typeof layer>;
export function parseRig(value: unknown): RigDefinition {
  const rig = schema.parse(value);
  for (const [name, part] of Object.entries(rig.layers)) {
    if (
      part.frame.x + part.frame.width > rig.atlasWidth ||
      part.frame.y + part.frame.height > rig.atlasHeight ||
      part.size.x <= 0 ||
      part.size.y <= 0 ||
      part.size.x > 200 ||
      part.size.y > 200 ||
      part.pivot.x < 0 ||
      part.pivot.x > 1 ||
      part.pivot.y < 0 ||
      part.pivot.y > 1
    )
      throw new Error(`Invalid plush layer ${name}`);
    if (part.tint === ['headphones', 'eyes', 'mouth'].includes(name))
      throw new Error(`Incorrect color protection for ${name}`);
  }
  return rig;
}
export function layerTint(layer: LayerDefinition, color: string): number {
  if (!layer.tint) return 0xffffff;
  if (!/^#[\da-f]{6}$/i.test(color))
    throw new Error('A six-digit body color is required.');
  const channels = [1, 3, 5].map((i) =>
    Math.max(30, parseInt(color.slice(i, i + 2), 16)),
  );
  const lift = Math.max(1, 100 / Math.max(...channels));
  for (let i = 0; i < channels.length; i++)
    channels[i] = Math.round(channels[i] * lift);
  return (channels[0] << 16) | (channels[1] << 8) | channels[2];
}
export function deformFurVertex(
  vertex: Point,
  anchor: Point | null,
  pinch: number,
): Point {
  if (!anchor || pinch <= 0) return { ...vertex };
  const dx = anchor.x - vertex.x,
    dy = anchor.y - vertex.y;
  const distance = Math.hypot(dx, dy);
  if (distance > 24) return { ...vertex };
  const weight =
    Math.pow(1 - distance / 24, 2) * Math.min(1, Math.max(0, pinch)) * 0.28;
  return { x: vertex.x + dx * weight, y: vertex.y + dy * weight };
}
export function hitTestRig(point: Point, frame: SimulationFrame): boolean {
  const p = worldPointToRig(point, frame.root, frame.pose);
  const ellipse = (x: number, y: number, rx: number, ry: number) =>
    ((p.x - x) / rx) ** 2 + ((p.y - y) / ry) ** 2 <= 1;
  const arm = (side: -1 | 1) => {
    const transform = armTransform(frame, side);
    const dx = p.x - side * 39,
      dy = p.y + 45;
    const x =
      dx * Math.cos(transform.rotation) + dy * Math.sin(transform.rotation);
    const y =
      -dx * Math.sin(transform.rotation) + dy * Math.cos(transform.rotation);
    return (
      ((x - side * 5) / 14) ** 2 +
        ((y - transform.height * 0.36) / (transform.height * 0.55)) ** 2 <=
      1
    );
  };
  return (
    ellipse(0, -55, 48, 54) ||
    ellipse(-46, -66, 14, 22) ||
    ellipse(46, -66, 14, 22) ||
    arm(-1) ||
    arm(1) ||
    ellipse(frame.pose.leftFoot.x, frame.pose.leftFoot.y - 6, 17, 10) ||
    ellipse(frame.pose.rightFoot.x, frame.pose.rightFoot.y - 6, 17, 10)
  );
}

/** The renderer and hit-test share the already blended, authoritative limb pose. */
export function armTransform(
  frame: SimulationFrame,
  side: -1 | 1,
): { rotation: number; height: number } {
  return {
    rotation: side === -1 ? frame.pose.leftArm : frame.pose.rightArm,
    height: side === -1 ? frame.pose.leftArmLength : frame.pose.rightArmLength,
  };
}

export function applyClimbContact(
  frame: SimulationFrame,
  previous: RigPose,
  dt: number,
): void {
  if (!frame.climb) return;
  const side = -frame.climb.wall.side;
  const hand = worldPointToRig(frame.climb.hand, frame.root, frame.pose);
  const dx = hand.x - side * 39,
    dy = hand.y + 45;
  // Account for the off-center authored shoulder pivot when solving the palm.
  const palmX = armPalmOffset(side, 0).x;
  const palmY = Math.sqrt(Math.max(0, dx * dx + dy * dy - palmX * palmX));
  const target = Math.atan2(dy, dx) - Math.atan2(palmY, palmX);
  const rotation = side === -1 ? 'leftArm' : 'rightArm';
  const height = side === -1 ? 'leftArmLength' : 'rightArmLength';
  const angle = Math.atan2(
    Math.sin(target - previous[rotation]),
    Math.cos(target - previous[rotation]),
  );
  const blend =
    frame.action === 'climb' && frame.actionAge < 0.55
      ? // Ease into reaching after the last airborne step. Starting the full
        // reach on that same frame adds a visible palm jerk to the jump motion.
        (1 - Math.exp(-dt / 0.12)) * Math.min(1, frame.actionAge / 0.12)
      : 1;
  frame.pose[rotation] = previous[rotation] + angle * blend;
  frame.pose[height] =
    previous[height] + (Math.min(70, palmY / 0.86) - previous[height]) * blend;
}

/** Authored palm center, shared by pointer activities and contact geometry. */
export function palmPosition(
  root: Point,
  pose: RigPose,
  hand: 'left' | 'right',
): Point {
  const side = hand === 'left' ? -1 : 1;
  const angle = hand === 'left' ? pose.leftArm : pose.rightArm;
  const height = hand === 'left' ? pose.leftArmLength : pose.rightArmLength;
  const { x, y } = armPalmOffset(side, height);
  return rigPointToWorld(
    {
      x: side * 39 + x * Math.cos(angle) - y * Math.sin(angle),
      y: -45 + x * Math.sin(angle) + y * Math.cos(angle),
    },
    root,
    pose,
  );
}

function armPalmOffset(side: number, height: number): Point {
  return { x: side * 23 * 0.22, y: height * 0.86 };
}
