import { z } from 'zod';

export const expiredFolderApprovalMessage =
  'Folder approval expired. Please ask again.';

export const voiceDelegationStatusSchema = z.enum([
  'queued',
  'running',
  'approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type VoiceDelegationStatus = z.infer<typeof voiceDelegationStatusSchema>;
const identity = z.string().min(1).max(256);
const text = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .refine((value) => !!value.trim());

/** Trusted host input. The model-facing operation contains only `request`. */
export const voiceDelegationEnqueueSchema = z
  .object({
    id: identity,
    dotId: identity,
    callId: identity,
    parentThreadId: identity,
    workerThreadId: identity,
    utteranceId: identity,
    sourceMessageId: identity,
    sourceText: text(32_768),
    request: text(16_384),
  })
  .strict();
export type VoiceDelegationEnqueue = z.infer<
  typeof voiceDelegationEnqueueSchema
>;
export interface VoiceDelegation extends VoiceDelegationEnqueue {
  ownerId: string;
  status: VoiceDelegationStatus;
  runId: string | null;
  leaseGeneration: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  createdAt: number;
  updatedAt: number;
  result: string | null;
  error: string | null;
  receiptMessageId: string | null;
  deliveredAt: number | null;
}
export type VoiceDelegationEnqueued = {
  kind: 'created' | 'existing' | 'busy';
  job: VoiceDelegation;
};
export const voiceDelegationLeaseSchema = z
  .object({
    id: identity,
    runId: identity,
    token: identity,
    generation: z.number().int().positive(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type VoiceDelegationLease = z.infer<typeof voiceDelegationLeaseSchema>;
export const voiceDelegationOutcomeSchema = z
  .object({
    status: z.enum([
      'approval',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ]),
    result: z.string().max(131_072).optional(),
    error: z.string().max(8192).optional(),
  })
  .strict();
export type VoiceDelegationOutcome = z.infer<
  typeof voiceDelegationOutcomeSchema
>;
export interface VoiceDelegationRecovery {
  reconciled?: (VoiceDelegationOutcome & { id: string; runId: string })[];
}
export interface VoiceDelegationFilter {
  parentThreadId?: string;
  callId?: string;
  active?: boolean;
}
export interface VoiceDelegationReceiptState {
  status: VoiceDelegationStatus;
  generation: number;
}
export function voiceDelegationActive(status: VoiceDelegationStatus) {
  return status === 'queued' || status === 'running' || status === 'approval';
}
