import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import fixture from '../fixtures/abilities/manifest.json';
import protocol from '../fixtures/abilities/protocol.json';
import {
  manifestSchema,
  parseManifest,
  parseReleaseDescriptor,
  validateValue,
} from '../../src/shared/abilities/manifest.ts';
import {
  parseWorkerMessage,
  parseOutcome,
  parseOwnerOutcome,
} from '../../src/shared/abilities/protocol.ts';
import { permissionDiff } from '../../src/shared/abilities/permissions.ts';
import { abilityLimits } from '../../src/shared/abilities/limits.ts';

const copy = () => structuredClone(fixture);
describe('Ability author contract', () => {
  it('accepts a complete version-one manifest and binds its release bytes', () => {
    const manifest = parseManifest(fixture);
    expect(manifest.source).toEqual({
      owner: 'example',
      repository: 'abilities',
    });
    expect(
      parseReleaseDescriptor({
        formatVersion: 1,
        manifest,
        sourceCommit: 'a'.repeat(40),
        releaseTag: 'fixture/v0.1.0',
        asset: {
          id: 12,
          name: 'fixture.tar.gz',
          sha256: 'b'.repeat(64),
          compressedBytes: 100,
          extractedBytes: 200,
          fileCount: 2,
        },
      }).manifest,
    ).toEqual(manifest);
  });
  it.each([
    { formatVersion: 2 },
    { apiVersion: 0 },
    { arbitraryCode: 'run' },
    { source: { owner: 'Example', repository: 'abilities' } },
    { source: { owner: 'example', repository: '../different' } },
    { entrypoint: { runtime: 'shell', path: 'run.sh' } },
    { entrypoint: { runtime: 'python', path: '../worker.py' } },
    {
      permissions: [
        { id: 'desktop', kind: 'accessibility', purpose: 'Control apps' },
      ],
    },
    { platforms: ['linux-x64'] },
  ])('rejects unsupported declarations %j', (change) => {
    expect(() => parseManifest({ ...copy(), ...change })).toThrow();
  });
  it.each(['..', '%2f', 'a/b', 'a\\b', '', 'a?x=1'])(
    'rejects unsafe route segment %s',
    (segment) => {
      const value = copy();
      value.permissions[1].path = [segment];
      expect(() => parseManifest(value)).toThrow();
    },
  );
  it.each([
    { $ref: 'https://evil.example/schema' },
    { type: 'string', pattern: '(.+)+' },
    {
      type: 'object',
      properties: {},
      required: ['missing'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
    },
    { type: 'string', minLength: 10, maxLength: 2 },
  ])('rejects unbounded or unsupported tool schemas %j', (input) => {
    const value = { ...copy(), tools: [{ ...fixture.tools[0], input }] };
    expect(() => parseManifest(value)).toThrow();
  });
  it('validates actual arguments without coercion or extra keys', () => {
    const input = parseManifest(fixture).tools[0].input;
    expect(validateValue(input, { query: 'song' })).toEqual({ query: 'song' });
    for (const value of [
      {},
      { query: 1 },
      { query: 'song', execute: 'code' },
      { query: 'x'.repeat(201) },
    ]) {
      expect(() => validateValue(input, value)).toThrow();
    }
  });
  it('rejects dangling account references and duplicate permission IDs', () => {
    const value = copy();
    value.permissions[1].account = 'missing';
    expect(() => parseManifest(value)).toThrow();
    expect(() =>
      parseManifest({
        ...copy(),
        permissions: [fixture.permissions[0], fixture.permissions[0]],
      }),
    ).toThrow();
  });
  it('treats provider visibility and runtime changes as new access', () => {
    const previous = parseManifest(fixture);
    const next = parseManifest({
      ...copy(),
      tools: [{ ...fixture.tools[0], visibility: 'model-visible' }],
    });
    expect(permissionDiff(previous, next)).toContainEqual({
      key: 'tool:search:visibility',
      kind: 'changed',
      requiresConsent: true,
    });
    expect(permissionDiff(previous, previous)).toEqual([]);
    expect(
      permissionDiff(
        previous,
        parseManifest({
          ...copy(),
          entrypoint: { runtime: 'native', path: 'bin/worker' },
        }),
      ),
    ).toContainEqual({
      key: 'entrypoint',
      kind: 'changed',
      requiresConsent: true,
    });
  });
  it('exports the actual manifest validator for author tools', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../../docs/abilities/manifest.schema.json', import.meta.url),
        'utf8',
      ),
    );
    expect(schema).toEqual(z.toJSONSchema(manifestSchema, { reused: 'ref' }));
  });
});
describe('bounded worker messages', () => {
  it('accepts only the capability request contract', () => {
    expect(parseWorkerMessage(protocol)).toEqual(protocol);
    for (const change of [
      { method: 'tools/list' },
      { params: { ...protocol.params, dotId: 'forged' } },
      { params: { kind: 'https', url: 'https://api.example.com/private' } },
    ]) {
      expect(() => parseWorkerMessage({ ...protocol, ...change })).toThrow();
    }
  });
  it('keeps model-facing owner-only outcomes free of arbitrary worker text', () => {
    expect(
      parseOutcome({ status: 'error', code: 'permission_denied' }),
    ).toEqual({ status: 'error', code: 'permission_denied' });
    expect(() =>
      parseOutcome({
        status: 'error',
        code: 'provider_error',
        message: 'provider secret',
      }),
    ).toThrow();
    expect(() =>
      parseOutcome({ status: 'success', owner: { text: 'provider content' } }),
    ).toThrow();
    expect(() =>
      parseOutcome({ status: 'error', code: 'author_chosen' }),
    ).toThrow();
    expect(() =>
      parseOutcome({ status: 'success', value: 'undeclared data' }),
    ).toThrow();
    expect(
      parseOutcome({
        status: 'success',
        visibility: 'model-visible',
        value: { count: 2 },
      }),
    ).toEqual({
      status: 'success',
      visibility: 'model-visible',
      value: { count: 2 },
    });
    expect(() =>
      parseOwnerOutcome({
        status: 'success',
        visibility: 'model-visible',
        value: 'private data',
      }),
    ).toThrow();
  });
  it('rejects oversize, cyclic and deeply nested input before validation', () => {
    expect(() =>
      parseWorkerMessage({ ...protocol, id: 'x'.repeat(1024 * 1024) }),
    ).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => parseManifest(cycle)).toThrow();
    let deep: unknown = {};
    for (let i = 0; i < 1000; i++) deep = [deep];
    expect(() => parseWorkerMessage(deep)).toThrow();
  });
  it('pins the release limits independently of configuration', () => {
    expect(abilityLimits.frameBytes).toBe(1024 * 1024);
    expect(abilityLimits.invocationMs).toBe(60_000);
    expect(abilityLimits.descriptorBytes).toBe(256 * 1024);
  });
});
