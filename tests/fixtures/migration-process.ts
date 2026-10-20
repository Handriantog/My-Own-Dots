import {
  MigrationService,
  type MigrationSource,
} from '../../src/server/storage/migration-service.js';
setInterval(() => {}, 1000);
process.once(
  'message',
  async (input: {
    source: MigrationSource;
    profile: string;
    destination: string;
    backupDestination: string;
    passphrase: string;
    crashAt: string;
  }) => {
    try {
      const service = new MigrationService({
        profile: input.profile,
        stopWorkspace: async () => {},
        onPhase: async (operationId, phase) => {
          if (phase === input.crashAt) {
            process.send?.({ operationId, phase });
            await new Promise(() => {});
          }
        },
      });
      const signal = new AbortController().signal;
      const preview = await service.prepare({ ...input, signal });
      await service.activate(preview.operationId, signal);
    } catch (error) {
      process.send?.({
        error: error instanceof Error ? error.message : 'Migration failed',
      });
      process.exitCode = 1;
    }
  },
);
