import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { readWorkspaceManifest } from '../../shared/workspace-manifest.js';
export const migrationProofSchema = z
  .object({
    source: z
      .object({
        directory: z.string(),
        sqlitePath: z.string(),
        configurationPath: z.string(),
        postgresUrl: z.string(),
        ownerId: z.string(),
        workspaceId: z.string(),
      })
      .strict(),
    backup: z
      .object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
    configurationSeal: z.string().regex(/^[a-f0-9]{64}$/),
    targetWorkspaceId: z.uuid(),
  })
  .strict();
export type MigrationProof = z.infer<typeof migrationProofSchema>;
export const movementProofSchema = z
  .object({
    directory: z.string(),
    sqlitePath: z.string(),
    workspaceId: z.uuid(),
    files: z.array(
      z
        .object({
          path: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    targetPaths: z.array(z.string()),
  })
  .strict();

export const restoreJournalSchema = z
  .object({
    version: z.literal(1),
    operationId: z.uuid(),
    phase: z.enum(['staging', 'verified', 'switching', 'active']),
    createdAt: z.number(),
    verifiedAt: z.number().optional(),
    postgresTarget: z.string().optional(),
    storage: z.enum(['legacy-postgres', 'sqlite']).optional(),
    migration: migrationProofSchema.optional(),
    movement: movementProofSchema.optional(),
    postgresOid: z.string().optional(),
    cleanupPending: z.boolean().optional(),
    databaseRemoved: z.boolean().optional(),
    directory: z.string(),
    previousSelection: z.string().nullable(),
    files: z.array(
      z
        .object({
          path: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    postgresSeal: z.string().optional(),
    abilityPaths: z
      .array(
        z
          .string()
          .max(1024)
          .regex(/^(?:snapshot|data)\/abilities\/state\/[a-f0-9]{64}\/.+/),
      )
      .max(200000)
      .optional(),
  })
  .strict();
export type RestoreJournal = z.infer<typeof restoreJournalSchema>;

/** Replace a single app-owned pointer only after its new contents reach disk. */
export async function atomicStorageWrite(path: string, value: string) {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    // Directory fsync is unavailable on Windows; the file itself is durable there.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
const portableProfileSchema = z
  .object({
    version: z.literal(1),
    rootFromProfile: z.string().min(1).max(4096),
  })
  .strict();
const portableSelectionSchema = z
  .object({
    version: z.literal(2),
    relativeToProfile: z.string().min(1).max(4096),
    workspaceId: z.uuid(),
  })
  .strict();
function relativePath(value: string) {
  if (
    isAbsolute(value) ||
    value.includes('\\') ||
    value.includes(':') ||
    value.includes('\0')
  )
    throw new Error('Invalid portable selection path');
  return value.split('/');
}
function contains(root: string, directory: string) {
  const part = relative(root, directory);
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
}
async function portableProfileRoot(profile: string) {
  let contents: string;
  try {
    contents = await readFile(join(profile, 'portable-profile.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const value = portableProfileSchema.parse(JSON.parse(contents));
  return resolve(profile, ...relativePath(value.rootFromProfile));
}
export async function configurePortableProfile(profile: string, root: string) {
  if (!isAbsolute(profile) || !isAbsolute(root))
    throw new Error('Portable profile paths must be absolute');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await atomicStorageWrite(
    join(profile, 'portable-profile.json'),
    JSON.stringify({
      version: 1,
      rootFromProfile: relative(profile, root).split(sep).join('/') || '.',
    }),
  );
}
export async function writeSelection(profile: string, directory: string) {
  if (!isAbsolute(directory))
    throw new Error('Workspace selection must be absolute');
  const root = await portableProfileRoot(profile);
  const manifest =
    root && contains(root, directory)
      ? await readWorkspaceManifest(directory)
      : undefined;
  await atomicStorageWrite(
    join(profile, 'workspace-location.json'),
    JSON.stringify(
      manifest
        ? {
            version: 2,
            relativeToProfile:
              relative(profile, directory).split(sep).join('/') || '.',
            workspaceId: manifest.id,
          }
        : { directory },
    ),
  );
}
export async function readSelection(
  profile: string,
  checkIdentity = true,
): Promise<string | null> {
  let contents: string;
  try {
    contents = await readFile(join(profile, 'workspace-location.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const value = JSON.parse(contents);
  if (value.version !== 2) return contents;
  const selection = portableSelectionSchema.parse(value),
    root = await portableProfileRoot(profile);
  const directory = resolve(
    profile,
    ...relativePath(selection.relativeToProfile),
  );
  if (!root || !contains(root, directory))
    throw new Error('Portable workspace selection escapes its root');
  if (
    checkIdentity &&
    (await readWorkspaceManifest(directory))?.id !== selection.workspaceId
  )
    throw new Error(
      'Selected portable workspace is missing or its identity changed',
    );
  return JSON.stringify({ directory });
}
export function journalPath(profile: string, id: string) {
  z.uuid().parse(id);
  return join(profile, 'restore-journals', id + '.json');
}
export async function saveJournal(profile: string, journal: RestoreJournal) {
  await mkdir(join(profile, 'restore-journals'), {
    recursive: true,
    mode: 0o700,
  });
  await atomicStorageWrite(
    journalPath(profile, journal.operationId),
    JSON.stringify(restoreJournalSchema.parse(journal)),
  );
}
export async function loadJournal(profile: string, id: string) {
  const file = await open(
    journalPath(profile, id),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    if ((await file.stat()).size > 8 * 1024 * 1024)
      throw new Error('Invalid restore journal');
    const journal = restoreJournalSchema.parse(
      JSON.parse(await file.readFile('utf8')),
    );
    if (journal.operationId !== id) throw new Error('Invalid restore identity');
    return journal;
  } finally {
    await file.close();
  }
}
export async function fileSeal(path: string, signal: AbortSignal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile())
      throw new Error('Restore target changed');
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      hash.update(chunk);
    }
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}
export async function ownedRestoreDirectory(journal: RestoreJournal) {
  if (
    !(await lstat(journal.directory)).isDirectory() ||
    (await readFile(join(journal.directory, '.restore-owner'), 'utf8')) !==
      journal.operationId
  )
    throw new Error('Restore target ownership changed');
}
export async function withRestoreLock<T>(
  profile: string,
  action: () => Promise<T>,
) {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  // The OS releases this SQLite lock even after SIGKILL. A lock directory can
  // remain stranded if the host dies while creating or reclaiming it.
  const lock = new DatabaseSync(join(profile, 'restore-coordination.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    return await action();
  } finally {
    lock.close();
  }
}
