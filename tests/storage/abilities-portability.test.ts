import { StorageClient } from '../../src/server/storage/storage-client.ts';
import { UnifiedSnapshotSource } from '../../src/server/storage/unified-snapshot.ts';
import { MaintenanceGate } from '../../src/server/storage/maintenance.ts';
import { RestoreService } from '../../src/server/storage/restore.ts';
import { writeArchive, readArchive } from '../../src/server/storage/archive.ts';
import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  captureAbilityState,
  restoreAbilityState,
} from '../../src/server/storage/ability-snapshot.ts';
import { WorkspaceStore } from '../../src/server/workspace.ts';
import { Store } from '../../src/server/store.ts';
import { restoreSQLite } from '../../src/server/storage/restore-sqlite.ts';
import { initializeSQLiteSchema } from '../../src/server/storage/sqlite-schema.ts';
import { bindPortableWorkspace } from '../../src/server/storage/portable-binding.ts';
import { parseManifest } from '../../src/shared/abilities/manifest.ts';
import manifestFixture from '../fixtures/abilities/manifest.json';
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function root() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'ability-portable-')),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const signal = () => new AbortController().signal;
it('captures private state only, verifies every byte, and rejects links and state escape paths', async () => {
  const home = await root(),
    key = 'a'.repeat(64),
    state = join(home, 'abilities/state', key);
  await mkdir(join(state, 'tmp'), { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'data.json'), '{"remember":true}', {
    mode: 0o600,
  });
  await writeFile(join(state, 'tmp/not-persistent'), 'temporary');
  await mkdir(join(home, 'abilities/credentials'));
  await writeFile(
    join(home, 'abilities/credentials/account.enc'),
    'TOKEN_SENTINEL',
  );
  await mkdir(join(home, 'abilities/installation'));
  await writeFile(
    join(home, 'abilities/installation/worker'),
    'not trusted after restore',
  );
  const snapshot = await captureAbilityState(
    home,
    join(home, 'snapshot'),
    signal(),
  );
  const expectedNonsecretPaths = [`abilities/state/${key}/data.json`];
  expect(snapshot.entries.map((entry) => entry.path).sort()).toEqual(
    expectedNonsecretPaths,
  );
  const destination = join(home, 'destination');
  await mkdir(destination);
  await restoreAbilityState(snapshot, destination, signal());
  expect(
    await readFile(join(destination, expectedNonsecretPaths[0]), 'utf8'),
  ).toBe('{"remember":true}');
  await writeFile(
    join(snapshot.directory, expectedNonsecretPaths[0]),
    'tampered',
  );
  const rejected = join(home, 'rejected');
  await mkdir(rejected);
  await expect(
    restoreAbilityState(snapshot, rejected, signal()),
  ).rejects.toThrow();
  await symlink(
    join(home, 'abilities/credentials/account.enc'),
    join(state, 'link'),
  );
  await expect(
    captureAbilityState(home, join(home, 'linked'), signal()),
  ).rejects.toThrow();
});
it('leaves no promoted partial state after cancellation and remaps binding state to a restored workspace identity', async () => {
  const home = await root(),
    bindingId = randomUUID(),
    oldKey = createHash('sha256')
      .update(JSON.stringify(['old', bindingId]))
      .digest('hex'),
    newKey = createHash('sha256')
      .update(JSON.stringify(['new', bindingId]))
      .digest('hex');
  await mkdir(join(home, 'abilities/state', oldKey), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(join(home, 'abilities/state', oldKey, 'remember'), 'private');
  const snapshot = await captureAbilityState(
    home,
    join(home, 'snapshot'),
    signal(),
  );
  const destination = join(home, 'destination');
  await mkdir(destination);
  await expect(
    restoreAbilityState(snapshot, destination, AbortSignal.abort()),
  ).rejects.toThrow();
  await expect(
    readFile(join(destination, 'abilities/state', oldKey, 'remember')),
  ).rejects.toThrow();
  await restoreAbilityState(
    { ...snapshot, remap: { [oldKey]: newKey } },
    destination,
    signal(),
  );
  expect(
    await readFile(
      join(destination, 'abilities/state', newKey, 'remember'),
      'utf8',
    ),
  ).toBe('private');
});
async function database() {
  const home = await root(),
    source = join(home, 'workspace.sqlite'),
    owner = randomUUID();
  new Store(source).close();
  const workspace = new WorkspaceStore(source, owner),
    dot = workspace.dots()[0];
  const manifest = parseManifest(manifestFixture),
    digest = 'a'.repeat(64);
  workspace.abilities.recordPackage({
    digest,
    root: '/unused',
    manifest,
    descriptor: {
      formatVersion: 1,
      manifest,
      sourceCommit: 'b'.repeat(40),
      releaseTag: 'fixture/v0.1.0',
      asset: {
        id: 1,
        name: 'fixture.tar.gz',
        sha256: digest,
        compressedBytes: 1,
        extractedBytes: 1,
        fileCount: 1,
      },
    },
    files: [
      {
        path: 'worker.mjs',
        sha256: 'c'.repeat(64),
        size: 1,
        executable: false,
      },
    ],
  });
  const binding = workspace.abilities.bind(
    dot.id,
    digest,
    manifest.permissions.map((p) => p.id),
    {},
  );
  workspace.close();
  const db = new DatabaseSync(source);
  initializeSQLiteSchema(db);
  db.close();
  return { home, source, owner, dot, binding };
}
it('restores records with every binding disabled and requires fresh reviewed consent before enabling', async () => {
  const f = await database(),
    destination = join(f.home, 'restored/data/workspace.sqlite');
  await mkdir(join(f.home, 'restored/data'), { recursive: true });
  await mkdir(join(f.home, 'restored/recovery'));
  await restoreSQLite(f.source, destination, f.owner, signal(), 'sqlite', 7);
  const restored = new WorkspaceStore(destination, f.owner);
  cleanups.push(() => restored.close());
  const restoredBindings = restored.abilities.list(f.dot.id);
  expect(restoredBindings.every((binding) => !binding.enabled)).toBe(true);
  expect(restoredBindings[0]).toMatchObject({
    restored: true,
    id: f.binding.id,
  });
  expect(restoredBindings[0].revision).toBeGreaterThan(f.binding.revision);
  expect(() => restored.abilities.enable(f.binding.id)).toThrow();
  expect(restored.abilities.packages()).toHaveLength(1);
});
it('revokes Ability authority when a portable workspace changes hosts', async () => {
  const f = await database(),
    db = new DatabaseSync(f.source);
  cleanups.push(() => db.close());
  bindPortableWorkspace(db, 'new-machine');
  expect(
    db.prepare('SELECT enabled,restored,revision FROM ability_bindings').get(),
  ).toMatchObject({
    enabled: 0,
    restored: 1,
    revision: f.binding.revision + 1,
  });
});

it('round-trips the decoded versioned archive while excluding credentials and executable packages', async () => {
  const f = await database(),
    workspaceId = randomUUID(),
    key = createHash('sha256')
      .update(JSON.stringify([workspaceId, f.binding.id]))
      .digest('hex');
  const state = join(f.home, 'abilities/state', key);
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'private.json'), '{"value":"before"}');
  await mkdir(join(f.home, 'abilities/credentials'));
  await writeFile(
    join(f.home, 'abilities/credentials/account.enc'),
    'TOKEN_SENTINEL',
  );
  const storage = await StorageClient.open({
    database: f.source,
    ownerId: f.owner,
  });
  cleanups.push(() => storage.close());
  let held = false;
  const source = new UnifiedSnapshotSource({
    storage,
    sqlitePath: f.source,
    ownerId: f.owner,
    workspaceId,
    gate: new MaintenanceGate(),
    quiesceAbilities: async () => {
      held = true;
      await writeFile(join(state, 'private.json'), '{"value":"stopped"}');
      return async () => {
        held = false;
      };
    },
  });
  const directory = join(f.home, 'captured'),
    manifest = await source.capture(directory, signal());
  expect(held).toBe(false);
  expect(manifest).toMatchObject({
    version: 3,
    minimumReader: 3,
    abilities: { version: 1 },
    storage: { engine: 'sqlite', schema: 7 },
  });
  const expectedNonsecretPaths = [
    `abilities/state/${key}/private.json`,
    'core/workspace.sqlite',
    'recovery/configuration.json',
  ].sort();
  const archive = join(f.home, 'backup.dotsbackup');
  await writeArchive({
    sourceDirectory: directory,
    destination: archive,
    manifest,
    passphrase: 'fixture recovery password',
    signal: signal(),
  });
  const decoded = await readArchive({
    source: archive,
    stagingDirectory: join(f.home, 'decoded'),
    passphrase: 'fixture recovery password',
    signal: signal(),
  });
  expect(decoded.entries.map((entry) => entry.path).sort()).toEqual(
    expectedNonsecretPaths,
  );
  const destination = join(f.home, 'restored'),
    service = new RestoreService({
      profile: join(f.home, 'profile'),
      stopWorkspace: async () => {},
    });
  const preview = await service.prepareRestore({
    archive,
    destination,
    passphrase: 'fixture recovery password',
    signal: signal(),
  });
  const nextKey = createHash('sha256')
    .update(JSON.stringify([preview.workspaceId, f.binding.id]))
    .digest('hex');
  expect(
    await readFile(
      join(destination, 'data/abilities/state', nextKey, 'private.json'),
      'utf8',
    ),
  ).toBe('{"value":"stopped"}');
  const restored = new DatabaseSync(join(destination, 'data/opendots.sqlite'), {
    readOnly: true,
  });
  const restoredBindings = restored
    .prepare('SELECT enabled,restored FROM ability_bindings')
    .all();
  restored.close();
  expect(
    restoredBindings.every((binding) => !binding.enabled && !!binding.restored),
  ).toBe(true);
  await service.discardRestore(preview.operationId, signal());
  const aborted = new AbortController(),
    interrupted = join(f.home, 'interrupted');
  const cancelling = new RestoreService({
    profile: join(f.home, 'profile'),
    stopWorkspace: async () => {},
    onPhase: (_id, phase) => {
      if (phase === 'verified') {
        aborted.abort();
        aborted.signal.throwIfAborted();
      }
    },
  });
  await expect(
    cancelling.prepareRestore({
      archive,
      destination: interrupted,
      passphrase: 'fixture recovery password',
      signal: aborted.signal,
    }),
  ).rejects.toThrow();
  await expect(
    readFile(join(interrupted, 'data/opendots.sqlite')),
  ).rejects.toThrow();
  expect(await readFile(join(state, 'private.json'), 'utf8')).toBe(
    '{"value":"stopped"}',
  );
}, 30_000);

