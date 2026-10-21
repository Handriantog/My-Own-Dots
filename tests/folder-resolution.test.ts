import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FolderAccessService } from '../src/server/folder-access.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  search = async (_name: string, _home: string) => [] as string[],
) {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), 'dots-folder-resolve-')),
  );
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const db = new DatabaseSync(':memory:');
  const folders = new FolderAccessService(
    db,
    'owner',
    {
      requireDot(id) {
        if (id !== 'dot') throw new Error('Wrong Dot');
      },
      requireThread(id, dotId) {
        if (id !== 'thread' || (dotId && dotId !== 'dot'))
          throw new Error('Wrong thread');
        return { id, dotId: 'dot' };
      },
    },
    { homeDirectory: home, search },
  );
  cleanup.push(() => {
    folders.close();
    db.close();
  });
  const request = (folderHint: string) =>
    folders.request('dot', 'thread', {
      folderHint,
      reason: 'Read the named folder',
      access: 'read',
    });
  return { home, db, folders, request };
}

it('preselects exact, tilde, known-home and clear home-relative paths without granting access', async () => {
  const f = await fixture();
  await mkdir(join(f.home, 'Desktop'));
  await mkdir(join(f.home, 'Projects', 'Named'), { recursive: true });
  for (const [hint, path] of [
    [join(f.home, 'Projects', 'Named'), join(f.home, 'Projects', 'Named')],
    ['~/Projects/Named', join(f.home, 'Projects', 'Named')],
    ['desktop', join(f.home, 'Desktop')],
    ['Projects/Named', join(f.home, 'Projects', 'Named')],
  ]) {
    const request = f.request(hint);
    expect(f.folders.getRequest('thread', request.id)).not.toHaveProperty(
      'selection',
    );
    const detail = await f.folders.resolve('thread', request.id);
    expect(detail).toMatchObject({
      request: { status: 'pending' },
      selection: { path },
    });
    expect(detail.selection).not.toHaveProperty('identity');
    expect(f.folders.list('dot')).toEqual([]);
    expect(await f.folders.resolve('thread', request.id)).toEqual(detail);
  }
});

it('resolves the actual spoken user-folder request when Spotlight is unavailable', async () => {
  const f = await fixture(async () => {
    throw new Error('Spotlight unavailable');
  });
  const target = join(f.home, 'MyOwnStack');
  await mkdir(target);
  const request = f.request('my user folder slash my own stack');
  const detail = await f.folders.resolve('thread', request.id);
  expect(detail).toMatchObject({
    request: {
      status: 'pending',
      folderHint: 'my user folder slash my own stack',
    },
    selection: { path: target, name: 'MyOwnStack' },
  });
  expect(f.folders.list('dot')).toEqual([]);
});

it('looks up real child names for spoken separators, home aliases and nested named paths', async () => {
  const f = await fixture();
  const target = join(f.home, 'MyOwnStack', 'My-Own-Dots');
  await mkdir(target, { recursive: true });
  for (const hint of [
    'user folder/my-own-stack folder/my own dots',
    'my home directory forward slash MY OWN STACK slash my own dots',
    '~/my-own-stack/my_own_dots',
    'My own stack / My own dots',
  ]) {
    expect(
      (await f.folders.resolve('thread', f.request(hint).id)).selection?.path,
    ).toBe(target);
  }
  expect(
    (await f.folders.resolve('thread', f.request('my own stack').id)).selection
      ?.path,
  ).toBe(join(f.home, 'MyOwnStack'));
  expect(f.folders.list('dot')).toEqual([]);
});

it.each(['my-own-stack', 'MY_OWN_STACK', 'MY OWN STACK'])(
  'retains the chooser when normalized child names collide with %s',
  async (variant) => {
    const f = await fixture();
    await mkdir(join(f.home, 'MyOwnStack'));
    await mkdir(join(f.home, variant));
    for (const hint of [
      'my user folder slash my own stack',
      '~/MyOwnStack',
      'my own stack',
    ]) {
      expect(
        await f.folders.resolve('thread', f.request(hint).id),
      ).not.toHaveProperty('selection');
    }
    // An explicit absolute path is already an exact owner choice and is not normalized.
    expect(
      (
        await f.folders.resolve(
          'thread',
          f.request(join(f.home, 'MyOwnStack')).id,
        )
      ).selection?.path,
    ).toBe(join(f.home, 'MyOwnStack'));
  },
);

