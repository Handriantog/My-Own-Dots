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
