import { z } from 'zod';
import type { Point, SimulationFrame } from '../shared/contracts.js';
import { worldPointToRig } from './pose.js';

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

export function armTransform(
  frame: SimulationFrame,
  side: -1 | 1,
): { rotation: number; height: number } {
  if (frame.climb && side === -frame.climb.wall.side) {
    const hand = worldPointToRig(frame.climb.hand, frame.root, frame.pose);
    const dx = hand.x - side * 39,
      dy = hand.y + 45;
    return {
      rotation: Math.atan2(-dx, dy),
      height: Math.min(70, Math.hypot(dx, dy) / 0.86),
    };
  }
  return {
    rotation: side === -1 ? frame.pose.leftArm : frame.pose.rightArm,
    height: 34,
  };
}
