import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../../src/server/workspace.ts';
import { AbilityService } from '../../src/server/abilities/service.ts';
import { parseManifest } from '../../src/shared/abilities/manifest.ts';
import { permissionDiff } from '../../src/shared/abilities/permissions.ts';
import { abilityTools } from '../../src/server/abilities/tools.ts';
import fixtureManifest from '../fixtures/abilities/manifest.json';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});
function fixture(requiredSettings = false) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanups.push(() => workspace.close());
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Fixture');
  const manifest = parseManifest({
    ...fixtureManifest,
    ...(requiredSettings
      ? {
          settings: {
            type: 'object',
            properties: {
              ...fixtureManifest.settings.properties,
              region: { type: 'string', maxLength: 20 },
            },
            required: ['region'],
            additionalProperties: false,
          },
        }
      : {}),
    notices: [
      {
        id: 'terms',
        title: 'Provider terms',
        text: 'Agree to these exact package terms.',
        required: true,
      },
      {
        id: 'privacy',
        title: 'Privacy',
        text: 'Local data notice.',
        required: false,
      },
    ],
    tools: fixtureManifest.tools.map((tool) => ({
      ...tool,
      channels: ['text'],
    })),
  });
  const descriptor = {
    formatVersion: 1 as const,
    manifest,
    sourceCommit: 'a'.repeat(40),
    releaseTag: 'fixture/v0.1.0',
    asset: {
      id: 1,
      name: 'fixture.tar.gz',
      sha256: 'b'.repeat(64),
      compressedBytes: 1,
      extractedBytes: 1,
      fileCount: 1,
    },
  };
  const pkg = {
    digest: descriptor.asset.sha256,
    descriptor,
    manifest,
    root: '/unused',
    files: [
      {
        path: 'worker.mjs',
        sha256: 'c'.repeat(64),
        size: 1,
        executable: false,
      },
    ],
  };
  const install = vi.fn(async () => pkg),
    invoke = vi.fn(async () => ({ status: 'success' as const }));
  const host = {
    session: () => ({ id: 'session', workspaceId: 'workspace' }),
    install,
    invoke,
    revoke: async () => {},
    disconnect: async () => {},
    eraseState: async () => {},
    uninstall: async () => {},
    stop: async () => {},
  };
  const service = new AbilityService(workspace, host, {
    workspaceId: 'workspace',
    resolve: async () => ({
      id: randomUUID(),
      expiresAt: Date.now() + 60000,
      descriptor,
      descriptorSha256: 'd'.repeat(64),
      descriptorUrl:
        'https://github.com/example/abilities/releases/download/fixture/fixture.json',
      archiveUrl:
        'https://api.github.com/repos/example/abilities/releases/assets/1',
    }),
  });
  const review = () =>
    service.review(
      dot.id,
      'https://github.com/example/abilities/releases/download/fixture/fixture.json',
    );
  return {
    workspace,
    dot,
    manifest,
    descriptor,
    service,
    install,
    invoke,
    review,
  };
}
it('requires every declared mandatory notice before install and records the approved manifest digest', async () => {
  const f = fixture();
  for (const accepted of [
    [],
    ['privacy'],
    ['terms', 'unknown'],
    ['terms', 'terms'],
  ]) {
    const review = await f.review();
    await expect(
      f.service.teach(f.dot.id, review.id, {}, accepted),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(f.install).not.toHaveBeenCalled();
  }
  const review = await f.review();
  const binding = await f.service.teach(f.dot.id, review.id, {}, ['terms']);
  expect(binding.manifest.notices).toEqual(f.manifest.notices);
  expect(binding.digest).toBe(f.descriptor.asset.sha256);
  expect(f.install).toHaveBeenCalledTimes(1);
  const update = await f.review();
  await expect(
    f.service.update(binding.id, update.id, {}, []),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  expect(f.install).toHaveBeenCalledTimes(1);
});
it('hides typed-only tools from voice and denies a direct voice invocation before receipt admission', async () => {
  const f = fixture();
  const binding = await f.service.teach(f.dot.id, (await f.review()).id, {}, [
    'terms',
  ]);
  expect(await f.service.tools(f.dot.id, 'text')).toHaveLength(1);
  expect(await f.service.tools(f.dot.id, 'voice')).toEqual([]);
  expect(
    await abilityTools(
      f.service,
      f.dot.id,
      'thread',
      () => {},
      new AbortController().signal,
      'voice',
    ),
  ).toEqual([]);
  const result = await f.service.invoke(
    {
      dotId: f.dot.id,
      bindingId: binding.id,
      threadId: 'thread',
      tool: 'search',
      invocationId: randomUUID(),
      arguments: { query: 'synthetic' },
      channel: 'voice',
    },
    new AbortController().signal,
  );
  expect(result).toEqual({ status: 'error', code: 'permission_denied' });
  expect(f.invoke).not.toHaveBeenCalled();
});
it('rejects unknown/duplicate channels and duplicate notices', () => {
  for (const channels of [[], ['chat'], ['text', 'text']])
    expect(() =>
      parseManifest({
        ...fixtureManifest,
        tools: fixtureManifest.tools.map((tool) => ({ ...tool, channels })),
      }),
    ).toThrow();
  const notice = { id: 'terms', title: 'Terms', text: 'Text', required: true };
  expect(() =>
    parseManifest({ ...fixtureManifest, notices: [notice, notice] }),
  ).toThrow();
});

it('highlights changed notices and expanded invocation channels in update review', () => {
  const f = fixture();
  const next = parseManifest({
    ...f.manifest,
    notices: f.manifest.notices!.map((notice) => ({
      ...notice,
      text: notice.text + ' Changed.',
    })),
    tools: f.manifest.tools.map((tool) => ({
      ...tool,
      channels: ['text', 'voice'],
    })),
  });
  expect(permissionDiff(f.manifest, next)).toEqual(
    expect.arrayContaining([
      { key: 'notices', kind: 'changed', requiresConsent: true },
      { key: 'tool:search:channels', kind: 'changed', requiresConsent: true },
    ]),
  );
});

it('local packages require the active desktop session and normal Teach consent', async () => {
  const f = fixture();
  const original = await f.review();
  const id = randomUUID();
  const local = {
    ...original,
    id,
    descriptorUrl: 'local-ability:' + id,
    archiveUrl: 'local-ability:' + id,
    localSource: '/chosen/fixture.json',
  };
  // Strip the UI-only diff before sending the bridge contract.
  const { changes, ...review } = local;
  expect(changes).toBeDefined();
  await expect(
    f.service.reviewLocal(f.dot.id, review, 'other'),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  await expect(
    f.service.reviewLocal('wrong-dot', review, 'session'),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  const prepared = await f.service.reviewLocal(f.dot.id, review, 'session');
  expect(f.install).not.toHaveBeenCalled();
  await expect(
    f.service.teach(f.dot.id, prepared.id, {}, []),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  await f.service.reviewLocal(f.dot.id, review, 'session');
  const binding = await f.service.teach(f.dot.id, review.id, {}, ['terms']);
  expect(binding.dotId).toBe(f.dot.id);
});

it('installs centrally without enabling or assigning a Dot before explicit actions', async () => {
  const f = fixture();
  const review = await f.service.reviewInstall(
    'https://github.com/example/abilities/releases/download/fixture/fixture.json',
  );
  const installed = await f.service.install(review.id, {}, ['terms']);
  expect(installed.enabled).toBe(false);
  expect(await f.service.list(f.dot.id)).toEqual([]);
  await expect(
    f.service.assign(f.dot.id, installed.digest, true),
  ).rejects.toThrow();
  await f.service.setMaster(installed.digest, true);
  const binding = await f.service.assign(f.dot.id, installed.digest, true);
  expect(binding?.enabled).toBe(true);
  expect(await f.service.tools(f.dot.id)).toHaveLength(1);
});

it('master disable stops execution and preserves individual selections across re-enable', async () => {
  const f = fixture(),
    review = await f.review();
  const binding = await f.service.teach(f.dot.id, review.id, {}, ['terms']);
  const other = f.workspace.createDot(f.dot.spaceId, 'Other', '', true, true);
  await f.service.assign(other.id, binding.digest, true);
  await f.service.assign(other.id, binding.digest, false);
  await f.service.setMaster(binding.digest, false);
  expect((await f.service.list(f.dot.id))[0].enabled).toBe(true);
  expect((await f.service.list(other.id))[0].enabled).toBe(false);
  expect(await f.service.tools(f.dot.id)).toEqual([]);
  expect(
    await f.service.invoke(
      {
        dotId: f.dot.id,
        bindingId: binding.id,
        threadId: 'thread',
        tool: 'search',
        invocationId: randomUUID(),
        arguments: { query: 'test' },
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ status: 'error' });
  expect(f.invoke).not.toHaveBeenCalled();
  await f.service.setMaster(binding.digest, true);
  expect(await f.service.tools(f.dot.id)).toHaveLength(1);
  expect(await f.service.tools(other.id)).toEqual([]);
});

it('applies to all existing Dots idempotently without opting in future Dots', async () => {
  const f = fixture(),
    review = await f.review();
  const binding = await f.service.teach(f.dot.id, review.id, {}, ['terms']);
  const other = f.workspace.createDot(f.dot.spaceId, 'Other', '', true, true);
  await f.service.applyAll(binding.digest);
  const first = (await f.service.list(other.id))[0];
  await f.service.applyAll(binding.digest);
  expect((await f.service.list(other.id))[0].id).toBe(first.id);
  const later = f.workspace.createDot(f.dot.spaceId, 'Later', '', true, true);
  expect(await f.service.tools(later.id)).toEqual([]);
});

it('retains reviewed required settings when applying a previously taught Ability to another Dot', async () => {
  const f = fixture(true);
  const reviewed = await f.review();
  const binding = await f.service.teach(
    f.dot.id,
    reviewed.id,
    { region: 'SG' },
    ['terms'],
  );
  const other = f.workspace.createDot(f.dot.spaceId, 'Other', '', true, true);
  await f.service.assign(other.id, binding.digest, true);
  expect(f.workspace.abilities.list(other.id)[0].settings).toEqual({
    region: 'SG',
  });
});
it('does not exchange central installation consent with a Dot-scoped review', async () => {
  const f = fixture();
  const dotReview = await f.review();
  await expect(
    f.service.install(dotReview.id, {}, ['terms']),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  const central = await f.service.reviewInstall('fixture');
  await expect(
    f.service.teach(f.dot.id, central.id, {}, ['terms']),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  expect(f.install).not.toHaveBeenCalled();
});

it('keeps a partially recorded central install disabled if final approval storage fails', async () => {
  const f = fixture();
  const reviewed = await f.service.reviewInstall('fixture');
  vi.spyOn(f.workspace.abilities, 'approveInstallation').mockImplementation(
    () => {
      throw new Error('storage failure');
    },
  );
  await expect(f.service.install(reviewed.id, {}, ['terms'])).rejects.toThrow(
    'storage failure',
  );
  expect(f.workspace.abilities.installations()[0].enabled).toBe(false);
  expect(await f.service.tools(f.dot.id)).toEqual([]);
});

it('serializes assignments of different versions of the same Ability to one Dot', async () => {
  const f = fixture();
  const reviewed = await f.service.reviewInstall('fixture');
  const installed = await f.service.install(reviewed.id, {}, ['terms']);
  await f.service.setMaster(installed.digest, true);
  const pkg = f.workspace.abilities.package(installed.digest)!;
  const nextManifest = { ...pkg.manifest, version: '0.1.1' };
  const next = {
    ...pkg,
    root: '/unused',
    digest: 'e'.repeat(64),
    manifest: nextManifest,
    descriptor: {
      ...pkg.descriptor,
      manifest: nextManifest,
      asset: { ...pkg.descriptor.asset, sha256: 'e'.repeat(64) },
    },
  };
  f.workspace.abilities.recordPackage(next);
  const bind = f.workspace.abilities.bind.bind(f.workspace.abilities);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(f.workspace.abilities, 'bind')
    .mockImplementationOnce((async (...args: Parameters<typeof bind>) => {
      await gate;
      return bind(...args);
    }) as unknown as typeof bind);
  const first = f.service.assign(f.dot.id, installed.digest, true);
  await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  let secondFinished = false;
  const second = f.service.assign(f.dot.id, next.digest, true).then((value) => {
    secondFinished = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    expect(secondFinished).toBe(false);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  expect(f.workspace.abilities.list(f.dot.id)[0].digest).toBe(next.digest);
});
