import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BackupSchedule,
  selectRetainedBackups,
  type BackupRecord,
} from '../../src/desktop/host/backup-schedule.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
const record = (
  day: number,
  extra: Partial<BackupRecord> = {},
): BackupRecord => ({
  id: `day-${day}`,
  createdAt: new Date(Date.UTC(2026, 9, day, 12)).toISOString(),
  verified: true,
  managed: true,
  ...extra,
});

describe('backup retention', () => {
  it('keeps seven daily and four weekly verified points', () => {
    const records = Array.from({ length: 35 }, (_, i) => record(20 - i));
    // Daily Oct 14..20; Monday-based weekly representatives Oct 20,18,11,4.
    expect([...selectRetainedBackups(records)].sort()).toEqual(
      [
        'day-4',
        'day-11',
        'day-14',
        'day-15',
        'day-16',
        'day-17',
        'day-18',
        'day-19',
        'day-20',
      ].sort(),
    );
  });
  it('never prunes last verified or unmanaged export', () => {
    const records = [
      record(1),
      record(-80, { id: 'manual', managed: false }),
      record(20, { id: 'incomplete', verified: false }),
    ];
    expect(selectRetainedBackups(records)).toEqual(
      new Set(['day-1', 'manual', 'incomplete']),
    );
  });
  it('selects the latest successful point within a UTC day independent of input order', () => {
    const records = [
      record(1),
      record(1, { id: 'later', createdAt: '2026-10-01T23:30:00.000Z' }),
      record(1, {
        id: 'local-next-day',
        createdAt: '2026-10-02T01:00:00+08:00',
      }),
    ];
    expect(selectRetainedBackups(records)).toEqual(new Set(['later']));
    expect(selectRetainedBackups(records.reverse())).toEqual(
      new Set(['later']),
    );
  });
  it('preserves records with invalid metadata instead of selecting them for removal', () => {
    expect(
      selectRetainedBackups([record(1, { createdAt: 'unknown' })]),
    ).toEqual(new Set(['day-1']));
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dot-schedule-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const stateFile = join(root, 'profile', 'backup-schedule.json');
  const records: BackupRecord[] = [];
  const removed: string[] = [];
  let calls = 0;
  let available = true;
  const options = {
    stateFile,
    backup: async () => {
      calls++;
      if (!available) throw new Error('drive unavailable');
      const value = record(20, { id: `backup-${calls}` });
      records.push(value);
      return value;
    },
    list: async () => records,
    remove: async (id: string) => {
      removed.push(id);
    },
  };
  return {
    options,
    stateFile,
    records,
    removed,
    calls: () => calls,
    setAvailable: (value: boolean) => {
      available = value;
    },
  };
}
const now = Date.UTC(2026, 9, 20, 12);
describe('automatic backup schedule', () => {
  it('skips unchanged state and limits successful backup to one per changed UTC day', async () => {
    const f = await fixture();
    const schedule = new BackupSchedule(f.options);
    await schedule.tick({ now, revision: 'r1', idle: false });
    expect(f.calls()).toBe(0);
    await schedule.tick({ now, revision: 'r1', idle: true });
    expect(f.calls()).toBe(1);
    await schedule.tick({ now: now + 1000, revision: 'r2', idle: true });
    expect(f.calls()).toBe(1);
    await schedule.tick({ now: now + 86400000, revision: 'r1', idle: true });
    expect(f.calls()).toBe(1);
    const restarted = new BackupSchedule(f.options);
    await restarted.tick({ now: now + 86400000, revision: 'r2', idle: true });
    expect(f.calls()).toBe(2);
    expect((await restarted.status()).lastSuccess?.revision).toBe('r2');
  });
  it('missing destination does not become success', async () => {
    const f = await fixture();
    f.setAvailable(false);
    const schedule = new BackupSchedule(f.options);
    await expect(
      schedule.tick({ now, revision: 'r1', idle: true }),
    ).rejects.toThrow();
    expect(await schedule.status()).toMatchObject({ lastAttempt: now });
    expect((await schedule.status()).lastSuccess).toBeUndefined();
    expect(f.removed).toEqual([]);
    f.setAvailable(true);
    await schedule.tick({ now: now + 1000, revision: 'r1', idle: true });
    expect((await schedule.status()).lastSuccess?.revision).toBe('r1');
    expect(
      JSON.parse(await readFile(f.stateFile, 'utf8')).lastSuccess.revision,
    ).toBe('r1');
  });
  it('does not prune until a verified backup and its success state are published', async () => {
    const f = await fixture();
    f.records.push(...Array.from({ length: 40 }, (_, i) => record(19 - i)));
    const schedule = new BackupSchedule({
      ...f.options,
      remove: async (id) => {
        expect(
          JSON.parse(await readFile(f.stateFile, 'utf8')).lastSuccess.id,
        ).toBe('backup-1');
        f.removed.push(id);
      },
    });
    await schedule.tick({ now, revision: 'r1', idle: true });
    expect(f.removed.length).toBeGreaterThan(0);
    expect(f.removed).not.toContain('backup-1');
  });
  it('rejects unverified controller results and does not prune', async () => {
    const f = await fixture();
    const schedule = new BackupSchedule({
      ...f.options,
      backup: async () => record(20, { verified: false }),
    });
    await expect(
      schedule.tick({ now, revision: 'r1', idle: true }),
    ).rejects.toThrow(/verified/i);
    expect((await schedule.status()).lastSuccess).toBeUndefined();
    expect(f.removed).toEqual([]);
  });
  it('coalesces simultaneous ticks instead of creating duplicate archives', async () => {
    const f = await fixture();
    const schedule = new BackupSchedule(f.options);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        schedule.tick({ now, revision: 'r1', idle: true }),
      ),
    );
    expect(f.calls()).toBe(1);
  });
});
