import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_TALK_SHORTCUT,
  validTalkShortcut,
} from '../shared/talk-shortcut.js';
import { DEFAULT_CATEGORY_VOLUMES } from '../core/sound-categories.js';
import {
  BODY,
  type DesktopDisplay,
  type Point,
  type Preferences,
} from '../shared/contracts.js';

export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  color: '#45a7ff',
  volume: 0.4,
  categoryVolumes: { ...DEFAULT_CATEGORY_VOLUMES },
  muted: false,
  paused: false,
  reducedMotion: false,
  talkShortcut: DEFAULT_TALK_SHORTCUT,
  displayId: null,
  placement: null,
};
const categoryVolumeSchema = z
  .object({
    walking: z.number().min(0).max(1),
    interactions: z.number().min(0).max(1),
    climbing: z.number().min(0).max(1),
    falls: z.number().min(0).max(1),
    rest: z.number().min(0).max(1),
  })
  .strict();
const schema = z.object({
  version: z.literal(1),
  color: z.string().regex(/^#[\da-f]{6}$/i),
  volume: z.number().min(0).max(1),
  categoryVolumes: categoryVolumeSchema.default(() => ({
    ...DEFAULT_CATEGORY_VOLUMES,
  })),
  muted: z.boolean(),
  paused: z.boolean(),
  reducedMotion: z.boolean(),
  talkShortcut: z
    .string()
    .max(100)
    .refine(validTalkShortcut)
    .default(DEFAULT_TALK_SHORTCUT),
  displayId: z.string().max(128).nullable(),
  placementSpace: z.literal('bounds').optional(),
  placement: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .nullable(),
});
export function parsePreferences(value: unknown): Preferences {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_PREFERENCES };
}
const changeSchema = schema
  .pick({
    color: true,
    volume: true,
    categoryVolumes: true,
    muted: true,
    paused: true,
    reducedMotion: true,
    talkShortcut: true,
  })
  .extend({
    categoryVolumes: categoryVolumeSchema.optional(),
    talkShortcut: schema.shape.talkShortcut.removeDefault().optional(),
  })
  .partial()
  .strict();
export function parsePreferenceChange(
  value: unknown,
): Partial<Preferences> | null {
  const parsed = changeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function restorePlacement(
  preferences: Preferences,
  displays: DesktopDisplay[],
): Point | undefined {
  const display = displays.find((d) => d.id === preferences.displayId);
  if (!display || !preferences.placement) return undefined;
  const area =
    preferences.placementSpace === 'bounds' ? display.bounds : display.workArea;
  const point = {
    x: area.x + preferences.placement.x * area.width,
    y: area.y + preferences.placement.y * area.height,
  };
  if (
    point.x < area.x + BODY.width / 2 - 0.01 ||
    point.x > area.x + area.width - BODY.width / 2 + 0.01 ||
    point.y < Math.max(area.y, display.workArea.y) + BODY.height ||
    point.y > area.y + area.height
  )
    return undefined;
  return {
    ...point,
    x: Math.max(
      area.x + BODY.width / 2,
      Math.min(area.x + area.width - BODY.width / 2, point.x),
    ),
  };
}
export class PreferenceStore {
  private pending: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  async load(): Promise<Preferences> {
    try {
      return parsePreferences(
        JSON.parse(
          await readFile(path.join(this.directory, 'preferences.json'), 'utf8'),
        ),
      );
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }
  save(value: Preferences): Promise<void> {
    const data = JSON.stringify(parsePreferences(value), null, 2) + '\n';
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true });
        const temporary = path.join(this.directory, 'preferences.json.tmp');
        await writeFile(temporary, data, { mode: 0o600 });
        await rename(temporary, path.join(this.directory, 'preferences.json'));
      });
    return this.pending;
  }
}
