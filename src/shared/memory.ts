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
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
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
export const memoryPatchSchema = z
  .object({
    ...fields,
    kind: fields.kind.removeDefault(),
    status: fields.status.removeDefault(),
    pinned: fields.pinned.removeDefault(),
    sources: fields.sources.removeDefault(),
    expiresAt: fields.expiresAt.removeDefault(),
    supersedesId: fields.supersedesId.removeDefault(),
  })
  .partial()
  .strict();
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

const dreamFields = {
  title: z.string().min(1).max(120),
  text: z.string().min(1).max(12000),
  sourceIds: z.array(memoryIdSchema).min(1).max(20),
  support: z.enum(['explicit_user', 'inferred']),
  justification: z.string().min(1).max(1000),
  retention: z.enum(['stable', 'temporary']),
  expiresAt: z.number().int().nonnegative().nullable(),
};
const targetFields = {
  targetId: memoryIdSchema,
  expectedRevision: z.number().int().positive(),
};
export const dreamChangeInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), ...dreamFields }).strict(),
  z.object({ kind: z.literal('skill-candidate'), ...dreamFields }).strict(),
  z
    .object({ kind: z.literal('update'), ...dreamFields, ...targetFields })
    .strict(),
  z
    .object({ kind: z.literal('supersede'), ...dreamFields, ...targetFields })
    .strict(),
  z
    .object({ kind: z.literal('expire'), ...dreamFields, ...targetFields })
    .strict(),
  z
    .object({
      kind: z.literal('merge'),
      ...dreamFields,
      ...targetFields,
      duplicates: z.array(z.object(targetFields).strict()).min(1).max(10),
    })
    .strict(),
]);
export type DreamChangeInput = z.infer<typeof dreamChangeInputSchema>;
export type DreamChange = DreamChangeInput & {
  sources: SourceRef[];
  explicitUser: boolean;
};
export interface DreamProposal {
  changes: DreamChange[];
  evidence: SourceRef[];
  noChangeReason?: string;
}
export type PublicationPolicy = 'hybrid' | 'review_all';

export interface AppliedChange {
  before: MemoryItem | null;
  after: MemoryItem;
}
export interface ApplyReceipt {
  id: string;
  jobId: string;
  dotId: string;
  createdAt: number;
  changes: AppliedChange[];
}
export interface RestorePreview {
  id: string;
  changeSetId: string;
  expectedRevisions: Record<string, number>;
  conflicts: string[];
  changes: AppliedChange[];
  expiresAt: number;
}

export const memorySettingsSchema = z
  .object({
    revision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    enabledAt: z.number().int().nonnegative().nullable(),
    learningEnabled: z.boolean(),
    autoCompact: z.boolean(),
    autoDream: z.boolean(),
    publicationPolicy: z.enum(['hybrid', 'review_all']),
    compactThreshold: z.number().min(0.25).max(0.95),
    compactIdleMs: z.number().int().min(1000).max(86400000),
    compactExchanges: z.number().int().min(1).max(1000),
    compactNewTokens: z.number().int().min(100).max(1000000),
    dreamIntervalMs: z.number().int().min(60000).max(604800000),
    dreamIdleMs: z.number().int().min(1000).max(86400000),
    jobModelCalls: z.number().int().min(1).max(3),
    jobTimeoutMs: z.number().int().min(1000).max(300000),
    automaticJobsPerDay: z.number().int().min(1).max(24),
    retries: z.number().int().min(0).max(2),
    timeZone: z
      .string()
      .max(100)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, 'Invalid IANA time zone'),
  })
  .strict();
export const memorySettingsPatchSchema = memorySettingsSchema
  .omit({ revision: true, createdAt: true, enabledAt: true })
  .partial()
  .strict();
export type MemorySettings = z.infer<typeof memorySettingsSchema>;
export type MemorySettingsPatch = z.infer<typeof memorySettingsPatchSchema>;