it('persists cleanup tombstones on Dot removal and never replays an old invocation after restoration', async () => {
  const f = await database(),
    original = new WorkspaceStore(f.source, f.owner);
  original.bindThread('thread', f.dot.id, 'Test');
  const context = {
    workspaceId: 'workspace',
    sessionId: 'session',
    dotId: f.dot.id,
    bindingId: f.binding.id,
    digest: f.binding.digest,
    grantRevision: f.binding.revision,
    invocationId: randomUUID(),
    tool: 'search',
    threadId: 'thread',
  };
  expect(original.abilities.claimInvocation(context)).toBe(true);
  original.close();
  const db = new DatabaseSync(f.source);
  db.prepare('DELETE FROM dots WHERE id=?').run(f.dot.id);
  db.close();
  const reopened = new WorkspaceStore(f.source, f.owner);
  cleanups.push(() => reopened.close());
  expect(reopened.abilities.get(f.binding.id)).toBeUndefined();
  expect(reopened.abilities.pendingCleanup()).toEqual([f.binding.id]);
  expect(reopened.abilities.receipt(context.invocationId)).toMatchObject({
    state: 'settled',
    outcome: { status: 'uncertain' },
  });
  expect(reopened.abilities.claimInvocation(context)).toBe(false);
  reopened.abilities.completeCleanup(f.binding.id);
  expect(reopened.abilities.pendingCleanup()).toEqual([]);
});

