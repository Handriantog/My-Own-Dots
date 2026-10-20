import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageWorkspace } from '../fixtures/storage-workspace.js';
import { LegacySnapshotSource } from '../../src/server/storage/legacy-snapshot.js';
import { writeArchive } from '../../src/server/storage/archive.js';
import { RestoreService } from '../../src/server/storage/restore.js';
import {
  restorePostgres,
  restoredDatabaseName,
  restoredDatabaseUrl,
} from '../../src/server/storage/restore-postgres.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const f = await storageWorkspace();
  cleanups.push(f.dispose);
  f.store.createTask('Do not run after restoration', 60);
  f.workspace.computers.patch(f.dot.id, { enabled: true, files: true });
  const manifest = await new LegacySnapshotSource({
    ...f,
    owned: true,
    conversationBackend: 'local',
  }).capture(f.directory, new AbortController().signal);
  const archive = join(f.root, 'recovery.dotsbackup');
  const passphrase = 'fixture recovery password';
  await writeArchive({
    sourceDirectory: f.directory,
    manifest,
    destination: archive,
    passphrase,
    signal: new AbortController().signal,
  });
  const destination = join(f.root, 'restored');
  const profile = join(f.root, 'profile');
  await mkdir(profile);
  const selectionFile = join(profile, 'workspace-location.json');
  await writeFile(selectionFile, JSON.stringify({ directory: f.root }));
  const stopWorkspace = vi.fn(async () => {});
  const service = new RestoreService({ profile, stopWorkspace });
  cleanups.push(async () => {
    try {
      const env = parseEnv(await readFile(join(destination, '.env'), 'utf8'));
      const name = new URL(env.LOCAL_DATABASE_URL!).pathname.slice(1);
      if (/^dots_restore_[a-f0-9]{32}$/.test(name))
        await f.pg.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } catch {
      /* A failed preparation may have already removed its own target. */
    }
  });
  return {
    ...f,
    manifest,
    archive,
    passphrase,
    destination,
    profile,
    selectionFile,
    service,
    stopWorkspace,
    input: {
      archive,
      passphrase,
      destination,
      postgresTarget: f.postgresUrl,
      signal: new AbortController().signal,
    },
  };
}

