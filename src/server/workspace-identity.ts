import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export function workspaceIdentity(database: string) {
  const absolute = path.resolve(database);
  const canonical = existsSync(absolute)
    ? realpathSync(absolute)
    : path.join(realpathSync(path.dirname(absolute)), path.basename(absolute));
  return createHash('sha256').update(canonical).digest('hex');
}

/** An atomic, process-owned lock prevents two backend runners sharing a SQLite store. */
export function claimWorkspaceDatabase(database: string) {
  mkdirSync(path.dirname(path.resolve(database)), { recursive: true });
  const canonical = existsSync(database)
    ? realpathSync(database)
    : path.resolve(database);
  const lock = `${canonical}.runtime-lock`;
  const record = JSON.stringify({ pid: process.pid });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, record, { flag: 'wx', mode: 0o600 });
      const release = () => {
        try {
          if (readFileSync(lock, 'utf8') === record) unlinkSync(lock);
        } catch {
          /* Already released. */
        }
      };
      process.once('exit', release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number;
      try {
        pid = (JSON.parse(readFileSync(lock, 'utf8')) as { pid: number }).pid;
      } catch {
        throw new Error(
          'Workspace database lock is invalid; inspect its runtime-lock file before retrying.',
        );
      }
      if (!Number.isInteger(pid) || pid < 1)
        throw new Error('Workspace database lock is invalid.', {
          cause: error,
        });
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
          try {
            unlinkSync(lock);
          } catch {
            /* Concurrent cleanup. */
          }
          continue;
        }
      }
      throw new Error(
        'This workspace database is already open in another backend. Attach to that backend instead of starting a second runner.',
        { cause: error },
      );
    }
  }
  throw new Error(
    'Workspace database could not be locked safely. Retry after the other backend has stopped.',
  );
}
