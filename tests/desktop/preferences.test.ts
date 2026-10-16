import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PreferenceStore,
  parsePreferences,
} from '../../src/desktop/host/preferences.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
describe('desktop preferences', () => {
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
