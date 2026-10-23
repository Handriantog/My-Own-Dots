import { z } from 'zod';
import { abilityLimits, assertBoundedJson } from './limits.js';
import { appActionSchema, spotifyApplication } from './app-control.js';
import { identifier } from './identifier.js';
import { activityDefinitionSchema } from './activity.js';
import { abilityIconSchema } from './icon.js';
export { identifier } from './identifier.js';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type LimitedSchema =
  | { type: 'null' }
  | { type: 'boolean'; enum?: boolean[] }
  | { type: 'string'; minLength?: number; maxLength: number; enum?: string[] }
  | {
      type: 'number' | 'integer';
      minimum?: number;
      maximum?: number;
      enum?: number[];
    }
  | { type: 'array'; items: LimitedSchema; minItems?: number; maxItems: number }
  | {
      type: 'object';
      properties: Record<string, LimitedSchema>;
      required: string[];
      additionalProperties: false;
    };

const field = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
  .refine(
    (value) => !['constructor', 'prototype', '__proto__'].includes(value),
  );
const text = z.string().min(1).max(2_000);
const unique = (values: string[]) => new Set(values).size === values.length;
const count = (max: number) => z.number().int().min(0).max(max);
export const limitedSchema: z.ZodType<LimitedSchema> = z.lazy(() =>
  z.union([
    z.strictObject({ type: z.literal('null') }),
    z.strictObject({
      type: z.literal('boolean'),
      enum: z.array(z.boolean()).min(1).max(2).optional(),
    }),
    z
      .strictObject({
        type: z.literal('string'),
        minLength: count(16_384).optional(),
        maxLength: count(16_384),
        enum: z.array(z.string().max(16_384)).min(1).max(100).optional(),
      })
      .refine(
        (s) =>
          (s.minLength ?? 0) <= s.maxLength &&
          (!s.enum ||
            s.enum.every(
              (v) => v.length >= (s.minLength ?? 0) && v.length <= s.maxLength,
            )),
      ),
    z
      .strictObject({
        type: z.enum(['number', 'integer']),
        minimum: z.number().finite().optional(),
        maximum: z.number().finite().optional(),
        enum: z.array(z.number().finite()).min(1).max(100).optional(),
      })
      .refine(
        (s) =>
          (s.minimum ?? -Infinity) <= (s.maximum ?? Infinity) &&
          (!s.enum ||
            s.enum.every(
              (v) =>
                (s.type !== 'integer' || Number.isSafeInteger(v)) &&
                v >= (s.minimum ?? -Infinity) &&
                v <= (s.maximum ?? Infinity),
            )),
      ),
    z
      .strictObject({
        type: z.literal('array'),
        items: limitedSchema,
        minItems: count(1000).optional(),
        maxItems: count(1000),
      })
      .refine((s) => (s.minItems ?? 0) <= s.maxItems),
    z
      .strictObject({
        type: z.literal('object'),
        properties: z.record(field, limitedSchema),
        required: z.array(field).max(64),
        additionalProperties: z.literal(false),
      })
      .refine(
        (s) =>
          Object.keys(s.properties).length <= 64 &&
          unique(s.required) &&
          s.required.every((key) => Object.hasOwn(s.properties, key)),
      ),
  ]),
);

function schemaDepth(schema: LimitedSchema): number {
  return schema.type === 'array'
    ? 1 + schemaDepth(schema.items)
    : schema.type === 'object'
      ? 1 + Math.max(0, ...Object.values(schema.properties).map(schemaDepth))
      : 1;
}
const schema = limitedSchema.refine((s) => schemaDepth(s) <= 8);
const objectSchema = schema.refine((s) => s.type === 'object');
export const sourceSchema = z.strictObject({
  owner: z
    .string()
    .min(1)
    .max(39)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  repository: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9._-]*$/)
    .refine((v) => !v.endsWith('.git')),
});
export const relativePath = z
  .string()
  .min(1)
  .max(240)
  .refine((path) =>
    path
      .split('/')
      .every(
        (part) =>
          /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) &&
          part !== '.' &&
          part !== '..',
      ),
  );
