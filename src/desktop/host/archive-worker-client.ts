import { fork } from 'node:child_process';
import { dirname } from 'node:path';
import type { ArchiveManifest } from '../../shared/storage-archive.js';
import type { MigrationSource } from '../../server/storage/migration-service.js';
import type { WorkspaceMoveSource } from '../../server/storage/workspace-move.js';
import type {
  StorageOperationStatus,
  StorageRestorePreview,
} from '../shared/storage-contract.js';
export type ArchiveWorkerCommand =
  | {
      kind: 'move-preview';
      profile: string;
      source: WorkspaceMoveSource;
      destination: string;
    }
  | { kind: 'move-activate'; profile: string; operationId: string }
  | {
      kind: 'migration-preview';
      profile: string;
      source: MigrationSource;
      destination: string;
      backupDestination: string;
      passphrase: string;
    }
  | { kind: 'migration-activate'; profile: string; operationId: string }
  | {
      kind: 'backup';
      sourceDirectory: string;
      destination: string;
      manifest: ArchiveManifest;
      passphrase: string;
    }
  | {
      kind: 'preview';
      profile: string;
      archive: string;
      passphrase: string;
      destination: string;
      postgresTarget?: string;
    }
  | {
      kind: 'activate';
      profile: string;
      operationId: string;
      mode: 'new' | 'replace';
      verifiedBackupDirectory?: string;
    }
  | { kind: 'recover'; profile: string }
  | { kind: 'discard'; profile: string; operationId: string };
export type ArchiveWorkerResult =
  | {
      verified: true;
      id: string;
      createdAt: string;
      managed: true;
      coverage: ArchiveManifest['coverage'];
    }
  | StorageRestorePreview
  | { workspaceDirectory: string }
  | { recovered: true }
  | { discarded: true };
export interface ArchiveWorkerPort {
  run(
    command: ArchiveWorkerCommand,
    options: {
      signal: AbortSignal;
      phase?: (phase: StorageOperationStatus['phase']) => void;
      stopWorkspace?: () => Promise<void>;
    },
  ): Promise<ArchiveWorkerResult>;
}
/** No password in argv, environment, logs or disk. Commands use private parent/child IPC. */
export class ArchiveWorkerClient implements ArchiveWorkerPort {
  constructor(
    private readonly options: {
      entry: string;
      execArgv?: string[];
      executable?: string;
    },
  ) {}
  run(
    command: ArchiveWorkerCommand,
    options: Parameters<ArchiveWorkerPort['run']>[1],
  ): Promise<ArchiveWorkerResult> {
    options.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = fork(this.options.entry, [], {
        cwd: dirname(this.options.entry),
        execPath: this.options.executable ?? process.execPath,
        execArgv: this.options.execArgv ?? [],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let result: ArchiveWorkerResult | undefined;
      let error: Error | undefined;
      let kill: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        error = new Error('Storage operation cancelled');
        if (child.connected) child.send({ type: 'cancel' }, () => {});
        kill ??= setTimeout(() => child.kill('SIGKILL'), 10000);
      };
      options.signal.addEventListener('abort', cancel, { once: true });
      child.on(
        'message',
        (packet: {
          type?: string;
          phase?: StorageOperationStatus['phase'];
          result?: ArchiveWorkerResult;
          error?: string;
        }) => {
          if (packet.type === 'phase' && packet.phase)
            options.phase?.(packet.phase);
          else if (packet.type === 'quiesce') {
            void Promise.resolve()
              .then(() => {
                options.signal.throwIfAborted();
                if (!options.stopWorkspace)
                  throw new Error('Workspace shutdown is unavailable');
                return options.stopWorkspace();
              })
              .then(
                () => {
                  if (child.connected)
                    child.send({ type: 'quiesced' }, () => {});
                },
                () => {
                  error = new Error('Could not close the active workspace');
                  cancel();
                },
              );
          } else if (packet.type === 'result') result = packet.result;
          else if (packet.type === 'error')
            error = new Error(packet.error || 'Storage operation failed');
        },
      );
      child.once('error', () => {
        error = new Error('Storage worker could not start');
      });
      child.once('close', (code) => {
        options.signal.removeEventListener('abort', cancel);
        clearTimeout(kill);
        if (options.signal.aborted)
          reject(new Error('Storage operation cancelled'));
        else if (error || code !== 0 || !result)
          reject(
            error ?? new Error('Storage worker stopped before verification'),
          );
        else resolve(result);
      });
      child.send({ type: 'run', command }, (failure) => {
        if (failure) {
          error = new Error('Storage worker could not start');
          child.kill();
        }
      });
      if (options.signal.aborted) cancel();
    });
  }
}
