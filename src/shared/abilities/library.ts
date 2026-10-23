import { z } from 'zod';
export const libraryIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,99}$/);
export const sourceCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const libraryEntrySchema = z.strictObject({
  id: libraryIdSchema,
  name: z.string().min(1).max(200),
  publisher: z.string().min(1).max(200),
  license: z.string().min(1).max(100),
  status: z.enum(['planned', 'development', 'released']),
  version: z.string().max(100).nullable(),
  sourceUrl: z.url().max(2048),
  descriptorUrl: z.url().max(2048).optional(),
});
export const abilityLibrarySchema = z.strictObject({
  sourceCommit: sourceCommitSchema,
  entries: z.array(libraryEntrySchema).max(200),
});
export type AbilityLibraryEntry = z.infer<typeof libraryEntrySchema>;
export type AbilityLibrary = z.infer<typeof abilityLibrarySchema>;
