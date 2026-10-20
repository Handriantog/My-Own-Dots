import type { Store } from '../store.js';
import type { WorkspaceStore } from '../workspace.js';
import type { ConnectionStore } from '../connection-store.js';
import type { FolderAccessService } from '../folder-access.js';
import type { AsyncRepository, AsyncWorkspace } from './repository-contract.js';
/** Runtime always awaits these contracts; synchronous implementations remain useful for isolated repository tests. */
export type StoreRepository = Store | AsyncRepository<'store'>;
export type WorkspaceRepository = WorkspaceStore | AsyncWorkspace;
export type ConnectionRepository =
  ConnectionStore | AsyncRepository<'connections'>;
export type FolderRepository = FolderAccessService | AsyncRepository<'folders'>;
import type { MemoryRecall } from '../memory-recall.js';
import type { ConversationEvidenceRepository } from '../conversation-memory.js';
import type { MemoryAccess } from '../memory-access.js';
export type EvidenceRepository = ConversationEvidenceRepository & {
  workspace: WorkspaceRepository;
  memoryEnabled(): boolean | Promise<boolean>;
};
export type RecallRepository = Pick<
  MemoryRecall,
  'search' | 'read' | 'readSource'
> & {
  memory: WorkspaceRepository['memory'];
  episodes: Pick<
    ConversationEvidenceRepository,
    'generation' | 'coverage' | 'searchEpisodes' | 'sourceById' | 'readSource'
  >;
  access: (
    | Pick<MemoryAccess, 'forDot' | 'canRead' | 'guardAllowed'>
    | AsyncRepository<'access'>
  ) & {
    store: StoreRepository;
    workspace: WorkspaceRepository;
  };
};
