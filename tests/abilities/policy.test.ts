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
function fixture() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanups.push(() => workspace.close());
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Fixture');
  const manifest = parseManifest({
    ...fixtureManifest,
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