it('does not follow symlink directories, traversal phrases or broad home requests', async () => {
  const f = await fixture();
  await mkdir(join(f.home, 'Actual'));
  await mkdir(join(f.home, 'YourProjectFolder'));
  await symlink(join(f.home, 'Actual'), join(f.home, 'MyOwnStack'));
  await symlink(join(f.home, 'Actual'), join(f.home, 'Desktop'));
  for (const hint of [
    'my user folder slash my own stack',
    '~/MyOwnStack',
    'my user folder slash dot dot slash Actual',
    'my user folder/../Actual',
    'my home folder',
    'user folder',
    'my user folder slash',
    'desktop',
    'my user folder slash your project folder',
  ]) {
    expect(
      await f.folders.resolve('thread', f.request(hint).id),
    ).not.toHaveProperty('selection');
  }
});

it('never chooses a partial match when directory enumeration reaches its deadline', async () => {
  const f = await fixture();
  await mkdir(join(f.home, 'MyOwnStack'));
  for (let index = 0; index < 10; index++)
    await mkdir(join(f.home, `other-${index}`));
  const request = f.request('my user folder slash my own stack');
  let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => {
    clock += 600;
    return clock;
  });
  expect(await f.folders.resolve('thread', request.id)).not.toHaveProperty(
    'selection',
  );
});

it('does not recursively search directories or choose from a truncated parent listing', async () => {
  const f = await fixture();
  await mkdir(join(f.home, 'Unmentioned', 'MyOwnStack'), { recursive: true });
  expect(
    await f.folders.resolve(
      'thread',
      f.request('my user folder slash my own stack').id,
    ),
  ).not.toHaveProperty('selection');
  await Promise.all(
    Array.from({ length: 513 }, (_, index) =>
      mkdir(join(f.home, `entry-${index}`)),
    ),
  );
  await mkdir(join(f.home, 'MyOwnStack'));
  expect(
    await f.folders.resolve(
      'thread',
      f.request('my user folder slash my own stack').id,
    ),
  ).not.toHaveProperty('selection');
});

it('combines normalized metadata matches with home children and rejects conflicting matches', async () => {
  let results: string[] = [];
  const f = await fixture(async () => results);
  const nested = join(f.home, 'Projects', 'MyOwnStack');
  await mkdir(nested, { recursive: true });
  results = [nested];
  expect(
    (await f.folders.resolve('thread', f.request('my own stack').id)).selection
      ?.path,
  ).toBe(nested);
  await mkdir(join(f.home, 'my-own-stack'));
  expect(
    await f.folders.resolve('thread', f.request('my own stack').id),
  ).not.toHaveProperty('selection');
});

it('uses an unambiguous exact folder name and persists the inspected selection for approval', async () => {
  let candidate = '';
  const f = await fixture(async (name, home) =>
    name === 'Work Notes' && home === f.home ? [candidate] : [],
  );
  candidate = join(f.home, 'Projects', 'Work Notes');
  await mkdir(candidate, { recursive: true });
  const request = f.request('folder named Work Notes');
  const detail = await f.folders.resolve('thread', request.id);
  expect(detail.selection?.path).toBe(candidate);
  const decision = await f.folders.decide('thread', request.id, {
    toolCallId: 'review',
    approve: true,
    selectionId: detail.selection!.id,
    access: 'read',
  });
  expect(decision.approved).toBe(true);
  expect(JSON.stringify(decision)).not.toContain(f.home);
  expect(f.folders.list('dot')).toHaveLength(1);
});

