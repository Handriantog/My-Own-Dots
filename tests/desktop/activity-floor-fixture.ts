import { definition } from './activity-fixture.js';
import type { ActivityDefinition } from '../../src/shared/abilities/activity.js';
export const floor: ActivityDefinition = {
  ...definition,
  durationMs: 24000,
  motion: { kind: 'floor-walk', speed: 66, descendMs: 2400 },
  keyframes: [0, 1].map((at) => ({
    ...definition.keyframes[0],
    at,
    pose: {
      ...definition.keyframes[0].pose,
      rightArm: -1.05,
      rightArmLength: 52,
    },
  })),
};
