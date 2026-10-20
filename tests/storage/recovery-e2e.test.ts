import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { storageWorkspace } from '../fixtures/storage-workspace.js';
import { LegacySnapshotSource } from '../../src/server/storage/legacy-snapshot.js';
import { writeArchive } from '../../src/server/storage/archive.js';
import { RestoreService } from '../../src/server/storage/restore.js';

it.skipIf(!process.env.LOCAL_TEST_DATABASE_URL)(
  'backup restores into an empty workspace with source disconnected',
  async () => {
    const adminUrl = process.env.LOCAL_TEST_DATABASE_URL!;
    const admin = new Pool({ connectionString: adminUrl });
    const sourceName = `dots_disconnected_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(adminUrl);
    url.pathname = `/${sourceName}`;
    const recovery = await mkdtemp(
      join(tmpdir(), 'dot-disconnected-recovery-'),
    );
    let f: Awaited<ReturnType<typeof storageWorkspace>> | undefined;
    let restoredName: string | undefined;
    await admin.query(`CREATE DATABASE "${sourceName}"`);
    try {
      f = await storageWorkspace(url.toString());
      f.store.createTask('Never replay this schedule', 60);
      const manifest = await new LegacySnapshotSource({
        ...f,
        owned: true,
        conversationBackend: 'local',
      }).capture(f.directory, new AbortController().signal);
      const archive = join(recovery, 'saved.dotbackup');
      await writeArchive({
        sourceDirectory: f.directory,
        manifest,
        destination: archive,
        passphrase: 'independent recovery password',
        signal: new AbortController().signal,
      });
      await f.disconnect();
      // Remove both source stores from reach, retaining their bytes for comparison.
      await rename(f.root, f.root + '-offline');
      await admin.query(
        `ALTER DATABASE "${sourceName}" ALLOW_CONNECTIONS false`,
      );
      const unavailable = new Pool({
        connectionString: url.toString(),
        connectionTimeoutMillis: 1000,
      });
      try {
        await expect(unavailable.query('SELECT 1')).rejects.toThrow(
          /connections/i,
        );
      } finally {
        await unavailable.end();
      }
      const profile = join(recovery, 'profile');
      await mkdir(profile);
      const destination = join(recovery, 'restored');
      const service = new RestoreService({
        profile,
        stopWorkspace: async () => {},
      });
      const preview = await service.prepareRestore({
        archive,
        passphrase: 'independent recovery password',
        destination,
        postgresTarget: adminUrl,
        signal: new AbortController().signal,
      });
      expect(preview.counts.local_ai_threads).toBe(1);
      expect(preview.counts.memory_items).toBe(2);
      await service.activateRestore(
        preview.operationId,
        'new',
        new AbortController().signal,
      );
      const env = parseEnv(await readFile(join(destination, '.env'), 'utf8'));
      restoredName = new URL(env.LOCAL_DATABASE_URL!).pathname.slice(1);
      const db = new DatabaseSync(join(destination, 'data/opendots.sqlite'), {
        readOnly: true,
      });
      try {
        expect(
          db
            .prepare('SELECT status FROM memory_items WHERE id=?')
            .get(f.forgotten.id)!.status,
        ).toBe('forgotten');
        expect(
          Number(
            db.prepare('SELECT count(*) AS n FROM memory_suppressions').get()!
              .n,
          ),
        ).toBeGreaterThan(0);
        expect(
          Number(
            db.prepare('SELECT count(*) AS n FROM mcp_approvals').get()!.n,
          ),
        ).toBe(0);
        expect(
          Number(
            db
              .prepare('SELECT count(*) AS n FROM storage_recovery_audit')
              .get()!.n,
          ),
        ).toBeGreaterThan(0);
        expect(
          Number(
            db
              .prepare("SELECT count(*) AS n FROM tasks WHERE status<>'paused'")
              .get()!.n,
          ),
        ).toBe(0);
      } finally {
        db.close();
      }
      const restored = new Pool({ connectionString: env.LOCAL_DATABASE_URL });
      try {
        const threads = await restored.query(
          'SELECT messages FROM local_ai_threads',
        );
        expect(threads.rows).toHaveLength(1);
        expect(threads.rows[0].messages).toHaveLength(2);
        expect(JSON.stringify(threads.rows)).toContain('Retained answer');
        expect(
          (
            await restored.query(
              "SELECT count(*)::int AS n FROM memory_jobs WHERE state IN ('queued','running')",
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        await restored.end();
      }
    } finally {
      await f?.disconnect();
      if (f) {
        await rm(f.root, { recursive: true, force: true });
        await rm(f.root + '-offline', { recursive: true, force: true });
      }
      if (restoredName && /^dots_restore_[a-f0-9]{32}$/.test(restoredName))
        await admin.query(`DROP DATABASE "${restoredName}" WITH (FORCE)`);
      await admin.query(`DROP DATABASE "${sourceName}" WITH (FORCE)`);
      await admin.end();
      await rm(recovery, { recursive: true, force: true });
    }
  },
  30000,
);
