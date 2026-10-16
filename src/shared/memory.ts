import { z } from 'zod';

export const memoryIdSchema = z.string().min(1).max(200);
export const memoryScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner') }).strict(),
  z.object({ kind: z.literal('dot'), id: memoryIdSchema }).strict(),
  z.object({ kind: z.literal('space'), id: memoryIdSchema }).strict(),
]);
export const evidenceGuardSchema = z
  .object({
    originDotId: memoryIdSchema,
    spaceIds: z.array(memoryIdSchema).max(100),
    pageIds: z.array(memoryIdSchema).max(1000),
  })
  .strict();
export const sourceRefSchema = z
  .object({
    threadId: memoryIdSchema,
    runId: memoryIdSchema,
    messageIds: z.array(memoryIdSchema).min(1).max(100),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    guard: evidenceGuardSchema,
  })
  .strict();
export const memoryKindSchema = z.enum(['fact', 'skill']);
export const memoryStatusSchema = z.enum([
  'active',
  'pending',
  'superseded',
  'rejected',
  'forgotten',
]);
const fields = {
  scope: memoryScopeSchema,
  kind: memoryKindSchema.default('fact'),
  status: memoryStatusSchema.default('active'),
  title: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(12000),
  pinned: z.boolean().default(false),
  sources: z.array(sourceRefSchema).max(100).default([]),
  expiresAt: z.number().int().nonnegative().nullable().default(null),
  supersedesId: memoryIdSchema.nullable().default(null),
};
export const memoryCreateSchema = z
  .object(fields)
  .strict()
  .refine((value) => value.kind === 'skill' || value.text.length <= 2000, {
    message: 'Facts must contain at most 2000 characters',
    path: ['text'],
  });
export const memoryPatchSchema = z.object(fields).partial().strict();
export const memoryListQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().regex(/^\d+$/).optional(),
    status: memoryStatusSchema.optional(),
    kind: memoryKindSchema.optional(),
    scope: memoryScopeSchema.optional(),
  })
  .strict();
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type EvidenceGuard = z.infer<typeof evidenceGuardSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type MemoryCreate = z.input<typeof memoryCreateSchema>;
export type MemoryPatch = z.input<typeof memoryPatchSchema>;
export type MemoryListQuery = z.input<typeof memoryListQuerySchema>;
export interface MemoryItem extends z.output<typeof memoryCreateSchema> {
  id: string;
  ownerId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface MemoryPage {
  items: MemoryItem[];
  nextCursor?: string;
}