it('keeps interrupted invocation IDs consumed after restore and fresh consent', async () => {
  const f = await database(),
    original = new WorkspaceStore(f.source, f.owner);
  original.bindThread('thread', f.dot.id, 'Test');
  const context = {
    workspaceId: 'workspace',
    sessionId: 'session',
    dotId: f.dot.id,
    bindingId: f.binding.id,
    digest: f.binding.digest,
    grantRevision: f.binding.revision,
    invocationId: randomUUID(),
    tool: 'search',
    threadId: 'thread',
  };
  expect(original.abilities.claimInvocation(context)).toBe(true);
  original.close();
  const history = new DatabaseSync(f.source);
  history
    .prepare(
      'INSERT INTO conversation_threads(owner_id,id,agent_id,created_at,updated_at) VALUES(?,?,?,?,?)',
    )
    .run(f.owner, 'thread', f.dot.id, 0, 0);
  history.close();
  const destination = join(f.home, 'restored/data/workspace.sqlite');
  await mkdir(join(f.home, 'restored/data'), { recursive: true });
  await mkdir(join(f.home, 'restored/recovery'));
  await restoreSQLite(f.source, destination, f.owner, signal(), 'sqlite', 7);
  const restored = new WorkspaceStore(destination, f.owner);
  cleanups.push(() => restored.close());
  expect(restored.abilities.receipt(context.invocationId)).toMatchObject({
    state: 'settled',
    outcome: { status: 'uncertain' },
  });
  const reviewed = restored.abilities.bind(
    f.dot.id,
    f.binding.digest,
    f.binding.grants,
    {},
  );
  expect(
    restored.abilities.claimInvocation({
      ...context,
      grantRevision: reviewed.revision,
    }),
  ).toBe(false);
});

