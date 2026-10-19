import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';

export const restoreJournalSchema = z
  .object({
    version: z.literal(1),
    operationId: z.uuid(),
    phase: z.enum(['staging', 'verified', 'switching', 'active']),
    createdAt: z.number(),
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
export async function readSelection(profile: string): Promise<string | null> {
  try {
    return await readFile(join(profile, 'workspace-location.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
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
