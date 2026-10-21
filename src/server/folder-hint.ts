import { execFile } from 'node:child_process';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export type FolderNameSearch = (
  name: string,
  home: string,
  signal?: AbortSignal,
) => Promise<string[] | undefined>;
export type FolderResolutionOptions = {
  homeDirectory?: string;
  search?: FolderNameSearch;
};
const maximumCandidates = 20;
const maximumDirectoryEntries = 512;
const maximumPathComponents = 8;
const homeFolders = [
  'Desktop',
  'Documents',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  'Public',
  'Applications',
];

/** Only metadata is queried. Errors/oversized results deliberately retain the chooser. */
export const searchFolderNames: FolderNameSearch = (name, home, signal) => {
  if (signal?.aborted) return Promise.resolve(undefined);
  const literal = name.replace(/[\\"*?]/g, '\\$&');
  // Spotlight has no separator-insensitive equality. Use a bounded metadata
  // superset for ordinary names, then require exact normalized equality below.
  const patterns = [
    ...new Set(
      [...nameKeys(name)].map((key) =>
        /^[\p{L}\p{N}]+$/u.test(key) ? [...key].join('*') : literal,
      ),
    ),
  ];
  const comparisons = patterns.map(
    (pattern) => `kMDItemFSName == "${pattern}"c`,
  );
  const query =
    comparisons.length > 1 ? `(${comparisons.join(' || ')})` : comparisons[0];
  if (!query) return Promise.resolve(undefined);
  return new Promise((done) => {
    execFile(
      '/usr/bin/mdfind',
      [
        '-0',
        '-onlyin',
        home,
        `kMDItemContentType == "public.folder" && ${query}`,
      ],
      {
        timeout: 1500,
        maxBuffer: 65536,
        encoding: 'utf8',
        shell: false,
        killSignal: 'SIGKILL',
        signal,
      },
      (error, stdout) => {
        if (error) return done(undefined);
        const paths = stdout.split('\0').filter(Boolean);
        done(paths.length <= maximumCandidates ? paths : undefined);
      },
    );
  });
};

export function withinHome(path: string, home: string) {
  const child = relative(home, path);
  return (
    !!child && child !== '..' && !child.startsWith('../') && !isAbsolute(child)
  );
}

function normalizedName(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function nameKeys(name: string) {
  return new Set(
    [name, name.replace(/\s+(?:folder|directory)$/i, '')]
      .map(normalizedName)
      .filter(Boolean),
  );
}

function homePhrase(value: string) {
  return /^(?:(?:my|the|your|our)\s+)?(?:user|home)(?:\s+(?:folder|directory))?$/i.test(
    value,
  );
}

function genericFolder(value: string) {
  return /^(?:(?:my|your|the|a|our)\s+)?(?:(?:local|work|project)\s+)?folder$/i.test(
    value,
  );
}

async function actualDirectory(path: string) {
  const info = await lstat(path);
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    (await realpath(path)) === resolve(path)
  );
}

/** Read only immediate directory entry names; never descend into unnamed folders. */
async function childMatches(
  parent: string,
  name: string,
  signal: AbortSignal,
  deadline: number,
) {
  if (
    signal.aborted ||
    Date.now() >= deadline ||
    !(await actualDirectory(parent))
  )
    return;
  const keys = nameKeys(name);
  const matches: string[] = [];
  const directory = await opendir(parent, { bufferSize: 32 });
  let count = 0;
  for await (const entry of directory) {
    if (
      ++count > maximumDirectoryEntries ||
      signal.aborted ||
      Date.now() >= deadline
    )
      return;
    if (entry.isDirectory() && keys.has(normalizedName(entry.name)))
      matches.push(join(parent, entry.name));
  }
  return matches;
}

/** Returns a proposal only; the existing folder helper must inspect it before use. */
export async function folderHintCandidate(
  hint: string,
  options: FolderResolutionOptions,
  signal: AbortSignal,
): Promise<{ path: string; home?: string } | undefined> {
  let name = hint.trim();
  if (
    !name ||
    [...name].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return;
  const home = resolve(options.homeDirectory ?? homedir());
  name = name.replace(/^(?:the |a )?folder (?:named|called)\s+/i, '');
  if (/^(["']).*\1$/.test(name)) name = name.slice(1, -1);
  // Literal absolute paths retain their exact spelling and are never fuzzily expanded.
  if (name.startsWith('/')) {
    if (name.split('/').some((part) => part === '.' || part === '..')) return;
    const path = resolve(name);
    return path === '/' ? undefined : { path };
  }
  name = name.replace(/\b(?:forward\s+)?slash\b/gi, '/');
  const parts = name.split('/').map((part) => part.trim());
  const homeRelative = parts[0] === '~' || homePhrase(parts[0]);
  if (homeRelative) parts.shift();
  if (
    parts.length === 0 ||
    parts.length > maximumPathComponents ||
    parts.some(
      (part) =>
        !part ||
        genericFolder(part) ||
        /^(?:\.{1,2}|dot(?:\s+dot)?|parent(?:\s+(?:folder|directory))?)$/i.test(
          part,
        ),
    )
  )
    return;
  if (homeRelative || parts.length > 1) {
    let parent = home;
    const deadline = Date.now() + 1500;
    try {
      for (const part of parts) {
        const matches = await childMatches(parent, part, signal, deadline);
        if (matches?.length !== 1) return;
        parent = matches[0];
      }
      if (withinHome(parent, home) && (await actualDirectory(parent)))
        return { path: parent, home };
    } catch {
      /* Unavailable directory metadata retains the chooser. */
    }
    return;
  }
  name = parts[0];
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name === '~' ||
    homePhrase(name)
  )
    return;
  const known = homeFolders.find(
    (folder) => folder.toLowerCase() === name.toLowerCase(),
  );
  if (known) {
    const path = join(home, known);
    try {
      if (await actualDirectory(path)) return { path, home };
    } catch {
      /* Keep the chooser. */
    }
    return;
  }
  const results = await (options.search ?? searchFolderNames)(
    name,
    home,
    signal,
  ).catch(() => undefined);
  if (!results || results.length > maximumCandidates) return;
  const keys = nameKeys(name);
  let children: string[] | undefined;
  try {
    children = await childMatches(home, name, signal, Date.now() + 1500);
  } catch {
    /* A partial directory listing cannot establish uniqueness. */
  }
  if (!children) return;
  const candidates = [
    ...new Set(
      [...results, ...children]
        .filter(
          (path) =>
            isAbsolute(path) &&
            withinHome(path, home) &&
            keys.has(normalizedName(basename(path))),
        )
        .map((path) => resolve(path)),
    ),
  ];
  if (candidates.length === 1) {
    try {
      if (await actualDirectory(candidates[0]))
        return { path: candidates[0], home };
    } catch {
      /* Stale metadata retains the chooser. */
    }
  }
}
