import { z } from 'zod';
import {
  manifestSchema,
  releaseDescriptorSchema,
  type JsonValue,
} from './manifest.js';
import { abilityLimits, assertBoundedJson } from './limits.js';
import { errorCodeSchema, type AbilityErrorCode } from './protocol.js';

export const bridgeLimit = 32 * 1024 * 1024;
const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const json = z.custom<JsonValue>((value) => {
  try {
    assertBoundedJson(value, abilityLimits.frameBytes);
    return true;
  } catch {
    return false;
  }
});
const values = z.record(z.string().max(64), json);
export const invocationContextSchema = z.strictObject({
  workspaceId: id,
  sessionId: id,
  dotId: id,
  bindingId: z.uuid(),
  digest,
  grantRevision: z.number().int().positive().safe(),
  invocationId: id,
  tool: id,
  threadId: id,
  channel: z.enum(['text', 'voice']).optional(),
});
export const bindingSchema = z.strictObject({
  id: z.uuid(),
  dotId: id,
  digest,
  manifest: manifestSchema,
  grants: z.array(z.string().max(64)).max(100),
  settings: values,
  revision: z.number().int().positive().safe(),
  enabled: z.boolean(),
  approvedAt: z.number().int().nonnegative(),
  restored: z.boolean(),
});
export const reviewSchema = z.strictObject({
  id: z.uuid(),
  descriptor: releaseDescriptorSchema,
  descriptorUrl: z.string().max(2048),
  descriptorSha256: digest,
  archiveUrl: z.string().max(2048),
  expiresAt: z.number().int().positive(),
});
export const packageSchema = z.strictObject({
  digest,
  descriptor: releaseDescriptorSchema,
  manifest: manifestSchema,
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1024),
        sha256: digest,
        size: z.number().int().nonnegative().max(abilityLimits.extractedBytes),
        executable: z.boolean(),
      }),
    )
    .max(abilityLimits.archiveEntries),
});
export const verifiedPackageSchema = packageSchema.extend({
  root: z.string().min(1).max(4096),
});
export const invocationRequestSchema = z.strictObject({
  context: invocationContextSchema,
  arguments: values,
  settings: values,
  selectionRef: z.uuid().optional(),
});
export const hostCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('install'), review: reviewSchema }),
  z.strictObject({
    type: z.literal('invoke'),
    request: invocationRequestSchema,
    binding: bindingSchema,
    package: packageSchema,
  }),
  z.strictObject({
    type: z.literal('revoke'),
    bindingId: z.uuid(),
    revision: z.number().int().positive().safe(),
  }),
  z.strictObject({
    type: z.enum(['disconnect', 'eraseState']),
    bindingId: z.uuid(),
  }),
  z.strictObject({ type: z.literal('uninstall'), digest }),
  z.strictObject({ type: z.enum(['quiesce', 'resume']) }),
  z.strictObject({ type: z.literal('cancel'), invocationId: id }),
]);
export type HostCommand = z.infer<typeof hostCommandSchema>;
export type HostInvocation = Extract<HostCommand, { type: 'invoke' }>;
export const hostEventSchema = z.strictObject({
  sessionId: z.uuid(),
  sequence: z.number().int().positive().safe(),
  id: z.uuid().optional(),
  command: hostCommandSchema.optional(),
});
export type HostEvent = z.infer<typeof hostEventSchema>;
export class AbilityFailure extends Error {
  constructor(readonly code: AbilityErrorCode) {
    super(code);
    this.name = 'AbilityFailure';
  }
}
export function failureCode(error: unknown): AbilityErrorCode {
  return error instanceof AbilityFailure &&
    errorCodeSchema.safeParse(error.code).success
    ? error.code
    : 'invalid_response';
}
export function loopbackBackend(input: string): URL {
  const url = new URL(input);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new AbilityFailure('host_unavailable');
  return url;
}
