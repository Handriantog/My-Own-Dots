import { open, rm } from 'node:fs/promises';
import { backup, type DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
/** Called only with a host-owned staging path while workspace admission is held. */
export class SQLiteSnapshot {
  constructor(
    private db: DatabaseSync,
    private ownerId: string,
  ) {}
  async capture(destination: string, signal?: AbortSignal) {
    for (const row of this.db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()) {
      signal?.throwIfAborted();
      const table = String(row.name).replaceAll('"', '""');
      for (const column of this.db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()) {
        if (
          (column.name === 'ownerId' || column.name === 'owner_id') &&
          this.db
            .prepare(
              `SELECT 1 FROM "${table}" WHERE "${column.name}"<>? LIMIT 1`,
            )
            .get(this.ownerId)
        )
          throw new Error('SQLite contains ambiguous workspace ownership');
      }
      await setImmediate();
    }
    signal?.throwIfAborted();
    const file = await open(destination, 'wx', 0o600);
    await file.close();
    try {
      await backup(this.db, destination, {
        rate: 128,
        progress: () => {
          signal?.throwIfAborted();
        },
      });
      signal?.throwIfAborted();
      const saved = await open(destination, 'r');
      try {
        await saved.sync();
      } finally {
        await saved.close();
      }
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
  }
}
