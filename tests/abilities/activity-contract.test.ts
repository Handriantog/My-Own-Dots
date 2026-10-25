import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/abilities/manifest.json';
import activity from '../fixtures/abilities/activity.json';
import { activityDefinitionSchema } from '../../src/shared/abilities/activity';
import { parseManifest } from '../../src/shared/abilities/manifest';
import {
  capabilitySchema,
  capabilityReplySchema,
  hostMessageSchema,
  parseOwnerOutcome,
  workerResultSchema,
} from '../../src/shared/abilities/protocol';
import { invocationContextSchema } from '../../src/shared/abilities/bridge';
import { permissionDiff } from '../../src/shared/abilities/permissions';

const icon = {
  background: '#123456',
  foreground: '#ffffff',
  paths: ['M2 2H22V22H2Z'],
};
const permission = {
  id: 'motion',
  purpose: 'Move with the pointer',
  kind: 'companion-activity',
  activities: ['orbit'],
  pointer: true,
  keepAwake: 'display',
};
const manifest = () => ({
  ...structuredClone(fixture),
  id: 'third-party',
  icon,
  activities: [structuredClone(activity)],
  permissions: [permission],
  tools: fixture.tools.map((tool) => ({ ...tool, execution: 'interactive' })),
});

describe('declarative companion activity contract', () => {
  it('admits only fixed host activity reasons on error envelopes', () => {
    const activity = {
      action: 'start',
      status: 'inactive',
      reason: 'accessibility_required',
    };
    const outcome = { status: 'error', code: 'setup_needed', activity };
    expect(parseOwnerOutcome(outcome)).toEqual(outcome);
    expect(workerResultSchema.safeParse(outcome).success).toBe(false);
    for (const change of [
      { reason: 'OWNER_ONLY_SENTINEL' },
      { detail: 'OWNER_ONLY_SENTINEL' },
    ])
      expect(() =>
        parseOwnerOutcome({ ...outcome, activity: { ...activity, ...change } }),
      ).toThrow();
  });
  it('allows bounded host activity feedback while rejecting worker-forged feedback and private text', () => {
    const activity = {
      action: 'start',
      status: 'paused',
      resumeAfterIdleMs: 5000,
    };
    expect(parseOwnerOutcome({ status: 'success', activity })).toEqual({
      status: 'success',
      activity,
    });
    expect(
      workerResultSchema.safeParse({ status: 'success', activity }).success,
    ).toBe(false);
    for (const change of [
      { status: 'provider secret' },
      { detail: 'provider secret' },
      { reason: 'provider secret' },
      { resumeAfterIdleMs: 60001 },
    ])
      expect(() =>
        parseOwnerOutcome({
          status: 'success',
          activity: { ...activity, ...change },
        }),
      ).toThrow();
  });
  it('returns validation errors for too few keyframes without throwing', () => {
    expect(
      activityDefinitionSchema.safeParse({ ...activity, keyframes: [] })
        .success,
    ).toBe(false);
    expect(
      activityDefinitionSchema.safeParse({
        ...activity,
        keyframes: [activity.keyframes[0]],
      }).success,
    ).toBe(false);
  });
  it('accepts publisher-owned motion and artwork without changing version one', () => {
    const parsed = parseManifest(manifest());
    expect(parsed).toMatchObject({
      apiVersion: 1,
      formatVersion: 1,
      icon,
      activities: [activity],
    });
    expect(parseManifest(fixture).id).toBe(fixture.id);
  });
  it.each([
    { durationMs: 999 },
    { durationMs: 120001 },
    { durationMs: Infinity },
    { approachMs: 249 },
    { approachMs: 10001 },
    { motion: { width: -1, height: 200 } },
    { motion: { width: 1201, height: 200 } },
    { motion: { width: 400, height: 801 } },
    { pointer: { hand: 'middle', idleMs: 5000 } },
    { pointer: { hand: 'left', idleMs: 999 } },
    { pointer: { hand: 'left', idleMs: 60001 } },
    { keepAwake: 'forever' },
    { script: 'arbitrary' },
    { keyframes: [] },
    { keyframes: Array.from({ length: 33 }, () => activity.keyframes[0]) },
    {
      keyframes: [{ ...activity.keyframes[0], at: 0.1 }, activity.keyframes[2]],
    },
    {
      keyframes: [activity.keyframes[0], { ...activity.keyframes[2], at: 0.9 }],
    },
    {
      keyframes: [
        activity.keyframes[0],
        activity.keyframes[0],
        activity.keyframes[2],
      ],
    },
    {
      keyframes: [
        activity.keyframes[0],
        { ...activity.keyframes[1], x: 1.1 },
        activity.keyframes[2],
      ],
    },
    {
      keyframes: [activity.keyframes[0], { ...activity.keyframes[2], x: 0.1 }],
    },
    {
      keyframes: [
        activity.keyframes[0],
        {
          ...activity.keyframes[2],
          pose: { ...activity.keyframes[2].pose, lean: 0.1 },
        },
      ],
    },
  ])('rejects malformed or discontinuous activity %j', (change) => {
    expect(() =>
      parseManifest({
        ...manifest(),
        activities: [{ ...activity, ...change }],
      }),
    ).toThrow();
  });
  it.each([
    ['leftArm', -3.21],
    ['rightArm', 3.21],
    ['leftArmLength', 19],
    ['rightArmLength', 71],
    ['lean', 0.36],
    ['bodyY', 11],
    ['leftFootY', -13],
    ['rightFootY', 13],
    ['lean', undefined],
  ])('rejects invalid or missing pose field %s', (field, value) => {
    const keyframes = structuredClone(activity.keyframes);
    Object.assign(keyframes[1].pose, { [field]: value });
    expect(() =>
      parseManifest({
        ...manifest(),
        activities: [{ ...activity, keyframes }],
      }),
    ).toThrow();
  });
  it('accepts open endpoints for a non-looping activity and optional effects', () => {
    const definition: Partial<typeof activity> = structuredClone(activity);
    delete definition.pointer;
    delete definition.keepAwake;
    const value = {
      ...definition,
      loop: false,
      keyframes: [activity.keyframes[0], { ...activity.keyframes[2], x: 1 }],
    };
    expect(
      parseManifest({
        ...manifest(),
        activities: [value],
        permissions: [{ ...permission, pointer: false, keepAwake: 'none' }],
      }),
    ).toMatchObject({ activities: [value] });
  });
  it.each([
    { activities: [] },
    { activities: [activity, activity] },
    {
      activities: Array.from({ length: 9 }, (_, i) => ({
        ...activity,
        id: `orbit${i}`,
      })),
    },
    { permissions: [{ ...permission, activities: ['missing'] }] },
    { permissions: [{ ...permission, activities: [] }] },
    { permissions: [{ ...permission, activities: ['orbit', 'orbit'] }] },
    { permissions: [{ ...permission, pointer: false }] },
    { permissions: [{ ...permission, keepAwake: 'system' }] },
    { tools: fixture.tools },
    { tools: [{ ...fixture.tools[0], execution: 'scheduled' }] },
  ])('rejects ambiguous or insufficient activity grants %j', (change) => {
    expect(() => parseManifest({ ...manifest(), ...change })).toThrow();
  });
  it('requires fresh review for changed activity behavior and tool execution', () => {
    const before = parseManifest(manifest());
    const after = parseManifest({
      ...manifest(),
      activities: [{ ...activity, durationMs: 20000 }],
    });
    expect(permissionDiff(before, after)).toContainEqual({
      key: 'activities',
      kind: 'changed',
      requiresConsent: true,
    });
    const old = parseManifest(fixture);
    const interactive = parseManifest({
      ...fixture,
      tools: fixture.tools.map((tool) => ({
        ...tool,
        execution: 'interactive',
      })),
    });
    expect(permissionDiff(old, interactive)).toContainEqual({
      key: 'tool:search:execution',
      kind: 'changed',
      requiresConsent: true,
    });
  });
  it('does not require new access for artwork-only changes', () => {
    const before = parseManifest(manifest());
    const after = parseManifest({
      ...manifest(),
      icon: { ...icon, background: '#654321' },
    });
    expect(permissionDiff(before, after)).toEqual([]);
  });
  it('allows display grants to satisfy system keep-awake effects', () => {
    expect(
      parseManifest({
        ...manifest(),
        activities: [{ ...activity, keepAwake: 'system' }],
      }).permissions,
    ).toEqual([permission]);
  });
  it.each(['start', 'stop', 'status'])(
    'accepts structured %s and bounded host status',
    (action) => {
      const request = {
        kind: 'companion-activity',
        ruleId: 'motion',
        command: { action, activityId: 'orbit' },
      };
      expect(capabilitySchema.parse(request)).toEqual(request);
      for (const status of ['inactive', 'approaching', 'running', 'paused']) {
        const reply = { ok: true, kind: 'companion-activity', status };
        expect(capabilityReplySchema.parse(reply)).toEqual(reply);
      }
      expect(
        hostMessageSchema.parse({
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: { apiVersion: 1 },
        }),
      ).toMatchObject({ params: { apiVersion: 1 } });
    },
  );
  it.each([
    { action: 'launch', activityId: 'orbit' },
    { action: 'start', activityId: '../orbit' },
    { action: 'start', activityId: 'orbit', definition: activity },
  ])('rejects undeclared command inputs %j', (command) => {
    expect(
      capabilitySchema.safeParse({
        kind: 'companion-activity',
        ruleId: 'motion',
        command,
      }).success,
    ).toBe(false);
  });
  it('accepts only a boolean trusted interactive context and preserves absence', () => {
    const context = {
      workspaceId: 'w',
      sessionId: 's',
      dotId: 'd',
      bindingId: '00000000-0000-4000-8000-000000000000',
      digest: 'a'.repeat(64),
      grantRevision: 1,
      invocationId: 'i',
      tool: 'search',
      threadId: 't',
    };
    expect(
      invocationContextSchema.parse({ ...context, interactive: true }),
    ).toMatchObject({ interactive: true });
    expect(invocationContextSchema.parse(context)).not.toHaveProperty(
      'interactive',
    );
    expect(
      invocationContextSchema.safeParse({ ...context, interactive: 'true' })
        .success,
    ).toBe(false);
  });
});

