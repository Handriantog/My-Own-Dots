import type { EvidenceGuard, SourceRef } from '../../src/shared/memory.js';
export const testGuard: EvidenceGuard = {
  originDotId: 'dot',
  spaceIds: [],
  pageIds: [],
};
export function sourceRef(patch: Partial<SourceRef> = {}): SourceRef {
  return {
    threadId: 'thread',
    runId: 'run',
    messageIds: ['user'],
    contentHash: 'a'.repeat(64),
    guard: testGuard,
    ...patch,
  };
}

export async function publicationFixture() {
  const { WorkspaceStore } = await import('../../src/server/workspace.js');
  const { Store } = await import('../../src/server/store.js');
  const { MemoryAccess } = await import('../../src/server/memory-access.js');
  const { MemoryRecall } = await import('../../src/server/memory-recall.js');
  const { evidenceHash } =
    await import('../../src/server/conversation-memory.js');
  const workspace = new WorkspaceStore(':memory:', 'owner'),
    store = new Store(':memory:');
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Evidence');
  const records = new Map<
    string,
    import('../../src/server/conversation-memory.js').SourceRecord
  >();
  const add = (
    text: string,
    runId = 'run',
    role = 'user',
    toolCallId?: string,
  ) => {
    const message = {
      id: runId + '-message',
      role,
      content: text,
      ...(toolCallId ? { toolCallId } : {}),
    };
    const source = sourceRef({
      runId,
      messageIds: [message.id],
      contentHash: evidenceHash(message),
      guard: { originDotId: dot.id, spaceIds: [], pageIds: [] },
      start: 0,
      end: text.length,
    });
    const id = evidenceHash(['owner', 'thread', runId, message.id, 0]);
    const record = {
      id,
      ownerId: 'owner',
      source,
      guard: source.guard,
      text,
      role,
      createdAt: 1,
      workflowComplete: true,
    };
    records.set(id, record);
    return { record, message };
  };
  const episodes = {
    generation: async () => 0,
    coverage: async () => ({ indexedRuns: 0, eligibleRuns: 0, complete: true }),
    searchEpisodes: async () => ({
      matches: [],
      coverage: { indexedRuns: 0, eligibleRuns: 0, complete: true },
    }),
    sourceById: async (id: string) => records.get(id),
    readSource: async (ref: SourceRef) =>
      [...records.values()].find(
        (s) =>
          s.source.contentHash === ref.contentHash &&
          s.source.runId === ref.runId,
      ),
  };
  const access = new MemoryAccess(workspace, store),
    recall = new MemoryRecall(workspace.memory, episodes, access);
  return {
    workspace,
    store,
    dot,
    records,
    add,
    recall,
    close: () => {
      workspace.close();
      store.close();
    },
  };
}
