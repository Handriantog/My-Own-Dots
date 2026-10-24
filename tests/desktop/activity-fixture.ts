import type { ActivityDefinition } from '../../src/shared/abilities/activity.js';
export const definition: ActivityDefinition = {
  id: 'fixture',
  durationMs: 2000,
  approachMs: 500,
  loop: true,
  motion: { width: 200, height: 100 },
  pointer: { hand: 'right', idleMs: 5000 },
  keepAwake: 'display',
  keyframes: [0, 0.5, 1].map((at) => ({
    at,
    x: at === 0.5 ? 1 : 0,
    y: at === 0.5 ? -1 : 0,
    pose: {
      leftArm: 0,
      rightArm: at === 0.5 ? 1 : 0,
      leftArmLength: 34,
      rightArmLength: 34,
      lean: 0,
      bodyY: 0,
      leftFootY: 0,
      rightFootY: at === 0.5 ? -8 : 0,
    },
  })),
};
