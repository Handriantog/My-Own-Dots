import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readArchive, writeArchive } from '../../server/storage/archive.js';
import { RestoreService } from '../../server/storage/restore.js';
import { MigrationService } from '../../server/storage/migration-service.js';
import type {
  ArchiveWorkerCommand,
  ArchiveWorkerResult,
} from './archive-worker-client.js';

const controller = new AbortController();
let started = false;
let quiesced: (() => void) | undefined;
process.on('disconnect', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
function phase(phase: 'archive' | 'verify') {
  process.send?.({ type: 'phase', phase });
}
async function execute(
  command: ArchiveWorkerCommand,
): Promise<ArchiveWorkerResult> {
  const signal = controller.signal;
  if (command.kind === 'backup') {
    let published = false;
    let verified = false;
    const staging = await mkdtemp(
      join(dirname(command.destination), '.dot-verify-'),
    );
    try {
      phase('archive');
      await writeArchive({ ...command, signal });
      published = true;
      phase('verify');
      const manifest = await readArchive({
        source: command.destination,
        stagingDirectory: join(staging, 'contents'),
        passphrase: command.passphrase,
        signal,
      });
      if (!isDeepStrictEqual(manifest, command.manifest))
        throw new Error('Verification mismatch');
      signal.throwIfAborted();
      verified = true;
      return {
        verified: true,
        managed: true,
        id: manifest.archiveId,
        createdAt: manifest.createdAt,
        coverage: manifest.coverage,
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
      if (published && !verified)
        await rm(command.destination, { force: true });
    }
  }
  const stopWorkspace = () =>
    new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => reject(new Error('Cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      quiesced = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      process.send?.({ type: 'quiesce' });
    });
  if (
    command.kind === 'migration-preview' ||
    command.kind === 'migration-activate'
  ) {
    phase('verify');
    const migration = new MigrationService({
      profile: command.profile,
      stopWorkspace,
    });
    return command.kind === 'migration-preview'
      ? migration.prepare({ ...command, signal })
      : migration.activate(command.operationId, signal);
  }
  const service = new RestoreService({
    profile: command.profile,
    stopWorkspace,
    preRestoreBackup:
      command.kind === 'activate' && command.verifiedBackupDirectory
        ? async () => ({
            verified: true,
            directory: command.verifiedBackupDirectory!,
          })
        : undefined,
  });
  phase('verify');
  if (command.kind === 'preview')
    return service.prepareRestore({ ...command, signal });
  if (command.kind === 'activate')
    return service.activateRestore(command.operationId, command.mode, signal);
  if (command.kind === 'discard') {
    await service.discardRestore(command.operationId, signal);
    return { discarded: true };
  }
  await service.recover();
  return { recovered: true };
}
process.on(
  'message',
  (message: { type?: string; command?: ArchiveWorkerCommand }) => {
    if (message.type === 'cancel') {
      controller.abort();
      return;
    }
    if (message.type === 'quiesced') {
      quiesced?.();
      return;
    }
    if (message.type !== 'run' || !message.command || started) return;
    started = true;
    void execute(message.command).then(
      (result) =>
        process.send?.({ type: 'result', result }, () =>
          process.disconnect?.(),
        ),
      () =>
        process.send?.(
          {
            type: 'error',
            error: controller.signal.aborted
              ? 'Storage operation cancelled'
              : 'Storage operation failed. Check the recovery password, destination and database access.',
          },
          () => process.disconnect?.(),
        ),
    );
  },
);
