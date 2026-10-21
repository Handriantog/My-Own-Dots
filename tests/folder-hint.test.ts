import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: run }));
import {
  folderHintCandidate,
  searchFolderNames,
} from '../src/server/folder-hint.js';

afterEach(() => vi.resetAllMocks());

it('searches folder metadata with a literal escaped name and bounded shell-free execution', async () => {
  const name = 'Work " || kMDItemFSName == "*?\\ $(touch owned)';
  run.mockImplementation((_file, _args, _options, callback) =>
    callback(null, `/fixture/${name}\0`, ''),
  );
  expect(await searchFolderNames(name, '/fixture')).toEqual([
    `/fixture/${name}`,
  ]);
  expect(run).toHaveBeenCalledWith(
    '/usr/bin/mdfind',
    [
      '-0',
      '-onlyin',
      '/fixture',
      'kMDItemContentType == "public.folder" && kMDItemFSName == "Work \\" || kMDItemFSName == \\"\\*\\?\\\\ $(touch owned)"c',
    ],
    expect.objectContaining({
      timeout: 1500,
      maxBuffer: 65536,
      encoding: 'utf8',
      shell: false,
    }),
    expect.any(Function),
  );
});

it('marks metadata search incomplete when it fails or exceeds its bound', async () => {
  run.mockImplementation((_file, _args, _options, callback) =>
    callback(new Error('unavailable'), '', ''),
  );
  expect(await searchFolderNames('Project', '/fixture')).toBeUndefined();
  run.mockImplementation((_file, _args, _options, callback) =>
    callback(
      null,
      Array.from({ length: 21 }, (_, i) => `/fixture/${i}/Project\0`).join(''),
      '',
    ),
  );
  expect(await searchFolderNames('Project', '/fixture')).toBeUndefined();
});

it('cannot treat a home child as unique after metadata failure or truncation', async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), 'dots-folder-name-limit-')),
  );
  try {
    const paths = [
      join(home, 'Project'),
      ...Array.from({ length: 20 }, (_, index) =>
        join(home, `parent-${index}`, 'Project'),
      ),
    ];
    await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
    run.mockImplementation((_file, _args, _options, callback) =>
      callback(null, paths.join('\0') + '\0', ''),
    );
    expect(
      await folderHintCandidate(
        'Project',
        { homeDirectory: home },
        new AbortController().signal,
      ),
    ).toBeUndefined();
    run.mockImplementation((_file, _args, _options, callback) =>
      callback(new Error('Index unavailable'), '', ''),
    );
    expect(
      await folderHintCandidate(
        'Project',
        { homeDirectory: home },
        new AbortController().signal,
      ),
    ).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('searches case and separator variants so spoken names can find actual indexed directory names', async () => {
  run.mockImplementation((_file, _args, _options, callback) =>
    callback(null, '/fixture/MyOwnStack\0', ''),
  );
  expect(await searchFolderNames('my own stack', '/fixture')).toEqual([
    '/fixture/MyOwnStack',
  ]);
  expect(run.mock.calls[0][1]).toEqual([
    '-0',
    '-onlyin',
    '/fixture',
    'kMDItemContentType == "public.folder" && kMDItemFSName == "m*y*o*w*n*s*t*a*c*k"c',
  ]);
});
