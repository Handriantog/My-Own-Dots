import type { SoundName } from '../shared/contracts.js';

import type { SoundCategory } from '../../shared/dot-sounds.js';
export * from '../../shared/dot-sounds.js';
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
