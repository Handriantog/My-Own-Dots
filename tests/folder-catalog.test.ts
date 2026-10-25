import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { folderTools } from '../src/server/folder-tools.js';
import { folderPython } from '../src/server/folder-python.js';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function fixture(mode: 'local' | 'worker') {
  const root = await mkdtemp(join(tmpdir(), 'dots-folder-catalog-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const database = join(root, 'test.sqlite');
  const client =
    mode === 'worker'
      ? await StorageClient.open({ database, ownerId: 'catalog-owner' })
      : undefined;
  const workspace =
    client?.repositories.workspace ??
    new WorkspaceStore(database, 'catalog-owner');
  cleanup.push(() =>
    client ? client.close() : (workspace as WorkspaceStore).close(),
  );
  const dot = (await workspace.dots())[0];
  const thread = await workspace.bindThread(
    randomUUID(),
    dot.id,
    'Read project',
  );
  const folder = join(root, 'MyOwnStack');
  await mkdir(join(folder, 'My-Own-Dots'), { recursive: true });
  await writeFile(
    join(folder, 'My-Own-Dots', 'README.md'),
    'The actual project',
  );
  const controller = new AbortController();
  const tools = folderTools(
    workspace.folders,
    dot.id,
    thread.id,
    () => {},
    controller.signal,
  );
  const execute = (name: string, args: unknown = {}) =>
    tools.find((tool) => tool.name === name)!.execute!(args as never);
  const approve = async (access: 'read' | 'readwrite' | 'execute' = 'read') => {
    const request = await workspace.folders.request(dot.id, thread.id, {
      reason: 'Read the approved project',
      folderHint: folder,
      access,
    });
    const selection = await workspace.folders.select(
      thread.id,
      request.id,
      folder,
    );
    const decision = await workspace.folders.decide(thread.id, request.id, {
      toolCallId: randomUUID(),
      approve: true,
      selectionId: selection.id,
      access,
    });
    return decision.grantId!;
  };
  return {
    root,
    database,
    workspace,
    dot,
    folder,
    approve,
    execute,
    controller,
  };
}

it.each(['local', 'worker'] as const)(
  'lists the usable approved parent after a stored device identity changes (%s)',
  async (mode) => {
    const f = await fixture(mode);
    const staleRead = await f.approve('read');
    const staleWrite = await f.approve('readwrite');
    const db = new DatabaseSync(f.database);
    try {
      for (const id of [staleRead, staleWrite]) {
        const row = db
          .prepare('SELECT value FROM folder_grants WHERE id=?')
          .get(id)!;
        const grant = JSON.parse(String(row.value));
        // Same inode and path, different device: the observed owner failure.
        grant.identity.dev = String(BigInt(grant.identity.dev) + 1n);
        db.prepare('UPDATE folder_grants SET value=? WHERE id=?').run(
          JSON.stringify(grant),
          id,
        );
      }
      const currentRead = await f.approve('read');
      const currentWrite = await f.approve('readwrite');
      const before = db
        .prepare('SELECT value FROM folder_grants ORDER BY rowid')
        .all();
      const catalog = await f.execute('list_local_folders');
      expect(catalog).toEqual([
        { id: currentRead, name: 'MyOwnStack', access: 'read' },
        { id: currentWrite, name: 'MyOwnStack', access: 'readwrite' },
      ]);
      expect(JSON.stringify(catalog)).not.toContain(f.root);
      expect(
        await f.execute('list_local_folder', {
          grantId: currentRead,
          path: '.',
        }),
      ).toMatchObject({
        entries: [{ name: 'My-Own-Dots', type: 'directory' }],
      });
      expect(
        await f.execute('read_local_file', {
          grantId: currentRead,
          path: 'My-Own-Dots/README.md',
        }),
      ).toMatchObject({ content: 'The actual project' });
      await expect(
        f.execute('read_local_file', {
          grantId: staleRead,
          path: 'My-Own-Dots/README.md',
        }),
      ).rejects.toThrow(/changed/);
      expect(await f.workspace.folders.list(f.dot.id)).toHaveLength(4);
      expect(
        db.prepare('SELECT value FROM folder_grants ORDER BY rowid').all(),
      ).toEqual(before);
    } finally {
      db.close();
    }
  },
);

it.each(['local', 'worker'] as const)(
  'collapses duplicate approvals only within the same access level (%s)',
  async (mode) => {
    const f = await fixture(mode);
    const older = await f.approve('read');
    const current = await f.approve('read');
    const writable = await f.approve('readwrite');
    const executable = await f.approve('execute');
    expect(await f.execute('list_local_folders')).toEqual([
      { id: current, name: 'MyOwnStack', access: 'read' },
      { id: writable, name: 'MyOwnStack', access: 'readwrite' },
      { id: executable, name: 'MyOwnStack', access: 'execute' },
    ]);
    await f.workspace.folders.revoke(f.dot.id, current);
    expect(await f.execute('list_local_folders')).toEqual([
      { id: older, name: 'MyOwnStack', access: 'read' },
      { id: writable, name: 'MyOwnStack', access: 'readwrite' },
      { id: executable, name: 'MyOwnStack', access: 'execute' },
    ]);
  },
);

it.each(['local', 'worker'] as const)(
  'excludes missing, replaced and symlink-swapped roots without renewing authority (%s)',
  async (mode) => {
    const f = await fixture(mode);
    const approved = await f.approve();
    const moved = join(f.root, 'moved');
    await rename(f.folder, moved);
    expect(await f.execute('list_local_folders')).toEqual([]);
    await mkdir(f.folder);
    expect(await f.execute('list_local_folders')).toEqual([]);
    await rm(f.folder, { recursive: true });
    await symlink(moved, f.folder);
    expect(await f.execute('list_local_folders')).toEqual([]);
    expect(await f.workspace.folders.list(f.dot.id)).toEqual([
      expect.objectContaining({ id: approved }),
    ]);
    await f.workspace.folders.revoke(f.dot.id, approved);
    expect(await f.workspace.folders.list(f.dot.id)).toEqual([]);
  },
);

it.each(['local', 'worker'] as const)(
  'rechecks revocation while the catalog verifies roots (%s)',
  async (mode) => {
    const f = await fixture(mode);
    const approved = await f.approve();
    const pending = f.workspace.folders.available(f.dot.id);
    await f.workspace.folders.revoke(f.dot.id, approved);
    expect(await pending).toEqual([]);
  },
);

it('reports runtime failure instead of implying that existing grants are absent', async () => {
  const f = await fixture('local');
  await f.approve();
  vi.stubEnv('DOTS_FOLDER_PYTHON', join(f.root, 'missing-python'));
  await expect(f.execute('list_local_folders')).rejects.toMatchObject({
    status: 503,
  });
  expect(await f.workspace.folders.list(f.dot.id)).toHaveLength(1);
});

it('does not hide an invalid helper request as an unavailable grant', async () => {
  const f = await fixture('local');
  await f.approve();
  const wrapper = join(f.root, 'invalid-request-python');
  await writeFile(
    wrapper,
    `#!${folderPython()}\nimport json,sys\nsys.stdin.read()\nprint(json.dumps({"ok":False,"error":"Invalid folder request.","exceptionType":"ValueError"}))\n`,
    { mode: 0o700 },
  );
  vi.stubEnv('DOTS_FOLDER_PYTHON', wrapper);
  await expect(f.execute('list_local_folders')).rejects.toThrow(
    'Invalid folder request.',
  );
});

it.each(['local', 'worker'] as const)(
  'rejects malformed verification and helper infrastructure failures (%s)',
  async (mode) => {
    const f = await fixture('local');
    await f.approve();
    const python = folderPython();
    for (const response of [
      { ok: true, result: null },
      {
        ok: false,
        code: 'helper_failure',
        exceptionType: 'FileNotFoundError',
        error: 'Folder helper failed.',
      },
    ]) {
      const wrapper = join(f.root, 'broken-python');
      await writeFile(
        wrapper,
        `#!${python}\nimport sys\nsys.stdin.read()\nprint(${JSON.stringify(JSON.stringify(response))})\n`,
        { mode: 0o700 },
      );
      vi.stubEnv('DOTS_FOLDER_PYTHON', wrapper);
      const client =
        mode === 'worker'
          ? await StorageClient.open({
              database: f.database,
              ownerId: 'catalog-owner',
            })
          : undefined;
      try {
        await expect(
          (client?.repositories.workspace ?? f.workspace).folders.available(
            f.dot.id,
          ),
        ).rejects.toMatchObject({ status: 503 });
      } finally {
        await client?.close();
      }
    }
  },
);

it('checks cancellation again before returning a verified catalog', async () => {
  const f = await fixture('local');
  await f.approve();
  const pending = f.execute('list_local_folders');
  f.controller.abort();
  await expect(pending).rejects.toThrow();
});
