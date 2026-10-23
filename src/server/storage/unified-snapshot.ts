import { captureAbilityState } from './ability-snapshot.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ArchiveEntry,
  ArchiveManifest,
} from '../../shared/storage-archive.js';
import { sqliteStorageSchema } from './sqlite-schema.js';
import type { StorageClient } from './storage-client.js';
import type { MaintenanceGate } from './maintenance.js';
import type { SnapshotSource } from './legacy-snapshot.js';
interface Options {
  storage: StorageClient;
  sqlitePath: string;
  ownerId: string;
  workspaceId: string;
  gate: MaintenanceGate;
  configurationPath?: string;
  quiesceAbilities?(): Promise<() => Promise<void>>;
}
export class UnifiedSnapshotSource implements SnapshotSource {
  private configuration?: Buffer;
  constructor(private options: Options) {
    if (
      options.storage.engine !== 'sqlite' ||
      options.storage.ownerId !== options.ownerId
    )
      throw new Error('Unified snapshot requires the owned SQLite worker');
    if (options.configurationPath) {
      this.configuration = readFileSync(options.configurationPath);
      if (this.configuration.length > 1024 * 1024)
        throw new Error('Workspace configuration exceeds limit');
    }
  }
  private async unchanged() {
    if (
      this.options.configurationPath &&
      !(await readFile(this.options.configurationPath)).equals(
        this.configuration!,
      )
    )
      throw new Error(
        'Workspace configuration changed; reconnect before taking a backup',
      );
  }
  async activity() {
    const { gate, sqlitePath, configurationPath } = this.options;
    const idle = () =>
      !gate.closing && !gate.status().held && gate.status().activeWrites === 0;
    if (!idle()) return { idle: false, revision: 'busy' };
    const files = await Promise.all(
      [
        sqlitePath,
        sqlitePath + '-wal',
        ...(configurationPath ? [configurationPath] : []),
      ].map(async (path) => {
        try {
          const value = await stat(path, { bigint: true });
          return [
            path,
            String(value.size),
            String(value.mtimeNs),
            String(value.ino),
          ];
        } catch (error) {
          if (
            path.endsWith('-wal') &&
            (error as NodeJS.ErrnoException).code === 'ENOENT'
          )
            return [path, 'absent'];
          throw error;
        }
      }),
    );
    return {
      idle: idle(),
      revision: createHash('sha256')
        .update(JSON.stringify(files))
        .digest('hex'),
    };
  }
  async capture(
    directory: string,
    signal: AbortSignal,
    origin: 'manual' | 'automatic' = 'manual',
  ): Promise<ArchiveManifest> {
    await this.unchanged();
    const lease = await this.options.gate.acquire({ origin, signal });
    signal = lease.signal;
    let resumeAbilities: (() => Promise<void>) | undefined;
    let created = false;
    try {
      signal.throwIfAborted();
      resumeAbilities = await this.options.quiesceAbilities?.();
      await mkdir(directory, { mode: 0o700 });
      created = true;
      await mkdir(join(directory, 'core'), { mode: 0o700 });
      await mkdir(join(directory, 'recovery'), { mode: 0o700 });
      await this.options.storage.call(
        'snapshot.capture',
        [join(directory, 'core/workspace.sqlite')],
        { signal, priority: 'background' },
      );
      const file = await open(
        join(directory, 'recovery/configuration.json'),
        'wx',
        0o600,
      );
      try {
        await file.writeFile(
          JSON.stringify({
            version: 1,
            activatable: false,
            configuration: this.configuration?.toString('utf8') ?? null,
            notice:
              'Host secrets and paths are recovery evidence only. Do not apply this configuration automatically.',
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await this.unchanged();
      const entries: ArchiveEntry[] = [];
      for (const path of [
        'core/workspace.sqlite',
        'recovery/configuration.json',
      ]) {
        const source = await open(join(directory, path), 'r');
        const hash = createHash('sha256');
        let bytes = 0;
        try {
          for await (const chunk of source.createReadStream({
            autoClose: false,
          })) {
            signal.throwIfAborted();
            hash.update(chunk);
            bytes += chunk.length;
          }
        } finally {
          await source.close();
        }
        entries.push({ path, bytes, sha256: hash.digest('hex') });
      }
      if (
        !this.options.quiesceAbilities &&
        (await stat(
          join(dirname(this.options.sqlitePath), 'abilities/state'),
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        }))
      )
        throw new Error('Ability host must confirm shutdown before capture');
      const abilities = await captureAbilityState(
        dirname(this.options.sqlitePath),
        directory,
        signal,
      );
      entries.push(...abilities.entries);
      signal.throwIfAborted();
      return {
        ...(abilities.entries.length
          ? {
              version: 3 as const,
              minimumReader: 3 as const,
              abilities: { version: 1 as const },
            }
          : { version: 2 as const, minimumReader: 2 as const }),
        kind: 'workspace-backup',
        storage: { engine: 'sqlite', schema: sqliteStorageSchema },
        archiveId: randomUUID(),
        workspaceId: this.options.workspaceId,
        ownerId: this.options.ownerId,
        createdAt: new Date().toISOString(),
        entries,
        coverage: [
          { component: 'core-sqlite', state: 'included' },
          { component: 'local-conversations-memory', state: 'included' },
          { component: 'recovery-configuration', state: 'included' },
          ...(abilities.entries.length
            ? [
                {
                  component: 'ability-private-state',
                  state: 'included' as const,
                },
                {
                  component: 'ability-credentials-and-executables',
                  state: 'excluded' as const,
                  reason:
                    'Account credentials stay on this desktop. Packages require digest verification and fresh consent.',
                },
              ]
            : []),
          {
            component: 'computer-volumes',
            state: 'excluded',
            reason:
              'Computer files and browser profiles require their own verified snapshot.',
          },
        ],
      };
    } catch (error) {
      if (created) await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      try {
        await resumeAbilities?.();
      } finally {
        lease.release();
      }
    }
  }
}
