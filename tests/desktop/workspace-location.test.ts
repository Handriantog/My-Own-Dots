import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  resolveWorkspaceLocation,
  readPortableLayout,
  portableConfiguration,
} from '../../src/desktop/host/workspace-location.js';
import {
  createWorkspaceManifest,
  readWorkspaceManifest,
} from '../../src/shared/workspace-manifest.js';
import {
  configurePortableProfile,
  readSelection,
  writeSelection,
} from '../../src/server/storage/restore-journal.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const base = {
  home: '/home/user',
  electronData: '/profile',
  executable: '/app/Dots',
};
it('uses stable per-user directories on macOS, Windows and Linux', () => {
  expect(
    resolveWorkspaceLocation({
      ...base,
      platform: 'darwin',
      electronData: '/Users/u/Library/Application Support/My Own Dots Desktop',
    }).workspace,
  ).toBe('/Users/u/Library/Application Support/My Own Dots Desktop/workspace');
  expect(
    resolveWorkspaceLocation({
      ...base,
      platform: 'win32',
      home: 'C:\\Users\\u',
      electronData: 'C:\\Users\\u\\AppData\\Roaming\\Dots',
      localAppData: 'C:\\Users\\u\\AppData\\Local',
      executable: 'C:\\Program Files\\Dots\\Dot.exe',
    }).workspace,
  ).toBe('C:\\Users\\u\\AppData\\Local\\My Own Dots\\workspace');
  expect(
    resolveWorkspaceLocation({
      ...base,
      platform: 'linux',
      xdgDataHome: '/data',
    }).workspace,
  ).toBe('/data/my-own-dots/workspace');
  expect(
    resolveWorkspaceLocation({ ...base, platform: 'linux' }).workspace,
  ).toBe('/home/user/.local/share/my-own-dots/workspace');
});
it('places portable data outside bundles and honors an explicit workspace selection', () => {
  const portable = resolveWorkspaceLocation({
    ...base,
    platform: 'darwin',
    portableRoot: '/portable/Dots',
    executable: '/portable/Dots/My Own Dots.app/Contents/MacOS/Dots',
  });
  expect(portable).toEqual({
    workspace: '/portable/Dots/workspace',
    profile: '/portable/Dots/desktop-profile',
    portable: true,
  });
  expect(
    resolveWorkspaceLocation({
      ...base,
      platform: 'linux',
      portableRoot: '/portable',
      selected: '/selected',
    }).workspace,
  ).toBe('/selected');
  expect(() =>
    resolveWorkspaceLocation({
      ...base,
      platform: 'darwin',
      portableRoot: '/portable/Dots.app/Contents',
      executable: '/portable/Dots.app/Contents/MacOS/Dots',
    }),
  ).toThrow(/bundle|portable/i);
  expect(() =>
    resolveWorkspaceLocation({
      ...base,
      platform: 'linux',
      portableRoot: '/tmp/.mount_Dots123',
      executable: '/tmp/.mount_Dots123/AppRun',
    }),
  ).toThrow(/mount|portable/i);
});
it('rejects escaping portable marker paths and retains identity when the whole root moves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dot-portable-'));
  roots.push(root, root + '-moved');
  await mkdir(join(root, 'workspace'));
  const manifest = {
    version: 1 as const,
    id: randomUUID(),
    ownerId: 'owner',
    storage: 'legacy-postgres' as const,
    schema: 1,
  };
  await createWorkspaceManifest(join(root, 'workspace'), manifest);
  for (const workspace of [
    '../outside',
    '/absolute',
    'C:\\outside',
    'a/../../b',
    'desktop-profile/child',
    'DESKTOP-PROFILE/child',
  ]) {
    await writeFile(
      join(root, 'portable.json'),
      JSON.stringify({ version: 1, workspace, profile: 'desktop-profile' }),
    );
    await expect(readPortableLayout(root)).rejects.toThrow();
  }
  await writeFile(
    join(root, 'portable.json'),
    JSON.stringify({
      version: 1,
      workspace: 'workspace',
      profile: 'desktop-profile',
    }),
  );
  expect(await readPortableLayout(root)).toEqual({
    version: 1,
    workspace: 'workspace',
    profile: 'desktop-profile',
  });
  await rename(root, root + '-moved');
  expect(
    await readWorkspaceManifest(join(root + '-moved', 'workspace')),
  ).toEqual(manifest);
  await expect(
    createWorkspaceManifest(join(root + '-moved', 'workspace'), {
      ...manifest,
      id: randomUUID(),
    }),
  ).rejects.toThrow();
  expect(
    JSON.parse(
      await readFile(join(root + '-moved', 'workspace/workspace.json'), 'utf8'),
    ),
  ).toEqual(manifest);
});
it('reading absent or invalid manifests never creates a workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dot-manifest-'));
  roots.push(root);
  expect(await readWorkspaceManifest(join(root, 'missing'))).toBeUndefined();
  await writeFile(
    join(root, 'workspace.json'),
    JSON.stringify({ version: 99 }),
  );
  await expect(readWorkspaceManifest(root)).rejects.toThrow(
    /manifest|version|invalid/i,
  );
});
it('finds portable roots beside applications and never derives them from cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dots-portable-launch-'));
  roots.push(root);
  const executable = join(root, 'Dots.app/Contents/MacOS/Dots');
  expect(
    portableConfiguration({ platform: 'darwin', executable }),
  ).toBeUndefined();
  await writeFile(
    join(root, 'portable.json'),
    JSON.stringify({
      version: 1,
      workspace: 'workspace',
      profile: 'desktop-profile',
    }),
  );
  expect(
    portableConfiguration({ platform: 'darwin', executable }),
  ).toMatchObject({ root, paths: { workspace: 'workspace' } });
  expect(
    portableConfiguration({
      platform: 'linux',
      executable: '/tmp/.mount_test/Dots',
      appImage: join(root, 'Dots.AppImage'),
    }),
  ).toMatchObject({ root });
  expect(() =>
    portableConfiguration({
      platform: 'linux',
      executable: '/app/Dots',
      root: 'relative',
    }),
  ).toThrow(/absolute/);
});
it('keeps a selected portable workspace relative to the profile after moving the whole folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dots-portable-selection-'));
  roots.push(root, root + '-moved');
  const profile = join(root, 'desktop-profile'),
    workspace = join(root, 'chosen');
  await mkdir(profile);
  await mkdir(workspace);
  const manifest = {
    version: 1 as const,
    id: randomUUID(),
    ownerId: 'owner',
    storage: 'sqlite' as const,
    schema: 2,
  };
  await createWorkspaceManifest(workspace, manifest);
  await configurePortableProfile(profile, root);
  await writeSelection(profile, workspace);
  expect(
    JSON.parse(
      await readFile(join(profile, 'workspace-location.json'), 'utf8'),
    ),
  ).toMatchObject({
    version: 2,
    relativeToProfile: '../chosen',
    workspaceId: manifest.id,
  });
  await rename(root, root + '-moved');
  expect(
    JSON.parse((await readSelection(join(root + '-moved', 'desktop-profile')))!)
      .directory,
  ).toBe(join(root + '-moved', 'chosen'));
  await rename(
    join(root + '-moved', 'chosen'),
    join(root + '-moved', 'unplugged'),
  );
  await expect(
    readSelection(join(root + '-moved', 'desktop-profile')),
  ).rejects.toThrow(/missing|identity/i);
});
