import { z } from 'zod';
import { identifier, isHttpsUrl, type JsonValue } from './manifest.js';
import { abilityLimits, assertBoundedJson } from './limits.js';
import { appCommandSchema } from './app-control.js';
import { activityCommandSchema, activityStatusSchema } from './activity.js';

const requestId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const reference = z.string().uuid();
const json = z.custom<JsonValue>((value) => {
  try {
    assertBoundedJson(value, abilityLimits.frameBytes);
    return true;
  } catch {
    return false;
  }
});
const values = z.record(z.string().max(64), json);
export const errorCodeSchema = z.enum([
  'permission_denied',
  'setup_needed',
  'host_unavailable',
  'unsupported_platform',
  'timeout',
  'invalid_response',
  'rate_limited',
  'provider_error',
  'busy',
  'cancelled',
]);
export type AbilityErrorCode = z.infer<typeof errorCodeSchema>;
// This is the entire owner-only, model-facing envelope. Never spread a worker
// response into it. Result references must be minted and bound by the host.
export const ownerOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    resultRef: reference.optional(),
  }),
  z.strictObject({
    status: z.literal('selection_needed'),
    resultRef: reference,
  }),
  z.strictObject({
    status: z.literal('uncertain'),
    resultRef: reference.optional(),
  }),
  z.strictObject({
    status: z.literal('error'),
    code: errorCodeSchema,
    resultRef: reference.optional(),
  }),
]);
export const outcomeSchema = z.union([
  ownerOutcomeSchema,
  z.strictObject({
    status: z.literal('success'),
    visibility: z.literal('model-visible'),
    value: json,
  }),
]);
export type InvocationOutcome = z.infer<typeof outcomeSchema>;
const ownerItem = z.strictObject({
  label: z.string().min(1).max(1000),
  detail: z.string().max(2000).optional(),
  url: z.string().max(2048).refine(isHttpsUrl).optional(),
  action: values.optional(),
});
export const ownerResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    text: z.string().max(16_384),
    attribution: z.string().max(100).optional(),
  }),
  z.strictObject({
    kind: z.literal('list'),
    title: z.string().max(1000),
    items: z.array(ownerItem).max(100),
    attribution: z.string().max(100).optional(),
  }),
]);
export type OwnerResult = z.infer<typeof ownerResultSchema>;
export const capabilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('companion-activity'),
    ruleId: identifier,
    command: activityCommandSchema,
  }),
  z.strictObject({
    kind: z.literal('app-control'),
    ruleId: identifier,
    command: appCommandSchema,
  }),
  z.strictObject({
    kind: z.literal('https'),
    ruleId: identifier,
    pathValues: z.record(
      z.string().max(64),
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/),
    ),
    query: values,
    body: json.optional(),
  }),
  z.strictObject({
    kind: z.literal('helper'),
    helperId: identifier,
    arguments: values,
  }),
  z.strictObject({ kind: z.literal('account'), accountId: identifier }),
]);
export type CapabilityRequest = z.infer<typeof capabilitySchema>;
export const capabilityReplySchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('companion-activity'),
    status: activityStatusSchema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('app-control'),
    status: z.enum(['success', 'uncertain']),
    result: ownerResultSchema.optional(),
  }),
  z.strictObject({ ok: z.literal(false), code: errorCodeSchema }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('https'),
    status: z.number().int().min(100).max(599),
    // Only these provider headers cross the broker; no arbitrary headers/cookies.
    headers: z.strictObject({
      retryAfter: z.string().max(64).optional(),
      contentType: z.string().max(128).optional(),
    }),
    body: z.string().max(abilityLimits.responseBytes),
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('account'),
    connected: z.boolean(),
    handle: reference.optional(),
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('helper'),
    value: json,
  }),
]);
export type CapabilityReply = z.infer<typeof capabilityReplySchema>;
export const workerResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    owner: ownerResultSchema.optional(),
    value: json.optional(),
  }),
  z.strictObject({
    status: z.literal('selection_needed'),
    owner: ownerResultSchema,
  }),
  z.strictObject({
    status: z.literal('uncertain'),
    owner: ownerResultSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('error'),
    code: errorCodeSchema,
    owner: ownerResultSchema.optional(),
  }),
]);
const wire = { jsonrpc: z.literal('2.0'), id: requestId };
export const workerMessageSchema = z.union([
  z.strictObject({
    ...wire,
    method: z.literal('capability'),
    params: capabilitySchema,
  }),
  z.strictObject({
    ...wire,
    result: z.union([
      z.strictObject({ apiVersion: z.literal(1) }),
      workerResultSchema,
    ]),
  }),
  z.strictObject({ ...wire, error: z.strictObject({ code: errorCodeSchema }) }),
]);
export type WorkerMessage = z.infer<typeof workerMessageSchema>;
export const hostMessageSchema = z.union([
  z.strictObject({
    ...wire,
    method: z.literal('initialize'),
    params: z.strictObject({ apiVersion: z.literal(1) }),
  }),
  z.strictObject({
    ...wire,
    method: z.literal('invoke'),
    params: z.strictObject({
      tool: identifier,
      arguments: values,
      settings: values,
      selection: values.optional(),
    }),
  }),
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    method: z.literal('cancel'),
    params: z.strictObject({ id: requestId }),
  }),
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    method: z.literal('shutdown'),
    params: z.strictObject({}),
  }),
  z.strictObject({ ...wire, result: capabilityReplySchema }),
]);
export type HostMessage = z.infer<typeof hostMessageSchema>;
export function parseWorkerMessage(value: unknown): WorkerMessage {
  assertBoundedJson(value, abilityLimits.frameBytes);
  return workerMessageSchema.parse(value);
}
export function parseOutcome(value: unknown): InvocationOutcome {
  assertBoundedJson(value, abilityLimits.frameBytes);
  return outcomeSchema.parse(value);
}
export function parseOwnerOutcome(
  value: unknown,
): z.infer<typeof ownerOutcomeSchema> {
  assertBoundedJson(value, 1024);
  return ownerOutcomeSchema.parse(value);
}
