import { z } from 'zod';
import { bindingSchema, reviewSchema } from './bridge.js';
import { assertBoundedJson, abilityLimits } from './limits.js';
import { isHttpsUrl, type JsonValue } from './manifest.js';
import { errorCodeSchema } from './protocol.js';
const id = z.string().min(1).max(256),
  uuid = z.uuid();
const values = z.record(
  z.string().max(64),
  z.custom<JsonValue>((value) => {
    try {
      assertBoundedJson(value, abilityLimits.frameBytes);
      return true;
    } catch {
      return false;
    }
  }),
);
const dot = { dotId: id },
  binding = { ...dot, bindingId: uuid };
export const ownerViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    text: z.string().max(16384),
    attribution: z.string().max(100).optional(),
  }),
  z.strictObject({
    kind: z.literal('list'),
    title: z.string().max(1000),
    attribution: z.string().max(100).optional(),
    items: z
      .array(
        z.strictObject({
          id: uuid,
          label: z.string().min(1).max(1000),
          detail: z.string().max(2000).optional(),
          url: z.string().max(2048).refine(isHttpsUrl).optional(),
          selectable: z.boolean(),
        }),
      )
      .max(100),
  }),
]);
export type OwnerView = z.infer<typeof ownerViewSchema>;
const ok = z.strictObject({ ok: z.literal(true) });
const reviewOutput = reviewSchema.extend({
  storage: z
    .strictObject({
      packagePath: z.string().max(4096),
      stateParent: z.string().max(4096),
    })
    .optional(),
  changes: z
    .array(
      z.strictObject({
        key: z.string().max(256),
        kind: z.enum(['added', 'changed', 'removed']),
        requiresConsent: z.boolean(),
      }),
    )
    .max(1000),
});
export const desktopAbilityMethods = {
  list: {
    input: z.strictObject(dot),
    output: z.strictObject({
      available: z.boolean(),
      reason: errorCodeSchema.optional(),
      bindings: z.array(bindingSchema).max(1000),
      activity: z.record(uuid, z.boolean()).optional(),
      python: z
        .strictObject({
          executable: z.string().max(4096),
          readRoots: z.array(z.string().max(4096)).max(16),
        })
        .optional(),
    }),
  },
  reviewLocal: { input: z.strictObject(dot), output: reviewOutput.nullable() },
  choosePython: {
    input: z.strictObject(dot),
    output: z.strictObject({ selected: z.boolean() }),
  },
  review: {
    input: z.strictObject({ ...dot, url: z.string().min(1).max(2048) }),
    output: reviewOutput,
  },
  teach: {
    input: z.strictObject({
      ...dot,
      reviewId: uuid,
      acceptedNotices: z.array(id).max(4).optional(),
      settings: values.optional(),
    }),
    output: bindingSchema,
  },
  enable: { input: z.strictObject(binding), output: bindingSchema },
  update: {
    input: z.strictObject({
      ...binding,
      reviewId: uuid,
      acceptedNotices: z.array(id).max(4).optional(),
      settings: values.optional(),
    }),
    output: bindingSchema,
  },
  configure: {
    input: z.strictObject({ ...binding, settings: values }),
    output: bindingSchema,
  },
  connect: {
    input: z.strictObject({
      ...binding,
      accountId: id,
      clientId: z.string().min(1).max(256),
    }),
    output: ok,
  },
  account: {
    input: z.strictObject({ ...binding, accountId: id }),
    output: z.strictObject({ connected: z.boolean() }),
  },
  disable: { input: z.strictObject(binding), output: ok },
  disconnect: { input: z.strictObject(binding), output: ok },
  forget: {
    input: z.strictObject({ ...binding, eraseState: z.boolean() }),
    output: ok,
  },
  uninstall: {
    input: z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/) }),
    output: ok,
  },
  recent: {
    input: z.strictObject({ ...dot, threadId: id }),
    output: z.array(uuid).max(8),
  },
  results: {
    input: z.strictObject({ ...dot, handle: uuid }),
    output: ownerViewSchema.nullable(),
  },
  select: {
    input: z.strictObject({ ...dot, handle: uuid, itemId: uuid }),
    output: z.strictObject({ selectionRef: uuid }),
  },
} as const;
export type DesktopAbilityMethod = keyof typeof desktopAbilityMethods;
export type DesktopAbilityInput<M extends DesktopAbilityMethod> = z.infer<
  (typeof desktopAbilityMethods)[M]['input']
>;
export type DesktopAbilityOutput<M extends DesktopAbilityMethod> = z.infer<
  (typeof desktopAbilityMethods)[M]['output']
>;
export type DesktopAbilityReply<M extends DesktopAbilityMethod> =
  | { ok: true; value: DesktopAbilityOutput<M> }
  | { ok: false; code: z.infer<typeof errorCodeSchema> };
export type DesktopAbilities = {
  [M in DesktopAbilityMethod]: (
    input: DesktopAbilityInput<M>,
  ) => Promise<DesktopAbilityReply<M>>;
};
