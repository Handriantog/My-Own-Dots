import { z } from 'zod';

export const ARCHIVE_LIMITS = Object.freeze({
  maxManifestBytes: 4 * 1024 * 1024,
  maxEntries: 100_000,
  maxTotalBytes: 64 * 1024 ** 3,
  maxFileBytes: 16 * 1024 ** 3,
  maxPathBytes: 1024,
});
export type ArchiveLimits = {
  -readonly [Key in keyof typeof ARCHIVE_LIMITS]: number;
};
export type ArchiveKind = 'workspace-backup' | 'dot-export';
export type ArchiveEntry = { path: string; bytes: number; sha256: string };

const entrySchema = z
  .object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const coverageSchema = z
  .object({
    component: z.string().min(1).max(1024),
    state: z.enum(['included', 'excluded', 'unavailable']),
    reason: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .refine((item) => item.state === 'included' || !!item.reason, {
    message: 'Excluded or unavailable components require a reason',
  });
const manifestSchema = z
  .object({
    version: z.literal(1),
    minimumReader: z.literal(1),
    kind: z.enum(['workspace-backup', 'dot-export']),
    archiveId: z.string().min(1).max(1024),
    workspaceId: z.string().min(1).max(1024),
    ownerId: z.string().min(1).max(1024),
    createdAt: z.iso.datetime(),
    entries: z.array(entrySchema),
    coverage: z.array(coverageSchema),
  })
  .strict();
export type ArchiveManifest = z.infer<typeof manifestSchema>;

/** Caller quotas may tighten, never relax, the shared format's hard limits. */
export function archiveLimits(
  overrides: Partial<ArchiveLimits> = {},
): ArchiveLimits {
  const limits: ArchiveLimits = { ...ARCHIVE_LIMITS };
  for (const key of Object.keys(limits) as (keyof ArchiveLimits)[]) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > limits[key]) {
      throw new Error(`Invalid archive limit: ${key}`);
    }
    limits[key] = value;
  }
  return limits;
}

export function parseArchiveManifest(
  json: string,
  overrides: Partial<ArchiveLimits> = {},
): ArchiveManifest {
  const limits = archiveLimits(overrides);
  if (new TextEncoder().encode(json).byteLength > limits.maxManifestBytes) {
    throw new Error('Archive manifest exceeds size limit');
  }
  const manifest = manifestSchema.parse(JSON.parse(json));
  if (manifest.entries.length > limits.maxEntries)
    throw new Error('Archive entry count exceeds limit');
  let total = 0;
  for (const entry of manifest.entries) {
    if (entry.bytes > limits.maxFileBytes)
      throw new Error('Archive file exceeds size limit');
    total += entry.bytes;
    if (total > limits.maxTotalBytes)
      throw new Error('Archive expanded size exceeds limit');
    if (new TextEncoder().encode(entry.path).byteLength > limits.maxPathBytes) {
      throw new Error('Archive path exceeds length limit');
    }
  }
  const components = new Set<string>();
  for (const coverage of manifest.coverage) {
    if (components.has(coverage.component))
      throw new Error('Duplicate archive coverage component');
    components.add(coverage.component);
  }
  return manifest;
}
