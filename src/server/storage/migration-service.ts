import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual, parseEnv } from 'node:util';
import { readWorkspaceManifest } from '../../shared/workspace-manifest.js';
import {
  claimWorkspaceDatabase,
  workspaceIdentity,
} from '../workspace-identity.js';
import { LegacySnapshotSource } from './legacy-snapshot.js';
import { MaintenanceGate } from './maintenance.js';
import { writeArchive, readArchive } from './archive.js';
import { migrateLegacySnapshot } from './migrate-workspace.js';
import { createMigrationScratch } from './migration-scratch.js';
import { RestoreService, type RestorePreview } from './restore.js';
import {
  fileSeal,
  loadJournal,
  readSelection,
  type MigrationProof,
  type RestoreJournal,
} from './restore-journal.js';
export type MigrationSource = MigrationProof['source'];
interface Options {
  profile: string;
  stopWorkspace(): Promise<void>;
  onPhase?: (
    operationId: string,
    phase: RestoreJournal['phase'],
  ) => void | Promise<void>;
}
export class MigrationService {
  constructor(private options: Options) {}
  private async sourceIdentity(source: MigrationSource) {
    for (const path of [
      source.directory,
      source.sqlitePath,
      source.configurationPath,
    ])
      if (!isAbsolute(path))
        throw new Error('Migration source paths must be absolute');
    // A missing source is never initialized as an empty replacement.
    if (!(await stat(source.sqlitePath)).isFile())
      throw new Error('Migration source database is unavailable');
    const manifest = await readWorkspaceManifest(source.directory);
    if (
      manifest &&
      (manifest.storage !== 'legacy-postgres' ||
        manifest.schema !== 1 ||
        manifest.ownerId !== source.ownerId)
    )
      throw new Error('Migration source identity or schema changed');
    if (
      (manifest?.id ?? workspaceIdentity(source.sqlitePath)) !==
      source.workspaceId
    )
      throw new Error('Migration source identity changed');
    const configuration = await readFile(source.configurationPath, 'utf8');
    const env = parseEnv(configuration);
    if (
      (env.OWNER_ID && env.OWNER_ID !== source.ownerId) ||
      !env.LOCAL_DATABASE_URL ||
      new URL(env.LOCAL_DATABASE_URL).href !== new URL(source.postgresUrl).href
    )
      throw new Error('Migration source configuration changed');
    return { manifest, configuration };
  }
  private capture(
    source: MigrationSource,
    directory: string,
    signal: AbortSignal,
  ) {
    return new LegacySnapshotSource({
      ...source,
      gate: new MaintenanceGate(),
      // Both callers stopped the desktop/backend and hold the source ownership claim.
      quiesceAbilities: async () => async () => {},
      owned: true,
      conversationBackend: 'local',
    }).capture(directory, signal);
  }
  async prepare(input: {
    source: MigrationSource;
    destination: string;
    backupDestination: string;
    passphrase: string;
    signal: AbortSignal;
  }): Promise<RestorePreview> {
    const { source, signal } = input;
    signal.throwIfAborted();
    if (!isAbsolute(input.destination) || !isAbsolute(input.backupDestination))
      throw new Error('Migration destinations must be absolute');
    const sourceRoot = await realpath(source.directory);
    for (const path of [input.destination, input.backupDestination]) {
      const destination = join(await realpath(dirname(path)), basename(path));
      const within = relative(sourceRoot, destination);
      if (
        !within ||
        (within !== '..' &&
          !within.startsWith('..' + sep) &&
          !isAbsolute(within))
      )
        throw new Error(
          'Choose migration and backup destinations outside the original workspace',
        );
    }
    await this.sourceIdentity(source);
    const selection = await readSelection(this.options.profile);
    if (
      selection &&
      (await realpath(JSON.parse(selection).directory)) !== sourceRoot
    )
      throw new Error('Selected workspace changed');
    await this.options.stopWorkspace();
    await mkdir(this.options.profile, { recursive: true, mode: 0o700 });
    const release = claimWorkspaceDatabase(source.sqlitePath);
    let temporary: string | undefined;
    try {
      const identity = await this.sourceIdentity(source);
      const configurationSeal = createHash('sha256')
        .update(identity.configuration)
        .digest('hex');
      temporary = await createMigrationScratch(this.options.profile);
      const capture = join(temporary, 'capture');
      const manifest = await this.capture(source, capture, signal);
      await writeArchive({
        sourceDirectory: capture,
        destination: input.backupDestination,
        manifest,
        passphrase: input.passphrase,
        signal,
      });
      const verified = await readArchive({
        source: input.backupDestination,
        stagingDirectory: join(temporary, 'verify'),
        passphrase: input.passphrase,
        signal,
      });
      if (!isDeepStrictEqual(manifest, verified))
        throw new Error('Pre-migration backup verification failed');
      if (
        (await fileSeal(source.configurationPath, signal)) !== configurationSeal
      )
        throw new Error('Migration source configuration changed');
      const proof: MigrationProof = {
        source,
        backup: {
          path: input.backupDestination,
          sha256: await fileSeal(input.backupDestination, signal),
        },
        configurationSeal,
        targetWorkspaceId: identity.manifest?.id ?? randomUUID(),
      };
      const service = new RestoreService({
        ...this.options,
        migration: { proof, configuration: identity.configuration },
      });
      return await service.prepareRestore({
        archive: input.backupDestination,
        passphrase: input.passphrase,
        destination: input.destination,
        signal,
      });
    } finally {
      try {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      } finally {
        release();
      }
    }
  }
  async activate(operationId: string, signal: AbortSignal) {
    const journal = await loadJournal(this.options.profile, operationId);
    const proof = journal.migration;
    if (
      !proof ||
      journal.phase !== 'verified' ||
      Date.now() - (journal.verifiedAt ?? journal.createdAt) > 15 * 60_000
    )
      throw new Error('Migration preview expired or unavailable');
    if (
      (await readSelection(this.options.profile)) !== journal.previousSelection
    )
      throw new Error('Selected workspace changed');
    if ((await fileSeal(proof.backup.path, signal)) !== proof.backup.sha256)
      throw new Error('Pre-migration backup changed');
    if (
      (await fileSeal(proof.source.configurationPath, signal)) !==
      proof.configurationSeal
    )
      throw new Error('Migration source configuration changed');
    await this.sourceIdentity(proof.source);
    await this.options.stopWorkspace();
    const release = claimWorkspaceDatabase(proof.source.sqlitePath);
    let temporary: string | undefined;
    try {
      await this.sourceIdentity(proof.source);
      // Verify current canonical content while retaining exclusive source ownership
      // through the journaled switch. A resumed legacy backend cannot lose new writes.
      temporary = await createMigrationScratch(this.options.profile);
      const capture = join(temporary, 'capture');
      await this.capture(proof.source, capture, signal);
      await mkdir(join(temporary, 'data'));
      await mkdir(join(temporary, 'recovery'));
      const current = await migrateLegacySnapshot({
        directory: capture,
        destination: join(temporary, 'data/opendots.sqlite'),
        ownerId: proof.source.ownerId,
        signal,
      });
      const prepared = JSON.parse(
        await readFile(
          join(journal.directory, 'recovery/migration-verification.json'),
          'utf8',
        ),
      );
      if (!isDeepStrictEqual(current.verification, prepared.verification))
        throw new Error(
          'Migration source changed; create a fresh preview and backup',
        );
      if (
        (await fileSeal(proof.source.configurationPath, signal)) !==
          proof.configurationSeal ||
        (await fileSeal(proof.backup.path, signal)) !== proof.backup.sha256
      )
        throw new Error('Migration source or backup changed');
      await this.sourceIdentity(proof.source);
      return await new RestoreService({
        ...this.options,
        stopWorkspace: async () => {},
        migrationAuthorized: true,
      }).activateRestore(operationId, 'new', signal);
    } finally {
      try {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      } finally {
        release();
      }
    }
  }
}