it('migrates an actual schema-4 backup and leaves its package and Dot authority inert', async () => {
  const f = await database();
  const old = new DatabaseSync(f.source);
  old.exec(
    "DROP TABLE voice_input_receipts; DROP TABLE ability_installations; DELETE FROM workspace_storage_schema WHERE version>=5; DROP TABLE project_execution_bindings; DROP INDEX voice_delegations_active_dot; CREATE UNIQUE INDEX voice_delegations_active_dot ON voice_delegations(owner_id,dot_id) WHERE status IN ('queued','running','approval');",
  );
  old.close();
  const destination = join(f.home, 'historical/data/workspace.sqlite');
  await mkdir(join(f.home, 'historical/data'), { recursive: true });
  await mkdir(join(f.home, 'historical/recovery'));
  await restoreSQLite(f.source, destination, f.owner, signal(), 'sqlite', 4);
  const restored = new WorkspaceStore(destination, f.owner);
  cleanups.push(() => restored.close());
  expect(restored.abilities.installations()).toEqual([
    expect.objectContaining({
      digest: f.binding.digest,
      enabled: false,
      restored: true,
    }),
  ]);
  expect(() => restored.abilities.setMaster(f.binding.digest, true)).toThrow();
  expect(restored.abilities.list(f.dot.id)[0]).toMatchObject({
    enabled: false,
    restored: true,
  });
  const unchanged = new DatabaseSync(f.source, { readOnly: true });
  expect(
    unchanged
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name='ability_installations'",
      )
      .get(),
  ).toBeUndefined();
  unchanged.close();
});

it('requires central review for an unassigned Ability from a historical legacy backup', async () => {
  const f = await database();
  const current = new WorkspaceStore(f.source, f.owner);
  const pkg = current.abilities.package(f.binding.digest)!;
  current.close();
  const source = join(f.home, 'legacy.sqlite');
  const base = new Store(source);
  base.close();
  const legacy = new WorkspaceStore(source, f.owner);
  legacy.abilities.recordPackage({ ...pkg, root: '/unused' });
  legacy.close();
  const old = new DatabaseSync(source);
  old.exec('DROP TABLE ability_installations');
  old.close();
  const destination = join(f.home, 'legacy-restored/data/workspace.sqlite');
  await mkdir(join(f.home, 'legacy-restored/data'), { recursive: true });
  await mkdir(join(f.home, 'legacy-restored/recovery'));
  await restoreSQLite(
    source,
    destination,
    f.owner,
    signal(),
    'legacy-postgres',
  );
  const restored = new WorkspaceStore(destination, f.owner);
  cleanups.push(() => restored.close());
  expect(restored.abilities.installations()[0]).toMatchObject({
    enabled: false,
    restored: true,
    enabledDots: 0,
  });
  expect(() => restored.abilities.setMaster(pkg.digest, true)).toThrow();
});
