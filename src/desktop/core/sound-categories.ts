import type { SoundName } from '../shared/contracts.js';

export const SOUND_CATEGORIES = [
  'walking',
  'interactions',
  'climbing',
  'falls',
  'rest',
] as const;
export type SoundCategory = (typeof SOUND_CATEGORIES)[number];
export type CategoryVolumes = Record<SoundCategory, number>;
export const DEFAULT_CATEGORY_VOLUMES: Readonly<CategoryVolumes> = {
  walking: 1,
  interactions: 1,
  climbing: 1,
  falls: 1,
  rest: 1,
};
export const SOUND_CATEGORY: Record<SoundName, SoundCategory> = {
  appear: 'interactions',
  notice: 'interactions',
  pat: 'interactions',
  pickup: 'interactions',
  carry: 'interactions',
  release: 'interactions',
  step: 'walking',
  turn: 'walking',
  jump: 'walking',
  grab: 'climbing',
  climb: 'climbing',
  pull_up: 'climbing',
  slip: 'falls',
  fall: 'falls',
  land_soft: 'falls',
  land_hard: 'falls',
  bump: 'interactions',
  sit: 'rest',
  stand: 'rest',
  stretch: 'rest',
  yawn: 'rest',
  sleep: 'rest',
  wake: 'rest',
};
