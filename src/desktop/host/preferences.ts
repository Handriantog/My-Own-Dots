import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Preferences } from '../shared/contracts.js';

export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  color: '#45a7ff',
  volume: 0.4,
  muted: false,
  paused: false,
  reducedMotion: false,
  displayId: null,
  placement: null,
};
const schema = z.object({
  version: z.literal(1),
  color: z.string().regex(/^#[\da-f]{6}$/i),
  volume: z.number().min(0).max(1),
  muted: z.boolean(),
  paused: z.boolean(),
  reducedMotion: z.boolean(),
  displayId: z.string().max(128).nullable(),
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
    muted: true,
    paused: true,
    reducedMotion: true,
  })
  .partial()
  .strict();
export function parsePreferenceChange(
  value: unknown,
): Partial<Preferences> | null {
  const parsed = changeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
