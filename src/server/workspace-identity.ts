import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Identity and ownership must use the same path before and after first creation. */
function canonicalDatabase(database: string) {
  const absolute = path.resolve(database);
  if (existsSync(absolute)) return realpathSync(absolute);
  if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(
      'Database symlink target is missing. Set DATABASE_PATH to the intended target file directly, or restore the symlink target before retrying.',
    );
  return path.join(
    realpathSync(path.dirname(absolute)),
    path.basename(absolute),
  );
}
export function workspaceIdentity(database: string) {
  return createHash('sha256').update(canonicalDatabase(database)).digest('hex');
}

function withOwnershipGuard<T>(lock: string, action: () => T): T {
  const guard = `${lock}.guard`;
  try {
    mkdirSync(guard, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(
      'Workspace database ownership check is already in progress. Retry; if this persists, inspect the runtime-lock.guard directory after confirming no backend is running.',
      { cause: error },
    );
  }
  // Never reclaim another guard automatically: a checked stale PID can be replaced
  // before unlink. Every acquisition, reclamation and release uses this same guard.
  try {
    return action();
  } finally {
    rmdirSync(guard);
  }
}

/** A serialized, process-owned lease prevents duplicate runners sharing SQLite. */
export function claimWorkspaceDatabase(database: string) {
  mkdirSync(path.dirname(path.resolve(database)), { recursive: true });
  const canonical = canonicalDatabase(database);
  const lock = `${canonical}.runtime-lock`;
  const record = JSON.stringify({ pid: process.pid, lease: randomUUID() });
  withOwnershipGuard(lock, () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(lock, record, { flag: 'wx', mode: 0o600 });
        return;
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
            unlinkSync(lock);
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
  });
  const release = () => {
    try {
      withOwnershipGuard(lock, () => {
        if (readFileSync(lock, 'utf8') === record) unlinkSync(lock);
      });
      process.removeListener('exit', release);
    } catch {
      /* Leave ownership intact if another check is in progress. Dead leases can be reclaimed later. */
    }
  };
  process.once('exit', release);
  return release;
}
