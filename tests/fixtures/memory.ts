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