export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.port &&
      url.hostname.includes('.') &&
      /^[a-z0-9.-]+$/.test(url.hostname) &&
      !/^[0-9.]+$/.test(url.hostname) &&
      !url.hostname.endsWith('.localhost') &&
      ![...value].some(
        (character) => character.charCodeAt(0) <= 32 || character === '\\',
      )
    );
  } catch {
    return false;
  }
}
const httpsUrl = z.string().max(2048).refine(isHttpsUrl);
const origin = httpsUrl.refine((value) => new URL(value).origin === value);
const endpoint = httpsUrl.refine((value) => !new URL(value).search);
const entrypoint = z.strictObject({
  runtime: z.enum(['javascript', 'python', 'native']),
  path: relativePath,
});
const permissionBase = { id: identifier, purpose: text };
// Package-wide: a worker or helper can retain private data between tool calls.
export function validAppControlVisibility(manifest: {
  permissions: readonly { kind: string }[];
  tools: readonly { visibility: string }[];
}): boolean {
  return (
    !manifest.permissions.some((p) => p.kind === 'app-control') ||
    manifest.tools.every((tool) => tool.visibility === 'owner-only')
  );
}
export const permissionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...permissionBase,
    kind: z.literal('companion-activity'),
    activities: z.array(identifier).min(1).max(8).refine(unique),
    pointer: z.boolean(),
    keepAwake: z.enum(['none', 'system', 'display']),
  }),
  z.strictObject({
    ...permissionBase,
    kind: z.literal('app-control'),
    application: z.literal(spotifyApplication),
    actions: z.array(appActionSchema).min(1).max(14).refine(unique),
  }),
  z.strictObject({
    ...permissionBase,
    kind: z.literal('https'),
    origin,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z
      .array(
        z.union([
          z
            .string()
            .min(1)
            .max(100)
            .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/),
          z.strictObject({ param: field }),
        ]),
      )
      .min(1)
      .max(16),
    pathValues: objectSchema,
    query: objectSchema,
    body: schema.optional(),
    account: identifier.optional(),
  }),
  z.strictObject({
    ...permissionBase,
    kind: z.literal('oauth'),
    authorizationUrl: endpoint,
    tokenUrl: endpoint,
    resourceOrigin: origin,
    clientIdSetting: field,
    scopes: z
      .array(
        z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9:._/-]+$/),
      )
      .min(1)
      .max(50)
      .refine(unique),
  }),
  z.strictObject({
    ...permissionBase,
    kind: z.literal('helper'),
    helperId: identifier,
  }),
]);
export const manifestSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    apiVersion: z.literal(1),
    id: identifier,
    name: z.string().min(1).max(100),
    icon: abilityIconSchema.optional(),
    activities: z.array(activityDefinitionSchema).min(1).max(8).optional(),
    description: text,
    publisher: z.string().min(1).max(100),
    source: sourceSchema,
    version: z
      .string()
      .max(64)
      .regex(
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[a-z0-9.-]+)?$/,
      ),
    license: z.string().min(1).max(100),
    platforms: z.array(z.literal('darwin-arm64')).length(1),
    entrypoint,
    helpers: z
      .array(
        z.strictObject({ id: identifier, entrypoint, arguments: objectSchema }),
      )
      .max(16),
    notices: z
      .array(
        z.strictObject({
          id: identifier,
          title: z.string().min(1).max(100),
          text: z.string().min(1).max(16_384),
          required: z.boolean(),
        }),
      )
      .max(4)
      .optional(),
    settings: objectSchema,
    tools: z
      .array(
        z.strictObject({
          id: identifier,
          description: text,
          input: objectSchema,
          output: schema,
          visibility: z.enum(['owner-only', 'model-visible']),
          execution: z.literal('interactive').optional(),
          channels: z
            .array(z.enum(['text', 'voice']))
            .min(1)
            .max(2)
            .refine(unique)
            .optional(),
        }),
      )
      .min(1)
      .max(64),
    permissions: z.array(permissionSchema).max(100),
  })
  .superRefine((manifest, ctx) => {
    if (!validAppControlVisibility(manifest))
      ctx.addIssue({
        code: 'custom',
        message: 'Spotify app-control requires owner-only tools',
      });
    const bad = () =>
      ctx.addIssue({ code: 'custom', message: 'Invalid Ability references' });
    for (const list of [
      manifest.helpers,
      manifest.tools,
      manifest.permissions,
      manifest.activities ?? [],
    ])
      if (!unique(list.map((item) => item.id))) bad();
    if (
      manifest.notices &&
      !unique(manifest.notices.map((notice) => notice.id))
    )
      bad();
    for (const permission of manifest.permissions) {
      if (permission.kind === 'companion-activity') {
        if (!manifest.tools.every((tool) => tool.execution === 'interactive'))
          ctx.addIssue({
            code: 'custom',
            message: 'Companion activities require interactive tools',
          });
        for (const id of permission.activities) {
          const activity = manifest.activities?.find(
            (definition) => definition.id === id,
          );
          if (
            !activity ||
            (activity.pointer && !permission.pointer) ||
            (activity.keepAwake === 'display' &&
              permission.keepAwake !== 'display') ||
            (activity.keepAwake === 'system' && permission.keepAwake === 'none')
          )
            bad();
        }
      }
      if (
        permission.kind === 'helper' &&
        !manifest.helpers.some((helper) => helper.id === permission.helperId)
      )
        bad();
      if (
        permission.kind === 'oauth' &&
        (manifest.settings.type !== 'object' ||
          manifest.settings.properties[permission.clientIdSetting]?.type !==
            'string')
      )
        bad();
      if (permission.kind !== 'https') continue;
      const params = permission.path.flatMap((part) =>
        typeof part === 'string' ? [] : [part.param],
      );
      if (
        !unique(params) ||
        permission.pathValues.type !== 'object' ||
        JSON.stringify([...params].sort()) !==
          JSON.stringify(
            Object.keys(permission.pathValues.properties).sort(),
          ) ||
        JSON.stringify([...params].sort()) !==
          JSON.stringify([...permission.pathValues.required].sort()) ||
        Object.values(permission.pathValues.properties).some(
          (s) => s.type !== 'string',
        )
      )
        bad();
      if (permission.account) {
        const account = manifest.permissions.find(
          (p) => p.id === permission.account,
        );
        if (
          account?.kind !== 'oauth' ||
          account.resourceOrigin !== permission.origin
        )
          bad();
      }
      if (permission.method === 'GET' && permission.body) bad();
      // Token endpoints never become worker HTTP capabilities, even uncredentialed.
      if (
        manifest.permissions.some(
          (p) =>
            p.kind === 'oauth' &&
            (new URL(p.tokenUrl).origin === permission.origin ||
              new URL(p.authorizationUrl).origin === permission.origin),
        )
      )
        bad();
    }
  });
