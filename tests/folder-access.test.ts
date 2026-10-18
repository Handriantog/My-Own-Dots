import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  link,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/server/workspace.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dots-folder-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => workspace.close());
  const dot = workspace.dots()[0];
  const thread = workspace.bindThread(randomUUID(), dot.id, 'Folder work');
  const folder = join(root, 'chosen');
  await mkdir(folder);
  await writeFile(join(folder, 'hello.txt'), 'hello');
  const folders = workspace.folders;
  return { root, folder, workspace, dot, thread, folders };
}
async function grant(
  f: Awaited<ReturnType<typeof fixture>>,
  access: 'read' | 'readwrite' = 'read',
) {
  const request = f.folders.request(f.dot.id, f.thread.id, {
    reason: 'Read this project',
    folderHint: 'Project folder',
    access,
  });
  const selected = await f.folders.select(f.thread.id, request.id, f.folder);
  const result = await f.folders.decide(f.thread.id, request.id, {
    toolCallId: randomUUID(),
    approve: true,
    selectionId: selected.id,
    access,
  });
  return { request, selected, result, id: result.grantId! };
}

it('starts with no authority and makes selection distinct from approval', async () => {
  const f = await fixture();
  expect(f.folders).toBeDefined();
  const request = f.folders.request(f.dot.id, f.thread.id, {
    reason: 'Read project',
    folderHint: 'Project',
    access: 'read',
  });
  expect(f.folders.list(f.dot.id)).toEqual([]);
  const selected = await f.folders.select(f.thread.id, request.id, f.folder);
  expect(f.folders.list(f.dot.id)).toEqual([]);
  expect(f.folders.getRequest(f.thread.id, request.id)).toMatchObject({
    request: { status: 'pending' },
    selection: selected,
  });
  const result = await f.folders.decide(f.thread.id, request.id, {
    toolCallId: 'review-1',
    approve: true,
    selectionId: selected.id,
    access: 'read',
  });
  expect(result).toMatchObject({
    approved: true,
    name: 'chosen',
    access: 'read',
  });
  expect(f.folders.list(f.dot.id)).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(f.root);
});

it('binds selection and decision replay to the original request, thread and tool call', async () => {
  const f = await fixture();
  const request = f.folders.request(f.dot.id, f.thread.id, {
    reason: 'Read',
    folderHint: '',
    access: 'read',
  });
  const other = f.folders.request(f.dot.id, f.thread.id, {
    reason: 'Other',
    folderHint: '',
    access: 'read',
  });
  const selected = await f.folders.select(f.thread.id, request.id, f.folder);
  await expect(
    f.folders.decide(f.thread.id, other.id, {
      toolCallId: 'foreign',
      approve: true,
      selectionId: selected.id,
      access: 'read',
    }),
  ).rejects.toThrow(/select/i);
  await expect(
    f.folders.decide(f.thread.id, request.id, {
      toolCallId: 'empty',
      approve: true,
    }),
  ).rejects.toThrow(/select/i);
  const input = { toolCallId: 'review', approve: false };
  const declined = await f.folders.decide(f.thread.id, request.id, input);
  expect(declined.approved).toBe(false);
  expect(await f.folders.decide(f.thread.id, request.id, input)).toEqual(
    declined,
  );
  await expect(
    f.folders.decide(f.thread.id, request.id, {
      ...input,
      toolCallId: 'another',
    }),
  ).rejects.toThrow(/decided/i);
  const otherThread = f.workspace.bindThread(randomUUID(), f.dot.id, 'Other');
  expect(() => f.folders.getRequest(otherThread.id, request.id)).toThrow(
    /not found/i,
  );
  expect(f.folders.list(f.dot.id)).toEqual([]);
});

