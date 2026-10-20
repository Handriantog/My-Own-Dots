import { describe, expect, it } from 'vitest';
import { parseArchiveManifest } from '../../src/shared/storage-archive.ts';

const manifest = {
  version: 1,
  minimumReader: 1,
  kind: 'workspace-backup',
  archiveId: 'backup-1',
  workspaceId: 'workspace-1',
  ownerId: 'owner-1',
  createdAt: '2026-10-19T00:00:00.000Z',
  entries: [{ path: 'data/memory.json', bytes: 2, sha256: 'a'.repeat(64) }],
  coverage: [
    { component: 'core', state: 'included' },
    {
      component: 'computer:1',
      state: 'excluded',
      reason: 'Computer was not snapshotted',
    },
  ],
};

describe('archive manifest', () => {
  it('accepts the versioned recovery identity and explicit omissions', () => {
    expect(parseArchiveManifest(JSON.stringify(manifest))).toEqual(manifest);
  });
  it('accepts a unified SQLite descriptor while retaining legacy readers', () => {
    const unified = {
      ...manifest,
      version: 2,
      minimumReader: 2,
      storage: { engine: 'sqlite', schema: 2 },
    };
    expect(parseArchiveManifest(JSON.stringify(unified))).toEqual(unified);
    for (const storage of [
      undefined,
      { engine: 'postgres', schema: 2 },
      { engine: 'sqlite', schema: 999 },
    ])
      expect(() =>
        parseArchiveManifest(JSON.stringify({ ...unified, storage })),
      ).toThrow();
  });
  it.each([
    { version: 2 },
    { minimumReader: 2 },
    { kind: 'other' },
    { ownerId: '' },
    { createdAt: 'yesterday' },
    { entries: [{ path: 'one', bytes: -1, sha256: 'a'.repeat(64) }] },
    { entries: [{ path: 'one', bytes: 2, sha256: 'bad' }] },
    { coverage: [{ component: 'core', state: 'excluded' }] },
  ])('rejects invalid or unsupported manifest %j', (change) => {
    expect(() =>
      parseArchiveManifest(JSON.stringify({ ...manifest, ...change })),
    ).toThrow();
  });
  it('bounds the manifest before parsing JSON', () => {
    expect(() => parseArchiveManifest(' '.repeat(4 * 1024 * 1024 + 1))).toThrow(
      /manifest.*limit/i,
    );
  });
  it('enforces entry count, file size and total limits', () => {
    for (const limits of [
      { maxEntries: 0 },
      { maxFileBytes: 1 },
      { maxTotalBytes: 1 },
    ]) {
      expect(() =>
        parseArchiveManifest(JSON.stringify(manifest), limits),
      ).toThrow(/limit/i);
    }
  });
  it('rejects unknown fields that could carry unvalidated metadata', () => {
    expect(() =>
      parseArchiveManifest(
        JSON.stringify({ ...manifest, activateShell: 'never' }),
      ),
    ).toThrow();
  });
});