export type AbilityManifest = z.infer<typeof manifestSchema>;
export type AbilityPermission = AbilityManifest['permissions'][number];
export const releaseDescriptorSchema = z.strictObject({
  formatVersion: z.literal(1),
  manifest: manifestSchema,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  releaseTag: z
    .string()
    .min(1)
    .max(128)
    .refine((v) =>
      v.split('/').every((p) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)),
    ),
  asset: z.strictObject({
    id: z.number().int().positive().safe(),
    name: relativePath.refine((v) => !v.includes('/') && v.endsWith('.tar.gz')),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    compressedBytes: z
      .number()
      .int()
      .positive()
      .max(abilityLimits.compressedBytes),
    extractedBytes: z
      .number()
      .int()
      .positive()
      .max(abilityLimits.extractedBytes),
    fileCount: z.number().int().positive().max(abilityLimits.archiveEntries),
  }),
});
export type ReleaseDescriptor = z.infer<typeof releaseDescriptorSchema>;
export function parseManifest(value: unknown): AbilityManifest {
  assertBoundedJson(value, abilityLimits.descriptorBytes);
  return manifestSchema.parse(value);
}
export function parseReleaseDescriptor(value: unknown): ReleaseDescriptor {
  assertBoundedJson(value, abilityLimits.descriptorBytes);
  return releaseDescriptorSchema.parse(value);
}

/** Limited JSON Schema interpreter: no code generation, regex, refs or coercion. */
export function validateValue(
  schema: LimitedSchema,
  value: unknown,
): JsonValue {
  assertBoundedJson(value, abilityLimits.frameBytes);
  function check(s: LimitedSchema, v: unknown): boolean {
    switch (s.type) {
      case 'null':
        return v === null;
      case 'boolean':
        return typeof v === 'boolean' && (!s.enum || s.enum.includes(v));
      case 'string':
        return (
          typeof v === 'string' &&
          v.length >= (s.minLength ?? 0) &&
          v.length <= s.maxLength &&
          (!s.enum || s.enum.includes(v))
        );
      case 'number':
      case 'integer':
        return (
          typeof v === 'number' &&
          Number.isFinite(v) &&
          (s.type !== 'integer' || Number.isSafeInteger(v)) &&
          v >= (s.minimum ?? -Infinity) &&
          v <= (s.maximum ?? Infinity) &&
          (!s.enum || s.enum.includes(v))
        );
      case 'array':
        return (
          Array.isArray(v) &&
          v.length >= (s.minItems ?? 0) &&
          v.length <= s.maxItems &&
          v.every((item) => check(s.items, item))
        );
      case 'object':
        return (
          typeof v === 'object' &&
          v !== null &&
          !Array.isArray(v) &&
          s.required.every((key) => Object.hasOwn(v, key)) &&
          Object.entries(v).every(
            ([key, item]) =>
              Object.hasOwn(s.properties, key) &&
              check(s.properties[key], item),
          )
        );
    }
  }
  if (!check(schema, value)) throw new Error('Invalid Ability arguments');
  return structuredClone(value) as JsonValue;
}
