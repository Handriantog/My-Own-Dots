import { z } from 'zod';
import { identifier } from './identifier.js';

const poseSchema = z.strictObject({
  leftArm: z.number().min(-3.2).max(3.2),
  rightArm: z.number().min(-3.2).max(3.2),
  leftArmLength: z.number().min(20).max(70),
  rightArmLength: z.number().min(20).max(70),
  lean: z.number().min(-0.35).max(0.35),
  bodyY: z.number().min(-10).max(10),
  leftFootY: z.number().min(-12).max(12),
  rightFootY: z.number().min(-12).max(12),
});
const keyframeSchema = z.strictObject({
  at: z.number().min(0).max(1),
  x: z.number().min(-1).max(1),
  y: z.number().min(-1).max(1),
  pose: poseSchema,
});
export const activityDefinitionSchema = z
  .strictObject({
    id: identifier,
    durationMs: z.number().int().min(1000).max(120000),
    approachMs: z.number().int().min(250).max(10000),
    loop: z.boolean(),
    motion: z.strictObject({
      width: z.number().min(0).max(1200),
      height: z.number().min(0).max(800),
    }),
    keyframes: z.array(keyframeSchema).min(2).max(32),
    pointer: z
      .strictObject({
        hand: z.enum(['left', 'right']),
        idleMs: z.number().int().min(1000).max(60000),
      })
      .optional(),
    keepAwake: z.enum(['system', 'display']).optional(),
  })
  .refine((definition) => {
    if (definition.keyframes.length < 2) return false;
    const first = definition.keyframes[0],
      last = definition.keyframes.at(-1)!;
    return (
      first.at === 0 &&
      last.at === 1 &&
      definition.keyframes.every(
        (frame, index, frames) =>
          index === 0 || frame.at > frames[index - 1].at,
      ) &&
      (!definition.loop ||
        (first.x === last.x &&
          first.y === last.y &&
          Object.keys(first.pose).every(
            (key) =>
              first.pose[key as keyof typeof first.pose] ===
              last.pose[key as keyof typeof last.pose],
          )))
    );
  }, 'Activity keyframes must increase from 0 to 1 and looping endpoints must match');
export const activityCommandSchema = z.strictObject({
  action: z.enum(['start', 'stop', 'status']),
  activityId: identifier,
});
export const activityStatusSchema = z.enum([
  'inactive',
  'approaching',
  'running',
  'paused',
]);
export type ActivityDefinition = z.infer<typeof activityDefinitionSchema>;
export type ActivityCommand = z.infer<typeof activityCommandSchema>;
export type ActivityStatus = z.infer<typeof activityStatusSchema>;
export interface ActivityDriver {
  start(
    owner: { bindingId: string; dotId: string },
    definition: ActivityDefinition,
  ): Promise<void>;
  stop(bindingId?: string): void | Promise<void>;
  status(bindingId: string): ActivityStatus;
}