it('keeps the chooser for ambiguous, missing, unavailable or non-directory candidates', async () => {
  let results: string[] = [];
  let unavailable = false;
  const f = await fixture(async () => {
    if (unavailable) throw new Error('Spotlight disabled');
    return results;
  });
  const one = join(f.home, 'one', 'Project');
  const two = join(f.home, 'two', 'Project');
  await mkdir(one, { recursive: true });
  await mkdir(two, { recursive: true });
  results = [one, two];
  const ambiguous = f.request('Project');
  expect(await f.folders.resolve('thread', ambiguous.id)).not.toHaveProperty(
    'selection',
  );
  results = [];
  expect(
    await f.folders.resolve('thread', f.request('Missing').id),
  ).not.toHaveProperty('selection');
  unavailable = true;
  expect(
    await f.folders.resolve('thread', f.request('Project').id),
  ).not.toHaveProperty('selection');
  expect(
    await f.folders.resolve('thread', f.request(join(f.home, 'missing')).id),
  ).not.toHaveProperty('selection');
  const file = join(f.home, 'plain-file');
  await writeFile(file, 'never read this content');
  expect(
    await f.folders.resolve('thread', f.request(file).id),
  ).not.toHaveProperty('selection');
});

it('rejects broad hints, traversal and out-of-home or inexact metadata results', async () => {
  const f = await fixture(async () => [f.home]);
  for (const hint of [
    'your project folder',
    '',
    'home',
    '..',
    '../elsewhere',
    '~/../elsewhere',
    'Projects/../../elsewhere',
    'Project',
  ]) {
    expect(
      await f.folders.resolve('thread', f.request(hint).id),
    ).not.toHaveProperty('selection');
  }
});

it('lets an existing or concurrently chosen folder win and deduplicates concurrent resolution', async () => {
  let complete!: (paths: string[]) => void;
  const search = vi.fn(
    () =>
      new Promise<string[]>((resolve) => {
        complete = resolve;
      }),
  );
  const f = await fixture(search);
  const candidate = join(f.home, 'Project');
  const manual = join(f.home, 'Manual');
  await mkdir(candidate);
  await mkdir(manual);
  const request = f.request('Project');
  const pending = f.folders.resolve('thread', request.id);
  const concurrent = f.folders.resolve('thread', request.id);
  const selection = await f.folders.select('thread', request.id, manual);
  complete([candidate]);
  expect(await pending).toMatchObject({ selection });
  expect(await concurrent).toMatchObject({ selection });
  expect(search).toHaveBeenCalledTimes(1);
  expect(await f.folders.resolve('thread', request.id)).toMatchObject({
    selection,
  });
});

it('never overwrites a concurrent decline or revives a saved decision after revocation', async () => {
  let complete!: (paths: string[]) => void;
  const f = await fixture(
    () =>
      new Promise<string[]>((resolve) => {
        complete = resolve;
      }),
  );
  const candidate = join(f.home, 'Project');
  await mkdir(candidate);
  const request = f.request('Project');
  const pending = f.folders.resolve('thread', request.id);
  await f.folders.decide('thread', request.id, {
    toolCallId: 'review',
    approve: false,
  });
  complete([candidate]);
  expect(await pending).toMatchObject({
    request: { status: 'declined' },
    decision: { approved: false },
  });
  expect(f.folders.getRequest('thread', request.id)).not.toHaveProperty(
    'selection',
  );
  const approvedRequest = f.request(candidate);
  const selection = await f.folders.select(
    'thread',
    approvedRequest.id,
    candidate,
  );
  const decision = await f.folders.decide('thread', approvedRequest.id, {
    toolCallId: 'approve',
    approve: true,
    selectionId: selection.id,
    access: 'read',
  });
  f.folders.revoke('dot', decision.grantId!);
  expect(await f.folders.resolve('thread', approvedRequest.id)).toMatchObject({
    selection,
    decision: { approved: false },
    grant: { revokedAt: expect.any(Number) },
  });
  expect(f.folders.list('dot')).toEqual([]);
});

it('does not resolve expired requests, including expiry during lookup, and enforces conversation scope', async () => {
  let complete!: (paths: string[]) => void;
  const f = await fixture(
    () =>
      new Promise<string[]>((resolve) => {
        complete = resolve;
      }),
  );
  const candidate = join(f.home, 'Project');
  await mkdir(candidate);
  const request = f.request('Project');
  const pending = f.folders.resolve('thread', request.id);
  vi.spyOn(Date, 'now').mockReturnValue(request.expiresAt + 1);
  complete([candidate]);
  expect(await pending).not.toHaveProperty('selection');
  expect(await f.folders.resolve('thread', request.id)).not.toHaveProperty(
    'selection',
  );
  await expect(f.folders.resolve('other-thread', request.id)).rejects.toThrow(
    /conversation/,
  );
});