describe('inert package artwork', () => {
  it.each([
    { background: 'url(https://example.com)' },
    { foreground: '#12345g' },
    { paths: [] },
    { paths: Array(13).fill('M0 0') },
    { paths: ['M' + '0'.repeat(2048)] },
    ...[
      '<path d="M0 0"/>',
      'M0 0<script>',
      'M0 0X1 1',
      'M0 0L',
      'L0 0',
      'Z',
      'M0 0L1e999 2',
      'M0,,0',
      'M0 0A1 1 0 2 0 2 2',
      'M0 0A-1 1 0 0 0 2 2',
      'M0 0A1 1 0 0.0 0 2 2',
      'M0 0A1 1 0 0 1e0 2 2',
    ].map((path) => ({ paths: [path] })),
  ])('rejects unsafe or invalid icon geometry %j', (change) => {
    expect(() =>
      parseManifest({ ...manifest(), icon: { ...icon, ...change } }),
    ).toThrow();
  });
  it('accepts curves, arcs, relative commands and compact finite coordinates', () => {
    const paths = [
      'M1 1c1 0 2 1 3 2s2 1 3 2q1 1 2 0t2 0a1 1 0 0 1 1 1z',
      'M.5-.5L1e1 2.5Z',
    ];
    expect(
      parseManifest({ ...manifest(), icon: { ...icon, paths } }),
    ).toMatchObject({ icon: { paths } });
  });
});

describe('floor walking contract', () => {
  it.each([10, 66, 120])('accepts bounded floor speed %s', (speed) => {
    expect(
      activityDefinitionSchema.parse({
        ...activity,
        motion: { kind: 'floor-walk', speed, descendMs: 2400 },
      }).motion,
    ).toEqual({ kind: 'floor-walk', speed, descendMs: 2400 });
  });
  it.each([
    { kind: 'floor-walk', speed: 9, descendMs: 2400 },
    { kind: 'floor-walk', speed: 121, descendMs: 2400 },
    { kind: 'floor-walk', speed: Infinity, descendMs: 2400 },
    { kind: 'floor-walk', speed: 66, descendMs: 499 },
    { kind: 'floor-walk', speed: 66, descendMs: 10001 },
    { kind: 'floor-walk', speed: 66, descendMs: 2400.5 },
    { kind: 'floor-walk', speed: 66, descendMs: 2400, width: 20 },
    { kind: 'other', speed: 66, descendMs: 2400 },
    { width: 20, height: 20, speed: 66 },
  ])('rejects invalid motion %j', (motion) => {
    expect(
      activityDefinitionSchema.safeParse({ ...activity, motion }).success,
    ).toBe(false);
  });
});