it('expires pending selections and rejects replaced selections and changed roots', async () => {
  const f = await fixture();
  const request = f.folders.request(f.dot.id, f.thread.id, {
    reason: 'Read',
    folderHint: '',
    access: 'read',
  });
  const first = await f.folders.select(f.thread.id, request.id, f.folder);
  const second = await f.folders.select(f.thread.id, request.id, f.folder);
  await expect(
    f.folders.decide(f.thread.id, request.id, {
      toolCallId: 'old',
      approve: true,
      selectionId: first.id,
      access: 'read',
    }),
  ).rejects.toThrow(/select/i);
  await rename(f.folder, `${f.folder}-old`);
  await mkdir(f.folder);
  await expect(
    f.folders.decide(f.thread.id, request.id, {
      toolCallId: 'new',
      approve: true,
      selectionId: second.id,
      access: 'read',
    }),
  ).rejects.toThrow(/changed/i);
  vi.spyOn(Date, 'now').mockReturnValue(request.expiresAt + 1);
  await expect(
    f.folders.select(f.thread.id, request.id, f.folder),
  ).rejects.toThrow(/expired/i);
  await expect(
    f.folders.decide(f.thread.id, request.id, {
      toolCallId: 'expired',
      approve: true,
      selectionId: second.id,
      access: 'read',
    }),
  ).rejects.toThrow(/expired/i);
  expect(
    await f.folders.decide(f.thread.id, request.id, {
      toolCallId: 'decline-expired',
      approve: false,
    }),
  ).toMatchObject({ approved: false });
  vi.restoreAllMocks();
});

it('checks current Dot authority for every operation and hides root paths in tool results', async () => {
  const f = await fixture();
  const g = await grant(f);
  expect(await f.folders.readFile(f.dot.id, g.id, 'hello.txt')).toMatchObject({
    path: 'hello.txt',
    content: 'hello',
    bytes: 5,
  });
  const listing = await f.folders.listDirectory(f.dot.id, g.id, '');
  expect(listing).toMatchObject({
    entries: [{ name: 'hello.txt', type: 'file' }],
  });
  expect(JSON.stringify(listing)).not.toContain(f.root);
  const otherDot = f.workspace.createDot(
    f.dot.spaceId,
    'Other',
    '',
    false,
    false,
  );
  await expect(
    f.folders.readFile(otherDot.id, g.id, 'hello.txt'),
  ).rejects.toThrow(/permission/i);
  await expect(
    f.folders.writeFile(f.dot.id, g.id, 'hello.txt', {
      content: 'no',
      expectedHash: 'new',
    }),
  ).rejects.toThrow(/read.only/i);
  f.folders.revoke(f.dot.id, g.id);
  expect(f.folders.list(f.dot.id)).toEqual([]);
  await expect(f.folders.readFile(f.dot.id, g.id, 'hello.txt')).rejects.toThrow(
    /permission/i,
  );
  expect(
    f.folders.getRequest(f.thread.id, g.request.id).decision,
  ).toMatchObject({ approved: false });
});

it('performs bounded UTF-8 writes only with a matching hash or new-file sentinel', async () => {
  const f = await fixture();
  const g = await grant(f, 'readwrite');
  const previous = await f.folders.readFile(f.dot.id, g.id, 'hello.txt');
  await expect(
    f.folders.writeFile(f.dot.id, g.id, 'hello.txt', {
      content: 'bad',
      expectedHash: 'new',
    }),
  ).rejects.toThrow(/changed|exists/i);
  await f.folders.writeFile(f.dot.id, g.id, 'hello.txt', {
    content: 'updated',
    expectedHash: previous.hash,
  });
  await expect(
    f.folders.writeFile(f.dot.id, g.id, 'hello.txt', {
      content: 'stale',
      expectedHash: previous.hash,
    }),
  ).rejects.toThrow(/changed/i);
  await f.folders.writeFile(f.dot.id, g.id, 'new.txt', {
    content: 'created',
    expectedHash: 'new',
  });
  expect(await readFile(join(f.folder, 'hello.txt'), 'utf8')).toBe('updated');
  expect(await readFile(join(f.folder, 'new.txt'), 'utf8')).toBe('created');
  await expect(
    f.folders.writeFile(f.dot.id, g.id, 'large.txt', {
      content: 'a'.repeat(65537),
      expectedHash: 'new',
    }),
  ).rejects.toThrow(/large|limit/i);
  await writeFile(join(f.folder, 'large.txt'), 'a'.repeat(65537));
  await expect(f.folders.readFile(f.dot.id, g.id, 'large.txt')).rejects.toThrow(
    /large|limit/i,
  );
  await writeFile(join(f.folder, 'binary.txt'), Buffer.from([0xff, 0]));
  await expect(
    f.folders.readFile(f.dot.id, g.id, 'binary.txt'),
  ).rejects.toThrow(/UTF|text/i);
});