describe.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'workspace restore',
  () => {
    it('never populates or deletes a pre-existing PostgreSQL target', async () => {
      const f = await fixture();
      const operationId = randomUUID();
      const name = restoredDatabaseName(operationId);
      await f.pg.query(`CREATE DATABASE "${name}"`);
      const target = new Pool({
        connectionString: restoredDatabaseUrl(f.postgresUrl, operationId),
      });
      try {
        await target.query(
          "CREATE TABLE sentinel(value text); INSERT INTO sentinel VALUES('unrelated')",
        );
        await expect(
          restorePostgres({
            server: f.postgresUrl,
            operationId,
            directory: f.directory,
            ownerId: f.ownerId,
            dotIds: [f.dot.id],
            threads: [],
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow(/exists/i);
        expect((await target.query('SELECT value FROM sentinel')).rows).toEqual(
          [{ value: 'unrelated' }],
        );
      } finally {
        await target.end();
        await f.pg.query(`DROP DATABASE "${name}"`);
      }
    });
    it('leaves source and selection intact without database-creation permission', async () => {
      const f = await fixture();
      const role = 'restore_test_' + randomUUID().replaceAll('-', '');
      await f.pg.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'disposable-test' NOCREATEDB`,
      );
      const server = new URL(f.postgresUrl);
      server.username = role;
      server.password = 'disposable-test';
      try {
        await expect(
          f.service.prepareRestore({
            ...f.input,
            postgresTarget: server.toString(),
          }),
        ).rejects.toThrow(/permission|create database/i);
        await expect(stat(f.destination)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(
          JSON.parse(await readFile(f.selectionFile, 'utf8')).directory,
        ).toBe(f.root);
        expect(
          (await f.conversations.getSnapshot(f.thread)).messages,
        ).toHaveLength(2);
      } finally {
        await f.pg.query(`DROP ROLE "${role}"`);
      }
    });
    it('rejects a changed restored database before closing the active workspace', async () => {
      const f = await fixture();
      const preview = await f.service.prepareRestore(f.input);
      const env = parseEnv(await readFile(join(f.destination, '.env'), 'utf8'));
      const pool = new Pool({ connectionString: env.LOCAL_DATABASE_URL });
      try {
        await pool.query(
          "UPDATE local_ai_threads SET name='changed after preview'",
        );
      } finally {
        await pool.end();
      }
      await expect(
        f.service.activateRestore(
          preview.operationId,
          'new',
          new AbortController().signal,
        ),
      ).rejects.toThrow(/checksum changed/i);
      expect(f.stopWorkspace).not.toHaveBeenCalled();
    });
    it('rejects unknown SQLite triggers before running restored mutations', async () => {
      const f = await fixture();
      const path = 'core/workspace.sqlite';
      const db = new DatabaseSync(join(f.directory, path));
      db.exec(
        'CREATE TRIGGER unrecognized AFTER UPDATE ON settings BEGIN DELETE FROM memories; END;',
      );
      db.close();
      const bytes = await readFile(join(f.directory, path));
      const entry = f.manifest.entries.find((entry) => entry.path === path)!;
      entry.bytes = bytes.length;
      entry.sha256 = createHash('sha256').update(bytes).digest('hex');
      const archive = join(f.root, 'invalid-schema.dotsbackup');
      await writeArchive({
        sourceDirectory: f.directory,
        manifest: f.manifest,
        destination: archive,
        passphrase: f.passphrase,
        signal: new AbortController().signal,
      });
      await expect(
        f.service.prepareRestore({ ...f.input, archive }),
      ).rejects.toThrow(/schema/i);
      expect(f.store.memories()).toHaveLength(1);
      await expect(stat(f.destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    it('rolls back selection if final journal publication fails', async () => {
      const f = await fixture();
      const preview = await f.service.prepareRestore(f.input);
      const rename = fs.rename;
      const failure = vi
        .spyOn(fs, 'rename')
        .mockImplementation(async (from, to) => {
          if (
            String(to).endsWith(preview.operationId + '.json') &&
            JSON.parse(await fs.readFile(from, 'utf8')).phase === 'active'
          )
            throw Object.assign(new Error('Simulated journal disk failure'), {
              code: 'ENOSPC',
            });
          return rename(from, to);
        });
      syncBuiltinESMExports();
      try {
        await expect(
          f.service.activateRestore(
            preview.operationId,
            'new',
            new AbortController().signal,
          ),
        ).rejects.toThrow('Simulated journal disk failure');
        expect(
          JSON.parse(await readFile(f.selectionFile, 'utf8')).directory,
        ).toBe(f.root);
      } finally {
        failure.mockRestore();
        syncBuiltinESMExports();
      }
    });
    it('rejects archive records with missing memory source references', async () => {
      const f = await fixture();
      const path = 'postgres/memory_jobs.jsonl';
      const lines = (await readFile(join(f.directory, path), 'utf8'))
        .trimEnd()
        .split('\n');
      const row = JSON.parse(lines[1]);
      row.source_ids = JSON.stringify(['missing-source']);
      lines[1] = JSON.stringify(row);
      const bytes = Buffer.from(lines.join('\n') + '\n');
      await writeFile(join(f.directory, path), bytes);
      const entry = f.manifest.entries.find((entry) => entry.path === path)!;
      entry.bytes = bytes.length;
      entry.sha256 = createHash('sha256').update(bytes).digest('hex');
      const archive = join(f.root, 'invalid-reference.dotsbackup');
      await writeArchive({
        sourceDirectory: f.directory,
        manifest: f.manifest,
        destination: archive,
        passphrase: f.passphrase,
        signal: new AbortController().signal,
      });
      await expect(
        f.service.prepareRestore({ ...f.input, archive }),
      ).rejects.toThrow(/reference/i);
      expect(
        JSON.parse(await readFile(f.selectionFile, 'utf8')).directory,
      ).toBe(f.root);
    });
    it('rejects a SQLite conversation binding absent from the archived database', async () => {
      const f = await fixture();
      const path = 'core/workspace.sqlite';
      const db = new DatabaseSync(join(f.directory, path));
      db.prepare(
        'INSERT INTO thread_bindings(id,dotId,ownerId,title,createdAt) VALUES (?,?,?,?,?)',
      ).run(
        'missing-thread',
        f.dot.id,
        f.ownerId,
        'Missing conversation',
        Date.now(),
      );
      db.close();
      const bytes = await readFile(join(f.directory, path));
      const entry = f.manifest.entries.find((entry) => entry.path === path)!;
      entry.bytes = bytes.length;
      entry.sha256 = createHash('sha256').update(bytes).digest('hex');
      const archive = join(f.root, 'invalid-binding.dotsbackup');
      await writeArchive({
        sourceDirectory: f.directory,
        manifest: f.manifest,
        destination: archive,
        passphrase: f.passphrase,
        signal: new AbortController().signal,
      });
      await expect(
        f.service.prepareRestore({ ...f.input, archive }),
      ).rejects.toThrow(/binding|reference/i);
    });
    it('does not overwrite a selection changed while the old backend closes', async () => {
      const f = await fixture();
      const other = JSON.stringify({
        directory: join(f.root, 'another-workspace'),
      });
      f.stopWorkspace.mockImplementationOnce(async () => {
        await writeFile(f.selectionFile, other);
      });
      const preview = await f.service.prepareRestore(f.input);
      await expect(
        f.service.activateRestore(
          preview.operationId,
          'new',
          new AbortController().signal,
        ),
      ).rejects.toThrow(/changed/i);
      expect(await readFile(f.selectionFile, 'utf8')).toBe(other);
    });
    it.each(['staging', 'database', 'verified', 'switching', 'active'])(
      'recovers selection after crash at journal boundary %s',
      async (crashAt) => {
        const f = await fixture();
        const child = fork(
          new URL('../fixtures/restore-process.ts', import.meta.url),
          [],
          {
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          },
        );
        let diagnostics = '';
        child.stderr?.on('data', (value) => {
          diagnostics += value;
        });
        const exit = once(child, 'exit');
        try {
          const message = new Promise<{ operationId: string; error?: string }>(
            (resolve, reject) => {
              child.once('message', (value) =>
                resolve(value as { operationId: string }),
              );
              child.once('exit', () =>
                reject(
                  new Error(
                    diagnostics || 'Restore child exited before boundary',
                  ),
                ),
              );
              child.once('error', reject);
            },
          );
          child.send({
            ...f.input,
            signal: undefined,
            profile: f.profile,
            crashAt,
          });
          const result = await message;
          expect(result.error).toBeUndefined();
          child.kill('SIGKILL');
          await exit;
          await f.service.recover();
          expect(
            JSON.parse(await readFile(f.selectionFile, 'utf8')).directory,
          ).toBe(crashAt === 'active' ? f.destination : f.root);
          if (crashAt === 'switching') {
            await f.service.activateRestore(
              result.operationId,
              'new',
              new AbortController().signal,
            );
            expect(
              JSON.parse(await readFile(f.selectionFile, 'utf8')).directory,
            ).toBe(f.destination);
          }
          if (
            crashAt === 'verified' ||
            crashAt === 'staging' ||
            crashAt === 'database'
          )
            await expect(stat(f.destination)).rejects.toMatchObject({
              code: 'ENOENT',
            });
          expect(
            (await f.conversations.getSnapshot(f.thread)).messages,
          ).toHaveLength(2);
        } finally {
          child.kill('SIGKILL');
          await exit;
        }
      },
      20000,
    );
    it('restores without replaying pending actions', async () => {
      const f = await fixture();
      const preview = await f.service.prepareRestore(f.input);
      expect(preview.counts.local_ai_threads).toBe(1);
      expect(preview.counts.memory_items).toBe(2);
      expect(f.stopWorkspace).not.toHaveBeenCalled();
      expect(
        JSON.parse(await readFile(f.selectionFile, 'utf8')).directory,
      ).toBe(f.root);
      const env = parseEnv(await readFile(join(f.destination, '.env'), 'utf8'));
      expect(env.OWNER_ID).toBe(f.ownerId);
      expect(env.OWNER_TOKEN).not.toBe('recovery-evidence-only');
      expect(env.LOCAL_DATABASE_URL).not.toBe('do-not-activate');
      const db = new DatabaseSync(join(f.destination, 'data/opendots.sqlite'), {
        readOnly: true,
      });
      try {
        expect(
          JSON.parse(
            String(db.prepare('SELECT value FROM settings').get()!.value),
          ).paused,
        ).toBe(true);
        expect(db.prepare('SELECT status FROM tasks').get()!.status).toBe(
          'paused',
        );
        expect(
          db.prepare('SELECT count(*) AS n FROM mcp_approvals').get()!.n,
        ).toBe(0);
        expect(
          db.prepare('SELECT count(*) AS n FROM mcp_connections').get()!.n,
        ).toBe(0);
        expect(
          db.prepare('SELECT count(*) AS n FROM computer_permissions').get()!.n,
        ).toBe(0);
        expect(
          db
            .prepare('SELECT status FROM memory_items WHERE id=?')
            .get(f.forgotten.id)!.status,
        ).toBe('forgotten');
        expect(
          db.prepare('SELECT count(*) AS n FROM memory_suppressions').get()!.n,
        ).toBeGreaterThan(0);
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name='storage_recovery_audit'",
            )
            .get(),
        ).toBeDefined();
        expect(
          JSON.stringify(
            db.prepare('SELECT value FROM storage_recovery_audit').all(),
          ),
        ).toContain('recover-only-secret');
      } finally {
        db.close();
      }
      expect(
        await readFile(
          join(f.destination, 'recovery/access-audit.jsonl'),
          'utf8',
        ),
      ).toContain('recover-only-secret');
      const pg = new Pool({ connectionString: env.LOCAL_DATABASE_URL });
      try {
        expect(
          (await pg.query('SELECT messages FROM local_ai_threads')).rows[0]
            .messages,
        ).toHaveLength(2);
        expect(
          (
            await pg.query(
              'SELECT state,lease_token,lease_until FROM memory_jobs',
            )
          ).rows[0],
        ).toEqual({ state: 'cancelled', lease_token: null, lease_until: null });
      } finally {
        await pg.end();
      }
      await f.service.activateRestore(
        preview.operationId,
        'new',
        new AbortController().signal,
      );
      expect(f.stopWorkspace).toHaveBeenCalledOnce();
      expect(
        JSON.parse(await readFile(f.selectionFile, 'utf8')).directory,
      ).toBe(f.destination);
      expect(
        (await f.conversations.getSnapshot(f.thread)).messages,
      ).toHaveLength(2);
    });

    it('refuses restore over an unrelated database or directory', async () => {
      const f = await fixture();
      await mkdir(f.destination);
      await writeFile(join(f.destination, 'sentinel'), 'unrelated');
      await expect(f.service.prepareRestore(f.input)).rejects.toThrow(
        /exist|empty/i,
      );
      expect(await readFile(join(f.destination, 'sentinel'), 'utf8')).toBe(
        'unrelated',
      );
      expect(
        (await f.conversations.getSnapshot(f.thread)).messages,
      ).toHaveLength(2);
    });

    it('refuses expired previews, target changes, and replacement without a verified backup', async () => {
      const f = await fixture();
      let now = Date.now();
      const service = new RestoreService({
        profile: f.profile,
        stopWorkspace: f.stopWorkspace,
        now: () => now,
      });
      const preview = await service.prepareRestore(f.input);
      await expect(
        service.activateRestore(
          preview.operationId,
          'replace',
          new AbortController().signal,
        ),
      ).rejects.toThrow(/backup/i);
      now += 16 * 60_000;
      await expect(
        service.activateRestore(
          preview.operationId,
          'new',
          new AbortController().signal,
        ),
      ).rejects.toThrow(/expired/i);
      now -= 16 * 60_000;
      await writeFile(join(f.destination, 'data/opendots.sqlite'), 'changed');
      await expect(
        service.activateRestore(
          preview.operationId,
          'new',
          new AbortController().signal,
        ),
      ).rejects.toThrow(/changed|checksum/i);
      expect(f.stopWorkspace).not.toHaveBeenCalled();
      expect(
        JSON.parse(await readFile(f.selectionFile, 'utf8')).directory,
      ).toBe(f.root);
    });

    it('leaves the original selected if activation fails', async () => {
      const f = await fixture();
      f.stopWorkspace.mockRejectedValueOnce(
        new Error('Cannot close workspace'),
      );
      const preview = await f.service.prepareRestore(f.input);
      await expect(
        f.service.activateRestore(
          preview.operationId,
          'new',
          new AbortController().signal,
        ),
      ).rejects.toThrow('Cannot close workspace');
      expect(
        JSON.parse(await readFile(f.selectionFile, 'utf8')).directory,
      ).toBe(f.root);
      expect((await stat(f.sqlitePath)).isFile()).toBe(true);
    });
  },
);
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'starts preview expiry after a long preparation finishes',
  async () => {
    const f = await fixture();
    let now = Date.now();
    const service = new RestoreService({
      profile: f.profile,
      stopWorkspace: f.stopWorkspace,
      now: () => now,
      onPhase: (_id, phase) => {
        if (phase === 'staging') now += 16 * 60_000;
      },
    });
    const preview = await service.prepareRestore(f.input);
    await expect(
      service.activateRestore(
        preview.operationId,
        'new',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ workspaceDirectory: f.destination });
  },
);
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'discards only an unchanged unselected restore owned by its journal',
  async () => {
    const f = await fixture();
    const preview = await f.service.prepareRestore(f.input);
    const name = restoredDatabaseName(preview.operationId);
    await f.service.discardRestore(
      preview.operationId,
      new AbortController().signal,
    );
    await expect(stat(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await f.pg.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]))
        .rowCount,
    ).toBe(0);
    expect(JSON.parse(await readFile(f.selectionFile, 'utf8')).directory).toBe(
      f.root,
    );
    expect((await f.conversations.getSnapshot(f.thread)).messages).toHaveLength(
      2,
    );
  },
);
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'startup reclaims abandoned preparations but retains active and user-changed targets',
  async () => {
    const f = await fixture();
    const preview = await f.service.prepareRestore(f.input);
    await f.service.recover();
    await expect(stat(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (
        await f.pg.query('SELECT 1 FROM pg_database WHERE datname=$1', [
          restoredDatabaseName(preview.operationId),
        ])
      ).rowCount,
    ).toBe(0);
    const second = await f.service.prepareRestore(f.input);
    await writeFile(join(f.destination, 'user-file'), 'keep');
    await expect(
      f.service.discardRestore(
        second.operationId,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/unrecognized/);
    expect(await readFile(join(f.destination, 'user-file'), 'utf8')).toBe(
      'keep',
    );
    await fs.rm(join(f.destination, 'user-file'));
    await f.service.activateRestore(
      second.operationId,
      'new',
      new AbortController().signal,
    );
    await expect(
      f.service.discardRestore(
        second.operationId,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/active|selected/);
    await f.service.recover();
    expect(JSON.parse(await readFile(f.selectionFile, 'utf8')).directory).toBe(
      f.destination,
    );
  },
);
it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'retains a prepared database after someone adds unrelated data',
  async () => {
    const f = await fixture();
    const preview = await f.service.prepareRestore(f.input);
    const env = parseEnv(await readFile(join(f.destination, '.env'), 'utf8'));
    const target = new Pool({ connectionString: env.LOCAL_DATABASE_URL });
    try {
      await target.query(
        "CREATE TABLE user_content(value text); INSERT INTO user_content VALUES('keep')",
      );
    } finally {
      await target.end();
    }
    await expect(
      f.service.discardRestore(
        preview.operationId,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/changed|unrecognized|unexpected/i);
    await f.service.recover();
    const warnings = JSON.parse(
      await readFile(join(f.profile, 'restore-cleanup-warnings.json'), 'utf8'),
    );
    expect(warnings[0]).toContain(f.destination);
    expect(warnings[0]).not.toContain(env.LOCAL_DATABASE_URL);
    const check = new Pool({ connectionString: env.LOCAL_DATABASE_URL });
    try {
      expect(
        (await check.query('SELECT value FROM user_content')).rows[0].value,
      ).toBe('keep');
    } finally {
      await check.end();
    }
  },
);
