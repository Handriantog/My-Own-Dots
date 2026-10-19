import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export type BackupRecord = {
  id: string;
  createdAt: string;
  verified: boolean;
  managed: boolean;
};
const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);
const weekKey = (time: number) => {
  const date = new Date(time);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return dayKey(date.getTime());
};

/** Daily and weekly retention overlap; one archive can satisfy both buckets.
 * Unmanaged, unverified or malformed records are never deleted by retention.
 */
export function selectRetainedBackups(
  records: readonly BackupRecord[],
): Set<string> {
  const keep = new Set<string>();
  const eligible: BackupRecord[] = [];
  for (const record of records) {
    if (
      !record.managed ||
      !record.verified ||
      !Number.isFinite(Date.parse(record.createdAt))
    )
      keep.add(record.id);
    else eligible.push(record);
  }
  eligible.sort(
    (a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const record of eligible) {
    const time = Date.parse(record.createdAt),
      day = dayKey(time),
      week = weekKey(time);
    if (days.size < 7 && !days.has(day)) {
      days.add(day);
      keep.add(record.id);
    }
    if (weeks.size < 4 && !weeks.has(week)) {
      weeks.add(week);
      keep.add(record.id);
    }
  }
  return keep;
}

const stateSchema = z
  .object({
    version: z.literal(1),
    lastAttempt: z.number().int().nonnegative().optional(),
    lastSuccess: z
      .object({
        at: z.number().int().nonnegative(),
        revision: z.string().min(1),
        id: z.string().min(1),
      })
      .strict()
      .optional(),
    error: z.string().optional(),
  })
  .strict();
export type BackupScheduleState = z.infer<typeof stateSchema>;
interface Options {
  /** Workspace-specific desktop profile metadata, outside the workspace being backed up. */
  stateFile: string;
  /** Resolves only after the archive is published and independently verified. */
  backup: () => Promise<BackupRecord>;
  list: () => Promise<BackupRecord[]>;
  /** Removes an app-managed archive by opaque identity, never an arbitrary path. */
  remove: (id: string) => Promise<void>;
}

export class BackupSchedule {
  private state?: BackupScheduleState;
  private pending?: Promise<void>;
  private loading?: Promise<void>;
  constructor(private readonly options: Options) {}

  async status(): Promise<BackupScheduleState> {
    await this.load();
    return structuredClone(this.state!);
  }

  tick(input: { now: number; revision: string; idle: boolean }): Promise<void> {
    if (!input.idle) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.run(input).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async run({
    now,
    revision,
  }: {
    now: number;
    revision: string;
  }): Promise<void> {
    if (!Number.isSafeInteger(now) || now < 0 || !revision)
      throw new Error('Invalid backup scheduling state.');
    await this.load();
    const previous = this.state!.lastSuccess;
    if (
      previous &&
      (previous.revision === revision || dayKey(previous.at) >= dayKey(now))
    )
      return;
    await this.save({ ...this.state!, lastAttempt: now, error: undefined });
    let backup: BackupRecord;
    try {
      backup = await this.options.backup();
      if (
        !backup.verified ||
        !backup.managed ||
        !backup.id ||
        !Number.isFinite(Date.parse(backup.createdAt))
      ) {
        throw new Error(
          'Backup controller did not return a verified managed archive.',
        );
      }
      await this.save({
        ...this.state!,
        lastSuccess: { at: now, revision, id: backup.id },
        error: undefined,
      });
    } catch (error) {
      await this.save({
        ...this.state!,
        error: 'Backup failed. Check the destination and try again.',
      });
      throw error;
    }
    // Prune only after durable success metadata. Failure here cannot turn a
    // verified recovery point into a failed or missing backup.
    try {
      const records = await this.options.list();
      const retained = selectRetainedBackups(records);
      retained.add(backup.id);
      for (const record of records) {
        if (record.managed && record.verified && !retained.has(record.id))
          await this.options.remove(record.id);
      }
    } catch {
      await this.save({
        ...this.state!,
        error: 'Backup succeeded; older backups could not be removed.',
      });
    }
  }

  private load(): Promise<void> {
    if (this.state) return Promise.resolve();
    return (this.loading ??= this.readState().finally(() => {
      this.loading = undefined;
    }));
  }

  private async readState(): Promise<void> {
    try {
      this.state = stateSchema.parse(
        JSON.parse(await readFile(this.options.stateFile, 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Backup schedule metadata is unreadable. Existing backups were retained.',
          { cause: error },
        );
      this.state = { version: 1 };
    }
  }

  private async save(value: BackupScheduleState): Promise<void> {
    const state = stateSchema.parse(value);
    await mkdir(dirname(this.options.stateFile), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.options.stateFile}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(state) + '\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.options.stateFile);
      this.state = state;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
