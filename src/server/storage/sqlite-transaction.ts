import type { DatabaseSync } from 'node:sqlite';
/** Nested repositories participate in the worker's transaction; standalone callers keep their original lock semantics. */
export function beginSQLiteTransaction(db: DatabaseSync, immediate = true) {
  const nested = db.isTransaction;
  db.exec(
    nested
      ? 'SAVEPOINT repository_operation'
      : immediate
        ? 'BEGIN IMMEDIATE'
        : 'BEGIN',
  );
  return {
    commit: () => db.exec(nested ? 'RELEASE repository_operation' : 'COMMIT'),
    rollback: () =>
      db.exec(
        nested
          ? 'ROLLBACK TO repository_operation; RELEASE repository_operation'
          : 'ROLLBACK',
      ),
  };
}
