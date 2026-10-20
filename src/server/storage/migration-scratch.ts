import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { POSTGRES_RECORDS } from './postgres-records.js';

/** Private disposable captures, with ownership recorded before any data is copied. */
export async function createMigrationScratch(profile: string) {
  const id = randomUUID();
  const directory = join(profile, '.migration-' + id);
  await mkdir(directory, { mode: 0o700 });
  const marker = await open(join(directory, '.owner'), 'wx', 0o600);
  try {
    await marker.writeFile(
      JSON.stringify({ version: 1, id, pid: process.pid }),
    );
    await marker.sync();
  } finally {
    await marker.close();
  }
  return directory;
}

export async function recoverMigrationScratch(profile: string) {
  const warnings: string[] = [];
  const allowed = new Set([
    '.owner',
    'recovery/migration-verification.json',
    ...['', '-wal', '-shm', '-journal'].map(
      (suffix) => 'data/opendots.sqlite' + suffix,
    ),
    ...['capture', 'verify'].flatMap((root) => [
      ...['', '-wal', '-shm'].map(
        (suffix) => `${root}/core/workspace.sqlite${suffix}`,
      ),
      `${root}/recovery/configuration.json`,
      ...Object.keys(POSTGRES_RECORDS).map(
        (table) => `${root}/postgres/${table}.jsonl`,
      ),
    ]),
  ]);
  const names = await readdir(profile);
  for (const name of names.filter((name) =>
    /^\.migration-[a-f0-9-]{36}$/.test(name),
  )) {
    const directory = join(profile, name);
    try {
      if (
        !(await lstat(directory)).isDirectory() ||
        !(await lstat(join(directory, '.owner'))).isFile()
      )
        throw new Error('Ownership changed');
      const marker = JSON.parse(
        await readFile(join(directory, '.owner'), 'utf8'),
      );
      if (
        marker.version !== 1 ||
        marker.id !== name.slice(11) ||
        !Number.isSafeInteger(marker.pid) ||
        marker.pid < 1
      )
        throw new Error('Ownership changed');
      try {
        process.kill(marker.pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      }
      const inspect = async (prefix = '') => {
        for (const item of await readdir(join(directory, prefix), {
          withFileTypes: true,
        })) {
          const path = prefix ? `${prefix}/${item.name}` : item.name;
          if (
            item.isDirectory() &&
            ([...allowed].some((file) => file.startsWith(path + '/')) ||
              /^data\/\.schema-[A-Za-z0-9]+$/.test(path))
          )
            await inspect(path);
          else if (
            !item.isFile() ||
            (!allowed.has(path) &&
              !/^data\/\.schema-[A-Za-z0-9]+\/baseline.sqlite(?:-wal|-shm|-journal)?$/.test(
                path,
              ) &&
              !/^recovery\/\.[a-f0-9-]{36}\.tmp$/.test(path))
          )
            throw new Error('Unrecognized scratch file');
        }
      };
      await inspect();
      await rm(directory, { recursive: true });
    } catch {
      warnings.push(
        `Interrupted migration files retained for inspection: ${directory}`,
      );
    }
  }
  return warnings;
}
