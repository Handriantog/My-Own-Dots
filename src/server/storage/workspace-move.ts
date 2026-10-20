import { randomBytes, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual, parseEnv } from 'node:util';
import {
  createWorkspaceManifest,
  readWorkspaceManifest,
  sqliteStorageSchema,
} from '../../shared/workspace-manifest.js';
import { claimWorkspaceDatabase } from '../workspace-identity.js';
import { validateArchivePaths } from './archive-paths.js';
import {
  atomicStorageWrite,
  fileSeal,
  loadJournal,
  readSelection,
  saveJournal,
  withRestoreLock,
  type RestoreJournal,
} from './restore-journal.js';
import { RestoreService, type RestorePreview } from './restore.js';
import { restoreSQLite } from './restore-sqlite.js';

export interface WorkspaceMoveSource {
  directory: string;
  sqlitePath: string;
}
interface Options {
  profile: string;
  stopWorkspace(): Promise<void>;
  onPhase?: (
    operationId: string,
    phase: RestoreJournal['phase'],
  ) => void | Promise<void>;
}
/** An offline, verified copy of core content. The source directory is never removed. */
export class WorkspaceMoveService {
  constructor(private options: Options) {}
  private async identity(source: WorkspaceMoveSource) {
    if (![source.directory, source.sqlitePath].every(isAbsolute))
      throw new Error('Workspace move paths must be absolute');
    const directory = await realpath(source.directory),
      database = await realpath(source.sqlitePath);
    const databasePath = relative(directory, database).split(sep).join('/');
    validateArchivePaths([databasePath]);
    if (!(await stat(database)).isFile())
      throw new Error('Workspace database is unavailable');
    const manifest = await readWorkspaceManifest(directory);
    if (
      manifest?.storage !== 'sqlite' ||
      manifest.schema !== sqliteStorageSchema
    )
      throw new Error('Migrate this workspace to SQLite before moving it');
    return { directory, database, databasePath, manifest };
  }
  private async inventory(source: WorkspaceMoveSource, signal: AbortSignal) {
    const identity = await this.identity(source);
    if ((await stat(identity.database + '-wal').catch(() => undefined))?.size)
      throw new Error(
        'Workspace database was not fully closed; reopen and stop it before moving',
      );
    const paths = ['.env', 'workspace.json', identity.databasePath];
    const visit = async (prefix: string) => {
      const folder = await lstat(join(identity.directory, prefix)).catch(
        (error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
          throw error;
        },
      );
      if (!folder) return;
      if (!folder.isDirectory())
        throw new Error('Workspace files cannot contain symbolic links');
      for (const entry of await readdir(join(identity.directory, prefix), {
        withFileTypes: true,
      })) {
        signal.throwIfAborted();
        const path = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) paths.push(path);
        else
          throw new Error(
            'Workspace files cannot contain symbolic links or special files',
          );
      }
    };
    await visit('files');
    await visit('recovery');
    paths.sort();
    validateArchivePaths(paths);
    const files = [];
    for (const path of paths)
      files.push({
        path,
        sha256: await fileSeal(join(identity.directory, path), signal),
      });
    return { ...identity, files };
  }
  private async phase(journal: RestoreJournal, phase: RestoreJournal['phase']) {
    journal.phase = phase;
    await saveJournal(this.options.profile, journal);
    await this.options.onPhase?.(journal.operationId, phase);
  }
  async prepare(input: {
    source: WorkspaceMoveSource;
    destination: string;
    signal: AbortSignal;
  }): Promise<RestorePreview> {
    const { source, destination, signal } = input;
    if (!isAbsolute(destination))
      throw new Error('Choose an absolute move destination');
    const identity = await this.identity(source);
    const target = join(
      await realpath(dirname(destination)),
      relative(dirname(destination), destination),
    );
    const within = relative(identity.directory, target);
    if (
      !within ||
      (!within.startsWith('..' + sep) && within !== '..' && !isAbsolute(within))
    )
      throw new Error('Choose a destination outside the existing workspace');
    await this.options.stopWorkspace();
    const release = claimWorkspaceDatabase(source.sqlitePath);
    let operationId: string | undefined;
    try {
      return await withRestoreLock(this.options.profile, async () => {
        const original = await this.inventory(source, signal);
        const selected = await readSelection(this.options.profile);
        if (
          selected &&
          (await realpath(JSON.parse(selected).directory)) !==
            original.directory
        )
          throw new Error('Selected workspace changed');
        await mkdir(destination, { mode: 0o700 });
        operationId = randomUUID();
        const artifacts = original.files
          .filter(
            (file) =>
              file.path.startsWith('files/') ||
              file.path.startsWith('recovery/'),
          )
          .map((file) => ({
            ...file,
            target: file.path.startsWith('recovery/')
              ? 'recovery/prior/' + file.path.slice(9)
              : file.path,
          }));
        const journal: RestoreJournal = {
          version: 1,
          operationId,
          phase: 'staging',
          createdAt: Date.now(),
          directory: destination,
          previousSelection: selected,
          storage: 'sqlite',
          files: [],
          movement: {
            directory: original.directory,
            sqlitePath: original.database,
            workspaceId: original.manifest.id,
            files: original.files,
            targetPaths: artifacts.map((file) => file.target),
          },
        };
        await writeFile(join(destination, '.restore-owner'), operationId, {
          flag: 'wx',
          mode: 0o600,
        });
        await this.phase(journal, 'staging');
        for (const folder of ['data', 'files', 'recovery', 'snapshot/core'])
          await mkdir(join(destination, folder), {
            recursive: true,
            mode: 0o700,
          });
        const copy = async (from: string, to: string, expected: string) => {
          signal.throwIfAborted();
          await mkdir(dirname(to), { recursive: true, mode: 0o700 });
          await copyFile(from, to, 1);
          const file = await open(to, 'r');
          try {
            await file.sync();
          } finally {
            await file.close();
          }
          if ((await fileSeal(to, signal)) !== expected)
            throw new Error('Workspace source changed while copying');
        };
        const snapshot = join(destination, 'snapshot/core/workspace.sqlite');
        await copy(
          original.database,
          snapshot,
          original.files.find((file) => file.path === original.databasePath)!
            .sha256,
        );
        const restored = await restoreSQLite(
          snapshot,
          join(destination, 'data/opendots.sqlite'),
          original.manifest.ownerId,
          signal,
          'sqlite',
        );
        for (const file of artifacts)
          await copy(
            join(original.directory, file.path),
            join(destination, file.target),
            file.sha256,
          );
        await createWorkspaceManifest(destination, original.manifest);
        const configuration = await readFile(
          join(original.directory, '.env'),
          'utf8',
        );
        const values = {
          ...parseEnv(configuration),
          DATABASE_PATH: 'data/opendots.sqlite',
          // The retained original has the same workspace ID. A distinct token
          // prevents auto-attachment to its backend after the copy is selected.
          OWNER_TOKEN: randomBytes(32).toString('hex'),
        };
        const movedConfiguration = Object.entries(values)
          .map(([key, value]) => {
            const quote = ["'", '"', '`'].find(
              (candidate) =>
                !value.includes(candidate) &&
                parseEnv(`VALUE=${candidate}${value}${candidate}`).VALUE ===
                  value,
            );
            if (!quote)
              throw new Error('Unsupported workspace configuration value');
            return `${key}=${quote}${value}${quote}\n`;
          })
          .join('');
        await atomicStorageWrite(join(destination, '.env'), movedConfiguration);
        if (
          !isDeepStrictEqual(
            (await this.inventory(source, signal)).files,
            original.files,
          )
        )
          throw new Error('Workspace source changed while copying');
        for (const path of [
          '.restore-owner',
          '.env',
          'workspace.json',
          'data/opendots.sqlite',
          'snapshot/core/workspace.sqlite',
          'recovery/access-audit.jsonl',
          ...artifacts.map((file) => file.target),
        ])
          journal.files.push({
            path,
            sha256: await fileSeal(join(destination, path), signal),
          });
        journal.verifiedAt = Date.now();
        await this.phase(journal, 'verified');
        return {
          operationId,
          destination,
          workspaceId: original.manifest.id,
          expiresAt: journal.verifiedAt + 15 * 60_000,
          counts: restored.counts,
          coverage: [
            { component: 'core-sqlite', state: 'included' },
            { component: 'managed-files', state: 'included' },
          ],
          warnings: [
            'The original workspace stays in place. Schedules are paused and external access needs fresh approval.',
            'Provider logins, integration runtimes and optional computer volumes stay at their original locations.',
          ],
        };
      });
    } catch (error) {
      if (operationId)
        await new RestoreService(this.options)
          .discardRestore(operationId, new AbortController().signal)
          .catch(() => {});
      throw error;
    } finally {
      release();
    }
  }
  async activate(operationId: string, signal: AbortSignal) {
    const journal = await loadJournal(this.options.profile, operationId),
      proof = journal.movement;
    if (
      !proof ||
      journal.phase !== 'verified' ||
      Date.now() - (journal.verifiedAt ?? journal.createdAt) > 15 * 60_000
    )
      throw new Error('Workspace move preview expired or unavailable');
    if (
      (await readSelection(this.options.profile)) !== journal.previousSelection
    )
      throw new Error('Selected workspace changed');
    await this.identity(proof);
    await this.options.stopWorkspace();
    const release = claimWorkspaceDatabase(proof.sqlitePath);
    try {
      const current = await this.inventory(proof, signal);
      if (
        current.manifest.id !== proof.workspaceId ||
        !isDeepStrictEqual(current.files, proof.files)
      )
        throw new Error('Workspace source changed; prepare a fresh move');
      return await new RestoreService({
        ...this.options,
        stopWorkspace: async () => {},
        movementAuthorized: true,
      }).activateRestore(operationId, 'new', signal);
    } finally {
      release();
    }
  }
}
