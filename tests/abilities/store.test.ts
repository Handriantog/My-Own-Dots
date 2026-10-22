import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../fixtures/abilities/manifest.json';
import { parseManifest } from '../../src/shared/abilities/manifest.ts';
import type {
  Binding,
  InvocationContext,
  VerifiedPackage,
} from '../../src/shared/abilities/types.ts';
import { WorkspaceStore } from '../../src/server/workspace.ts';
import { AbilityStore } from '../../src/server/abilities/store.ts';
import { StorageClient } from '../../src/server/storage/storage-client.ts';
import { initializeSQLiteSchema } from '../../src/server/storage/sqlite-schema.ts';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const pkg = (): VerifiedPackage => {
  const parsed = parseManifest(manifest);
  return {
    digest: 'a'.repeat(64),
    root: '/host-only/private/path',
    manifest: parsed,
    descriptor: {
      formatVersion: 1,
      manifest: parsed,
      sourceCommit: 'b'.repeat(40),
      releaseTag: 'fixture/v0.1.0',
      asset: {
        id: 12,
        name: 'fixture.tar.gz',
        sha256: 'a'.repeat(64),
        compressedBytes: 10,
        extractedBytes: 20,
        fileCount: 2,
      },
    },
    files: [
      {
        path: 'ability.json',
        sha256: 'c'.repeat(64),
        size: 10,
        executable: false,
      },
      {
        path: 'dist/worker.mjs',
        sha256: 'd'.repeat(64),
        size: 10,
        executable: false,
      },
    ],
  };
};
function context(binding: Binding): InvocationContext {
  return {
    workspaceId: 'workspace',
    sessionId: 'desktop-session',
    bindingId: binding.id,
    dotId: binding.dotId,
    digest: binding.digest,
    grantRevision: binding.revision,
    invocationId: randomUUID(),
    tool: 'search',
    threadId: 'thread-a',
  };
}
function fixture(path = ':memory:') {
  const workspace = new WorkspaceStore(path, 'owner');
  cleanup.push(() => workspace.close());
  const dotA = workspace.dots()[0];
  const dotB = workspace.createDot(
    dotA.spaceId,
    'Other Dot',
    'Fixture',
    true,
    true,
  );
  workspace.bindThread('thread-a', dotA.id, 'Fixture');
  const store: AbilityStore = workspace.abilities;
  store.recordPackage(pkg());
  return { workspace, store, dotA, dotB };
}
describe('durable Ability authority', () => {
  it('binds one Dot independently and increments revisions in the same millisecond', () => {
    const f = fixture();
    vi.spyOn(Date, 'now').mockReturnValue(123);
    const a = f.store.bind(f.dotA.id, pkg().digest, ['account', 'search'], {
      clientId: 'public-id',
    });
    expect(f.store.list(f.dotB.id)).toEqual([]);
    const first = f.store.fingerprint(f.dotA.id);
    const b = f.store.configure(a.id, { clientId: 'other-public-id' });
    const c = f.store.revoke(a.id);
    expect(b.revision).toBe(a.revision + 1);
    expect(c.revision).toBe(b.revision + 1);
    expect(c.enabled).toBe(false);
    expect(f.store.fingerprint(f.dotA.id)).not.toBe(first);
  });
  it('claims an exact authorized invocation once and denies stale or foreign bindings', () => {
    const f = fixture(),
      binding = f.store.bind(
        f.dotA.id,
        pkg().digest,
        ['account', 'search'],
        {},
      );
    const old = context(binding);
    expect(f.store.claimInvocation(old)).toBe(true);
    expect(f.store.claimInvocation(old)).toBe(false);
    expect(
      f.store.claimInvocation({ ...context(binding), dotId: f.dotB.id }),
    ).toBe(false);
    expect(
      f.store.claimInvocation({ ...context(binding), digest: 'f'.repeat(64) }),
    ).toBe(false);
    expect(
      f.store.claimInvocation({ ...context(binding), tool: 'not-declared' }),
    ).toBe(false);
    expect(
      f.store.claimInvocation({ ...context(binding), threadId: 'unbound' }),
    ).toBe(false);
    f.store.revoke(binding.id);
    expect(
      f.store.claimInvocation({ ...old, invocationId: randomUUID() }),
    ).toBe(false);
    expect(f.store.list(f.dotB.id)).toEqual([]);
  });
  it('rejects unknown grants, uninstalled bytes, nonexistent Dots and invalid settings', () => {
    const f = fixture();
    expect(() =>
      f.store.bind(f.dotA.id, pkg().digest, ['shell'], {}),
    ).toThrow();
    expect(() => f.store.bind(f.dotA.id, '0'.repeat(64), [], {})).toThrow();
    expect(() => f.store.bind('missing', pkg().digest, [], {})).toThrow();
    expect(() =>
      f.store.bind(f.dotA.id, pkg().digest, [], { accessToken: 'secret' }),
    ).toThrow();
  });
  it('keeps a revoked in-flight call uncertain and leaves another Dot enabled', () => {
    const f = fixture();
    const a = f.store.bind(f.dotA.id, pkg().digest, [], {});
    const b = f.store.bind(f.dotB.id, pkg().digest, [], {});
    const call = context(a);
    expect(f.store.claimInvocation(call)).toBe(true);
    f.store.revoke(a.id);
    f.store.settleInvocation(call.invocationId, { status: 'success' });
    expect(f.store.receipt(call.invocationId)?.outcome).toEqual({
      status: 'uncertain',
    });
    expect(f.store.get(b.id)).toEqual(b);
  });
  it('rebinds the same source and Ability atomically without inheriting grants', () => {
    const f = fixture();
    const first = f.store.bind(
      f.dotA.id,
      pkg().digest,
      ['account', 'search'],
      {},
    );
    const next = pkg();
    next.digest = 'e'.repeat(64);
    next.descriptor.asset.sha256 = next.digest;
    next.manifest.version = '0.2.0';
    next.descriptor.releaseTag = 'fixture/v0.2.0';
    f.store.recordPackage(next);
    const second = f.store.bind(f.dotA.id, next.digest, [], {});
    expect(second.id).toBe(first.id);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.grants).toEqual([]);
    expect(f.store.list(f.dotA.id)).toHaveLength(1);
  });
  it('settles once and stores generic status without model/provider content or host paths', () => {
    const f = fixture(),
      binding = f.store.bind(f.dotA.id, pkg().digest, [], {}),
      call = context(binding);
    expect(f.store.claimInvocation(call)).toBe(true);
    f.store.settleInvocation(call.invocationId, {
      status: 'success',
      visibility: 'model-visible',
      value: 'private-result-canary',
    });
    f.store.settleInvocation(call.invocationId, {
      status: 'error',
      code: 'provider_error',
    });
    expect(f.store.receipt(call.invocationId)?.outcome).toEqual({
      status: 'success',
    });
    expect(JSON.stringify(f.store.package(pkg().digest))).not.toContain(
      '/host-only',
    );
    expect(JSON.stringify(f.store.receipt(call.invocationId))).not.toContain(
      'private-result-canary',
    );
  });
  it('marks interrupted receipts uncertain on restart without replaying them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ability-receipt-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, 'workspace.sqlite');
    const f = fixture(database),
      binding = f.store.bind(f.dotA.id, pkg().digest, [], {}),
      call = context(binding);
    expect(f.store.claimInvocation(call)).toBe(true);
    cleanup.pop();
    f.workspace.close();
    const reopened = new WorkspaceStore(database, 'owner');
    cleanup.push(() => reopened.close());
    expect(reopened.abilities.receipt(call.invocationId)?.outcome).toEqual({
      status: 'uncertain',
    });
    expect(reopened.abilities.claimInvocation(call)).toBe(false);
    expect(
      (await readFile(database)).includes(
        Buffer.from('/host-only/private/path'),
      ),
    ).toBe(false);
  });
  it.each(['sqlite', 'legacy-postgres'] as const)(
    'migrates existing %s metadata and exposes authority through the storage worker',
    async (engine) => {
      const directory = await mkdtemp(join(tmpdir(), 'ability-migrate-'));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      const database = join(directory, 'workspace.sqlite');
      const old = new WorkspaceStore(database, 'owner');
      const dot = old.dots()[0];
      old.bindThread('thread-a', dot.id, 'Existing conversation');
      old.close();
      const raw = new DatabaseSync(database);
      if (engine === 'sqlite') initializeSQLiteSchema(raw, 3);
      raw.exec(
        'DROP TABLE ability_receipts; DROP TABLE ability_bindings; DROP TABLE ability_packages;',
      );
      raw.close();
      const worker = await StorageClient.open({
        database,
        ownerId: 'owner',
        engine,
      });
      cleanup.push(() => worker.close());
      const { workspace } = worker.repositories;
      expect(await workspace.dot(dot.id)).toMatchObject({
        id: dot.id,
        name: dot.name,
      });
      await workspace.abilities.recordPackage(pkg());
      const binding = await workspace.abilities.bind(
        dot.id,
        pkg().digest,
        [],
        {},
      );
      const call = context(binding);
      const results = await Promise.all([
        workspace.abilities.claimInvocation(call),
        workspace.abilities.claimInvocation(call),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      await workspace.abilities.revoke(binding.id);
      expect(
        await workspace.abilities.claimInvocation({
          ...call,
          invocationId: randomUUID(),
        }),
      ).toBe(false);
      expect((await workspace.policy.turnState(dot.id)).abilities).toBe(
        await workspace.abilities.fingerprint(dot.id),
      );
    },
  );
});
