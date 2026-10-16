import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PreferenceStore,
  parsePreferences,
  parsePreferenceChange,
  restorePlacement,
} from '../../src/desktop/host/preferences.js';
import { display } from './fixtures.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
describe('desktop preferences', () => {
  it('restores only a fully visible placement on a still-connected display', () => {
    const prefs = {
      ...DEFAULT_PREFERENCES,
      displayId: '1',
      placement: { x: 0.5, y: 1 },
    };
    expect(restorePlacement(prefs, [display])).toEqual({ x: 720, y: 850 });
    expect(
      restorePlacement({ ...prefs, placement: { x: 0, y: 1 } }, [display]),
    ).toBeUndefined();
    expect(
      restorePlacement({ ...prefs, placement: { x: 0.5, y: 0 } }, [display]),
    ).toBeUndefined();
    expect(restorePlacement(prefs, [])).toBeUndefined();
  });
  it('accepts only deliberate settings changes within supported ranges', () => {
    expect(parsePreferenceChange({ color: '#ffaa99', volume: 0.3 })).toEqual({
      color: '#ffaa99',
      volume: 0.3,
    });
    expect(parsePreferenceChange({ volume: 7 })).toBeNull();
    expect(parsePreferenceChange({ displayId: 'new' })).toBeNull();
    expect(parsePreferenceChange({ color: 'url(http://other)' })).toBeNull();
  });
  it('recovers corrupt/missing values without carrying native IDs', () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ version: 9, color: 'red', volume: 2 })).toEqual(
      DEFAULT_PREFERENCES,
    );
    expect(
      parsePreferences({
        ...DEFAULT_PREFERENCES,
        color: '#ee99cc',
        windowId: 42,
      }),
    ).toEqual({ ...DEFAULT_PREFERENCES, color: '#ee99cc' });
  });
  it('serializes atomic writes and recovers malformed files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dots-preferences-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'preferences.json'), '{broken');
    const store = new PreferenceStore(dir);
    expect(await store.load()).toEqual(DEFAULT_PREFERENCES);
    await Promise.all([
      store.save({ ...DEFAULT_PREFERENCES, muted: true }),
      store.save({ ...DEFAULT_PREFERENCES, color: '#abcdef', volume: 0.2 }),
    ]);
    expect(
      JSON.parse(await readFile(path.join(dir, 'preferences.json'), 'utf8')),
    ).toMatchObject({ color: '#abcdef', volume: 0.2 });
    expect(await new PreferenceStore(dir).load()).toMatchObject({
      color: '#abcdef',
      volume: 0.2,
    });
  });
});
