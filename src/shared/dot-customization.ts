import { z } from 'zod';
import { ACCESSORIES, DEFAULT_ACCESSORIES } from './dot-accessories.js';
import { DEFAULT_CATEGORY_VOLUMES } from './dot-sounds.js';

export const dotCustomizationSchema = z
  .object({
    color: z.string().regex(/^#[\da-f]{6}$/i),
    accessories: z
      .object({
        headwear: z.enum(ACCESSORIES.headwear.map((item) => item.id)),
        eyewear: z.enum(ACCESSORIES.eyewear.map((item) => item.id)),
        neckwear: z.enum(ACCESSORIES.neckwear.map((item) => item.id)),
      })
      .strict(),
    volume: z.number().min(0).max(1),
    categoryVolumes: z
      .object({
        walking: z.number().min(0).max(1),
        interactions: z.number().min(0).max(1),
        climbing: z.number().min(0).max(1),
        falls: z.number().min(0).max(1),
        rest: z.number().min(0).max(1),
      })
      .strict(),
    muted: z.boolean(),
    paused: z.boolean(),
    reducedMotion: z.boolean(),
  })
  .strict();
export const dotCustomizationChangeSchema = dotCustomizationSchema.partial();
export type DotCustomization = z.infer<typeof dotCustomizationSchema>;
export const DEFAULT_DOT_CUSTOMIZATION: DotCustomization = {
  color: '#45a7ff',
  accessories: { ...DEFAULT_ACCESSORIES },
  volume: 0.4,
  categoryVolumes: { ...DEFAULT_CATEGORY_VOLUMES },
  muted: false,
  paused: false,
  reducedMotion: false,
};
/** Deliberately excludes machine preferences such as the global shortcut. */
export function customizationFromPreferences(
  value: DotCustomization,
): DotCustomization {
  return dotCustomizationSchema.parse(
    Object.fromEntries(
      Object.keys(DEFAULT_DOT_CUSTOMIZATION).map((key) => [
        key,
        value[key as keyof DotCustomization],
      ]),
    ),
  );
}
export const desktopDotSchema = z.object({
  dotId: z.string().nullable(),
  initialized: z.boolean(),
  dots: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      customization: dotCustomizationSchema,
    }),
  ),
});
export type DesktopDotState = z.infer<typeof desktopDotSchema>;