it('rejects path escape, symlinks, hardlinks, and replaced roots without touching outside files', async () => {
  const f = await fixture();
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(outside, join(f.folder, 'linked'));
  await symlink(join(outside, 'secret.txt'), join(f.folder, 'symlink.txt'));
  await link(join(outside, 'secret.txt'), join(f.folder, 'hardlink.txt'));
  const g = await grant(f, 'readwrite');
  for (const path of [
    '../outside/secret.txt',
    '/etc/passwd',
    'linked/secret.txt',
    'symlink.txt',
    'hardlink.txt',
    'a\0b',
    'a/../hello.txt',
  ]) {
    await expect(f.folders.readFile(f.dot.id, g.id, path)).rejects.toThrow();
    await expect(
      f.folders.writeFile(f.dot.id, g.id, path, {
        content: 'changed',
        expectedHash: 'new',
      }),
    ).rejects.toThrow();
  }
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
  await rename(f.folder, `${f.folder}-old`);
  await mkdir(f.folder);
  await writeFile(join(f.folder, 'hello.txt'), 'replacement');
  await expect(f.folders.readFile(f.dot.id, g.id, 'hello.txt')).rejects.toThrow(
    /changed/i,
  );
});

it('aborts operations when their grant is revoked or caller cancels', async () => {
  const f = await fixture();
  const g = await grant(f);
  const pending = f.folders.readFile(f.dot.id, g.id, 'hello.txt');
  f.folders.revoke(f.dot.id, g.id);
  await expect(pending).rejects.toThrow(/permission|cancel|revoke/i);
  const fresh = await grant(f);
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.folders.readFile(f.dot.id, fresh.id, 'hello.txt', controller.signal),
  ).rejects.toThrow(/cancel/i);
});

it('preserves grants and decisions across restart, isolates owners and does not restore revocations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dots-folder-persistence-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'chosen');
  await mkdir(folder);
  const database = join(root, 'workspace.db');
  let workspace = new WorkspaceStore(database, 'owner');
  const dot = workspace.dots()[0];
  const thread = workspace.bindThread(randomUUID(), dot.id, 'Approval');
  const request = workspace.folders.request(dot.id, thread.id, {
    reason: 'Read',
    folderHint: '',
    access: 'read',
  });
  const selection = await workspace.folders.select(
    thread.id,
    request.id,
    folder,
  );
  const input = {
    toolCallId: 'persisted-call',
    approve: true,
    selectionId: selection.id,
    access: 'read' as const,
  };
  const decision = await workspace.folders.decide(thread.id, request.id, input);
  workspace.close();
  workspace = new WorkspaceStore(database, 'other-owner');
  expect(workspace.folders.list(dot.id)).toEqual([]);
  expect(() => workspace.folders.getRequest(thread.id, request.id)).toThrow();
  workspace.close();
  workspace = new WorkspaceStore(database, 'owner');
  expect(await workspace.folders.decide(thread.id, request.id, input)).toEqual(
    decision,
  );
  expect(workspace.folders.list(dot.id)).toHaveLength(1);
  workspace.folders.revoke(dot.id, decision.grantId!);
  workspace.close();
  workspace = new WorkspaceStore(database, 'owner');
  cleanup.push(() => workspace.close());
  expect(workspace.folders.list(dot.id)).toEqual([]);
  expect(
    await workspace.folders.decide(thread.id, request.id, input),
  ).toMatchObject({ approved: false });
  await expect(
    workspace.folders.listDirectory(dot.id, decision.grantId!),
  ).rejects.toThrow(/permission/i);
});

it('serializes competing writes so only one can use a previously read hash', async () => {
  const f = await fixture();
  const g = await grant(f, 'readwrite');
  const previous = await f.folders.readFile(f.dot.id, g.id, 'hello.txt');
  const first = f.folders.writeFile(f.dot.id, g.id, 'hello.txt', {
    content: 'first',
    expectedHash: previous.hash,
  });
  const second = f.folders.writeFile(f.dot.id, g.id, 'hello.txt', {
    content: 'second',
    expectedHash: previous.hash,
  });
  expect(await Promise.allSettled([first, second])).toMatchObject([
    { status: 'fulfilled' },
    { status: 'rejected' },
  ]);
  expect(await readFile(join(f.folder, 'hello.txt'), 'utf8')).toBe('first');
});

