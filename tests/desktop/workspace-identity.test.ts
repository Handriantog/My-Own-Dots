import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claimWorkspaceDatabase } from '../../src/server/workspace-identity.js';
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'dots-lock-'));
  directories.push(directory);
  return path.join(directory, 'state.sqlite');
}
it('serializes competing stale-lock recovery before either can replace a live owner', () => {
  const database = fixture();
  const lock = `${database}.runtime-lock`;
  const stalePid = 2_000_000_001;
  writeFileSync(lock, JSON.stringify({ pid: stalePid }));
  let attempted = false;
  let competingRelease: (() => void) | undefined;
  const realKill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid !== stalePid) return realKill(pid, signal);
    if (!attempted) {
      attempted = true;
      try {
        competingRelease = claimWorkspaceDatabase(database);
      } catch {
        /* A contender must fail while recovery is held. */
      }
    }
    throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
  });
  const release = claimWorkspaceDatabase(database);
  try {
    expect(attempted).toBe(true);
    expect(competingRelease).toBeUndefined();
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
  } finally {
    release();
    competingRelease?.();
  }
});
it('never reclaims an existing recovery guard automatically', () => {
  const database = fixture();
  const lock = `${database}.runtime-lock`;
  const guard = `${lock}.guard`;
  mkdirSync(guard);
  writeFileSync(lock, JSON.stringify({ pid: 2_000_000_001 }));
  expect(() => claimWorkspaceDatabase(database)).toThrow(
    /progress|guard|ownership/i,
  );
  expect(existsSync(guard)).toBe(true);
  expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(2_000_000_001);
});
it('does not let a released lease remove a later owner in the same process', () => {
  const database = fixture();
  const first = claimWorkspaceDatabase(database);
  first();
  const second = claimWorkspaceDatabase(database);
  try {
    first();
    expect(existsSync(`${database}.runtime-lock`)).toBe(true);
  } finally {
    second();
  }
});
