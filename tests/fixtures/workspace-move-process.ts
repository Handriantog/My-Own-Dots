import {
  WorkspaceMoveService,
  type WorkspaceMoveSource,
} from '../../src/server/storage/workspace-move.js';
setInterval(() => {}, 1000);
process.once(
  'message',
  async (input: {
    profile: string;
    source: WorkspaceMoveSource;
    destination: string;
    crashAt: string;
  }) => {
    try {
      const service = new WorkspaceMoveService({
        profile: input.profile,
        stopWorkspace: async () => {},
        onPhase: async (operationId, phase) => {
          if (phase === input.crashAt) {
            process.send?.({ operationId });
            await new Promise(() => {});
          }
        },
      });
      const signal = new AbortController().signal;
      const preview = await service.prepare({ ...input, signal });
      await service.activate(preview.operationId, signal);
    } catch (error) {
      process.send?.({
        error: error instanceof Error ? error.message : 'Move failed',
      });
    }
  },
);
