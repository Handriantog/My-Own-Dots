import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RestoreService } from '../../src/server/storage/restore.js';

// Stay alive while the parent observes the boundary and explicitly kills us.
setInterval(() => {}, 1000);

process.once('message', async (value: unknown) => {
  const input = value as {
    profile: string;
    archive: string;
    passphrase: string;
    destination: string;
    postgresTarget: string;
    crashAt: string;
  };
  try {
    const service = new RestoreService({
      profile: input.profile,
      stopWorkspace: async () => {},
      onPhase: async (operationId, phase) => {
        const databaseBoundary =
          input.crashAt === 'database' &&
          phase === 'staging' &&
          JSON.parse(
            await readFile(
              join(input.profile, 'restore-journals', operationId + '.json'),
              'utf8',
            ),
          ).postgresOid;
        if (phase === input.crashAt || databaseBoundary) {
          process.send?.({ operationId, phase });
          await new Promise(() => {});
        }
      },
    });
    const preview = await service.prepareRestore({
      ...input,
      signal: new AbortController().signal,
    });
    await service.activateRestore(
      preview.operationId,
      'new',
      new AbortController().signal,
    );
  } catch (error) {
    process.send?.({
      error: error instanceof Error ? error.message : 'Restore failed',
    });
    process.exitCode = 1;
  }
});