it('serializes writes through separate grants and overlapping folder roots', async () => {
  const f = await fixture();
  const wrapper = join(f.root, 'slow-python');
  await writeFile(
    wrapper,
    `#!/usr/bin/env python3
import importlib.util,sys,time
spec=importlib.util.spec_from_file_location('folder_helper',sys.argv[-1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=m.os.replace
def delay(*args,**kwargs):
 time.sleep(.3)
 return original(*args,**kwargs)
m.os.replace=delay
m.main()
`,
    { mode: 0o700 },
  );
  vi.stubEnv('DOTS_FOLDER_PYTHON', wrapper);
  const first = await grant(f, 'readwrite');
  const second = await grant(f, 'readwrite');
  const previous = await f.folders.readFile(f.dot.id, first.id, 'hello.txt');
  const competing = await Promise.allSettled([
    f.folders.writeFile(f.dot.id, first.id, 'hello.txt', {
      content: 'first',
      expectedHash: previous.hash,
    }),
    f.folders.writeFile(f.dot.id, second.id, 'hello.txt', {
      content: 'second',
      expectedHash: previous.hash,
    }),
  ]);
  expect(competing).toMatchObject([
    { status: 'fulfilled' },
    { status: 'rejected' },
  ]);
  expect(await readFile(join(f.folder, 'hello.txt'), 'utf8')).toBe('first');

  // A grant of the ancestor must share the same destination queue.
  const ancestorRequest = f.folders.request(f.dot.id, f.thread.id, {
    reason: 'Parent',
    folderHint: '',
    access: 'readwrite',
  });
  const selection = await f.folders.select(
    f.thread.id,
    ancestorRequest.id,
    f.root,
  );
  const ancestor = await f.folders.decide(f.thread.id, ancestorRequest.id, {
    toolCallId: 'ancestor',
    approve: true,
    access: 'readwrite',
    selectionId: selection.id,
  });
  const updated = await f.folders.readFile(f.dot.id, first.id, 'hello.txt');
  expect(
    await Promise.allSettled([
      f.folders.writeFile(f.dot.id, first.id, 'hello.txt', {
        content: 'child',
        expectedHash: updated.hash,
      }),
      f.folders.writeFile(f.dot.id, ancestor.grantId!, 'chosen/hello.txt', {
        content: 'ancestor',
        expectedHash: updated.hash,
      }),
    ]),
  ).toMatchObject([{ status: 'fulfilled' }, { status: 'rejected' }]);
  expect(await readFile(join(f.folder, 'hello.txt'), 'utf8')).toBe('child');
});

it('rejects queued writes after revocation and closes pending selection helpers', async () => {
  const f = await fixture();
  const g = await grant(f, 'readwrite');
  const pendingWrite = f.folders.writeFile(f.dot.id, g.id, 'new.txt', {
    content: 'unauthorized',
    expectedHash: 'new',
  });
  f.folders.revoke(f.dot.id, g.id);
  await expect(pendingWrite).rejects.toThrow(/permission/i);
  await expect(readFile(join(f.folder, 'new.txt'))).rejects.toThrow();
  const request = f.folders.request(f.dot.id, f.thread.id, {
    reason: 'Read',
    folderHint: '',
    access: 'read',
  });
  const pendingSelection = f.folders.select(f.thread.id, request.id, f.folder);
  f.folders.close();
  await expect(pendingSelection).rejects.toThrow(/cancel|closed/i);
});

it('denies request creation for another Dot conversation and enforces bounded request details', async () => {
  const f = await fixture();
  const other = f.workspace.createDot(f.dot.spaceId, 'Other', '', false, false);
  const input = { reason: 'Read', folderHint: '', access: 'read' as const };
  expect(() => f.folders.request(other.id, f.thread.id, input)).toThrow();
  expect(() => f.folders.request('missing', f.thread.id, input)).toThrow(
    /not found/i,
  );
  expect(() =>
    f.folders.request(f.dot.id, f.thread.id, {
      ...input,
      reason: 'x'.repeat(1001),
    }),
  ).toThrow();
  expect(() =>
    f.folders.request(f.dot.id, f.thread.id, {
      ...input,
      folderHint: 'x'.repeat(201),
    }),
  ).toThrow();
  expect(() =>
    f.folders.request(f.dot.id, f.thread.id, { ...input, reason: '' }),
  ).toThrow();
});
