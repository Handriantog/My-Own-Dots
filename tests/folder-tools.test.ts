import { expect, it, vi } from 'vitest';
import { folderTools } from '../src/server/folder-tools';
import type { FolderAccessService } from '../src/server/folder-access';

function fixture() {
  const service = {
    request: vi.fn(() => ({ id: 'request-id' })),
    list: vi.fn(() => [
      {
        id: 'grant-id',
        name: 'Work',
        path: '/private/owner/Work',
        access: 'read',
      },
    ]),
    listDirectory: vi.fn(async () => ({ entries: [] })),
    readFile: vi.fn(async () => ({
      path: 'notes.txt',
      content: 'Notes',
      hash: 'abc',
    })),
    writeFile: vi.fn(async () => ({ path: 'notes.txt', hash: 'def' })),
  };
  const controller = new AbortController();
  const check = vi.fn();
  const tools = folderTools(
    service as unknown as FolderAccessService,
    'dot',
    'thread',
    check,
    controller.signal,
  );
  const execute = (name: string, args: unknown) =>
    tools.find((tool) => tool.name === name)!.execute!(args as never);
  return { service, controller, check, tools, execute };
}

it('offers requests and scoped file tools but no way for the model to approve or choose a folder', async () => {
  const f = fixture();
  expect(f.tools.map((tool) => tool.name)).toEqual([
    'request_local_folder_access',
    'list_local_folders',
    'list_local_folder',
    'read_local_file',
    'write_local_file',
  ]);
  expect(
    await f.execute('request_local_folder_access', {
      reason: 'Read work notes',
      folderHint: 'Work',
      access: 'read',
    }),
  ).toMatchObject({
    status: 'approval_required',
    requestId: 'request-id',
    instruction: expect.stringContaining('review_local_folder_access'),
  });
  expect(f.service.request).toHaveBeenCalledWith('dot', 'thread', {
    reason: 'Read work notes',
    folderHint: 'Work',
    access: 'read',
  });
  const grants = await f.execute('list_local_folders', {});
  expect(JSON.stringify(grants)).not.toContain('/private/');
  expect(grants).toEqual([{ id: 'grant-id', name: 'Work', access: 'read' }]);
});

it('binds file operations to the selected Dot and checks cancellation before returning file content', async () => {
  const f = fixture();
  await f.execute('read_local_file', { grantId: 'grant', path: 'notes.txt' });
  expect(f.service.readFile).toHaveBeenCalledWith(
    'dot',
    'grant',
    'notes.txt',
    f.controller.signal,
  );
  f.service.readFile.mockImplementationOnce(async () => {
    f.controller.abort();
    return { path: 'notes.txt', content: 'private', hash: 'abc' };
  });
  await expect(
    f.execute('read_local_file', { grantId: 'grant', path: 'notes.txt' }),
  ).rejects.toThrow();
  await expect(f.execute('list_local_folders', {})).rejects.toThrow();
});

it('passes a content hash for edits and never supplies absolute host paths or another Dot identity', async () => {
  const f = fixture();
  await f.execute('write_local_file', {
    grantId: 'grant',
    path: 'notes.txt',
    content: 'Updated',
    expectedHash: 'abc',
  });
  expect(f.service.writeFile).toHaveBeenCalledWith(
    'dot',
    'grant',
    'notes.txt',
    { content: 'Updated', expectedHash: 'abc' },
    f.controller.signal,
  );
  await f.execute('list_local_folder', { grantId: 'grant', path: '.' });
  expect(f.service.listDirectory).toHaveBeenCalledWith(
    'dot',
    'grant',
    '.',
    f.controller.signal,
  );
});
