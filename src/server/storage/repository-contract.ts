import type { RuntimePolicy } from './runtime-policy.js';
import type { VoiceDelegations } from './voice-delegations.js';
import type { MemoryJobRepository } from '../memory-jobs.js';
import type { SQLiteSnapshot } from './sqlite-snapshot.js';
import type { MemoryAccess } from '../memory-access.js';
import type { DreamPublication } from '../dream-publication.js';
import type { ContextBuilder } from '../context-builder.js';
import type { SQLiteEvidence } from './sqlite-evidence.js';
import type { SQLiteJobs } from './sqlite-jobs.js';
import type { MemoryRecall } from '../memory-recall.js';
import type { SQLiteConversationRecords } from './sqlite-conversation-records.js';
import type { Store } from '../store.js';
import type { WorkspaceStore } from '../workspace.js';
import type { MemoryStore } from '../memory-store.js';
import type { MemoryHistory } from '../memory-history.js';
import type { Pages } from '../pages.js';
import type { ComputerStore } from '../computer-store.js';
import type { ConnectionStore } from '../connection-store.js';
import type { AbilityStore } from '../abilities/store.js';
import type { FolderAccessService } from '../folder-access.js';
import type { ZodError } from 'zod';

export type StoragePriority = 'foreground' | 'background';
export const storageLimits = {
  requests: 1024,
  bytes: 16 * 1024 * 1024,
} as const;
interface Repositories {
  snapshot: SQLiteSnapshot;
  store: Store;
  workspace: WorkspaceStore;
  memory: MemoryStore;
  history: MemoryHistory;
  pages: Pages;
  computers: ComputerStore;
  connections: ConnectionStore;
  abilities: AbilityStore;
  folders: FolderAccessService;
  conversations: SQLiteConversationRecords;
  evidence: SQLiteEvidence;
  jobs: SQLiteJobs;
  recall: MemoryRecall;
  access: MemoryAccess;
  publication: DreamPublication;
  context: ContextBuilder;
  policy: RuntimePolicy;
  voiceDelegations: VoiceDelegations;
}
// Explicit names are the wire protocol. Never dispatch arbitrary paths/prototype properties.
export const repositoryMethods = {
  voiceDelegations: [
    'threadContext',
    'interrupt',
    'enqueue',
    'get',
    'forThread',
    'list',
    'claim',
    'renew',
    'settle',
    'cancel',
    'expireApprovals',
    'recover',
    'markDelivered',
  ],
  snapshot: ['capture'],
  policy: [
    'turnState',
    'pageContext',
    'pageSpaces',
    'listPages',
    'readPage',
    'create',
    'editPage',
  ],
  access: ['forDot', 'canRead', 'guardAllowed'],
  publication: ['review', 'forget', 'share', 'previewRestore', 'restore'],
  context: ['essentials', 'validateEssentials'],
  evidence: [
    'blockedThreads',
    'sourceThreads',
    'pendingRuns',
    'pendingSources',
    'compactSnapshot',
    'completedExchanges',
    'threadMessages',
    'modelMessages',
    'indexBatch',
    'generation',
    'coverage',
    'searchEpisodes',
    'sourceById',
    'readSource',
    'latestCheckpoint',
    'saveCheckpoint',
    'sourcesExist',
    'dependenciesAllowed',
  ],
  jobs: [
    'publishDream',
    'reconcileReceipt',
    'enqueue',
    'get',
    'list',
    'find',
    'lastAutomatic',
    'claim',
    'admitAutomatic',
    'cancelQueued',
    'defer',
    'renew',
    'recordUsage',
    'settle',
  ],
  recall: ['search', 'read', 'readSource'],
  conversations: [
    'createThread',
    'getOrCreateThread',
    'listThreads',
    'interruptedThreads',
    'readSnapshot',
    'getEvents',
    'acquire',
    'renew',
    'release',
    'readLeased',
    'beginRun',
    'addEvidenceGuard',
    'appendEvent',
    'finishRun',
  ],
  store: [
    'setupTelemetryState',
    'saveSetupTelemetryState',
    'clearSetupTelemetry',
    'settings',
    'updateSettings',
    'tasks',
    'task',
    'createTask',
    'detail',
    'event',
    'action',
    'schedule',
    'claim',
    'owns',
    'finish',
    'interrupt',
    'fail',
    'memories',
    'saveMemory',
    'deleteMemory',
  ],
  workspace: [
    'spaces',
    'createSpace',
    'dots',
    'dot',
    'voiceSettings',
    'setVoiceSettings',
    'desktopDot',
    'selectDesktopDot',
    'setDotCustomization',
    'initializeDotCustomization',
    'createDot',
    'canAccessSpace',
    'updateDot',
    'saveComposioSession',
    'conversations',
    'updateConversation',
    'deletedConversations',
    'deleteConversation',
    'restoreConversation',
    'bindThread',
    'requireThread',
    'bindTask',
    'taskThread',
    'calls',
    'saveVoiceDelivery',
    'voiceDelivery',
    'createCall',
    'call',
    'setCall',
    'saveLateTranscript',
    'anchorCall',
    'setCallError',
    'saveCapture',
    'capture',
    'messageMarks',
    'setMessageMark',
  ],
  memory: [
    'settings',
    'updateSettings',
    'sourceSuppressed',
    'suppressionGeneration',
    'maskMessages',
    'search',
    'scanCursor',
    'saveScanCursor',
    'generation',
    'pinned',
    'importLegacy',
    'create',
    'get',
    'listOwner',
    'edit',
    'revisions',
  ],
  history: [
    'receipt',
    'receipts',
    'saveReceipt',
    'operation',
    'saveOperation',
    'suppressionGeneration',
    'suppress',
    'releaseSuppression',
    'sourceSuppressed',
    'keySuppressed',
    'maskMessages',
    'grant',
    'hasGrant',
    'savePreview',
    'preview',
  ],
  pages: [
    'requireSpace',
    'exists',
    'list',
    'get',
    'create',
    'reviewReceipt',
    'createReviewed',
    'update',
    'thread',
    'reserveThread',
    'finishThread',
    'releaseThread',
    'forThread',
    'delete',
  ],
  computers: ['permissions', 'patch', 'begin', 'finish', 'audit'],
  abilities: [
    'installation',
    'installations',
    'approveInstallation',
    'setMaster',
    'recordPackage',
    'package',
    'packages',
    'removePackage',
    'bind',
    'list',
    'bindingsForDigest',
    'pendingCleanup',
    'completeCleanup',
    'get',
    'revoke',
    'enable',
    'configure',
    'forget',
    'fingerprint',
    'claimInvocation',
    'settleInvocation',
    'receipt',
  ],
  connections: [
    'list',
    'get',
    'credentials',
    'create',
    'saveTools',
    'setError',
    'remove',
    'fingerprint',
    'createApproval',
    'approval',
    'action',
    'actionForApproval',
    'claimAction',
    'finishAction',
  ],
  folders: [
    'request',
    'getRequest',
    'reviewRequests',
    'resolve',
    'select',
    'decide',
    'list',
    'revoke',
    'listDirectory',
    'readFile',
    'writeFile',
  ],
} as const satisfies {
  [G in keyof Repositories]: readonly (keyof Repositories[G])[];
};
type Group = keyof Repositories;
type Name<G extends Group> = (typeof repositoryMethods)[G][number] &
  keyof Repositories[G];
type Method<G extends Group, N extends Name<G>> = Extract<
  Repositories[G][N],
  (...args: never[]) => unknown
>;
export type RepositoryMethod = {
  [G in Group]: `${G}.${Name<G> & string}`;
}[Group];
// AbortSignals stay in the calling process. Folder I/O receives a worker-local signal.
type WireArgs<M extends RepositoryMethod> = M extends 'snapshot.capture'
  ? [destination: string]
  : M extends 'folders.listDirectory'
    ? [dotId: string, grantId: string, relativePath?: string]
    : M extends 'folders.readFile'
      ? [dotId: string, grantId: string, relativePath: string]
      : M extends 'folders.writeFile'
        ? [
            dotId: string,
            grantId: string,
            relativePath: string,
            input: Parameters<FolderAccessService['writeFile']>[3],
          ]
        : M extends `${infer G extends Group}.${infer N}`
          ? N extends Name<G>
            ? Parameters<Method<G, N>>
            : never
          : never;
export type RepositoryArguments<M extends RepositoryMethod> = WireArgs<M>;
export type RepositoryResult<M extends RepositoryMethod> =
  M extends `${infer G extends Group}.${infer N}`
    ? N extends Name<G>
      ? Awaited<ReturnType<Method<G, N>>>
      : never
    : never;
export type AsyncRepository<G extends Group> = {
  [N in Name<G>]: (
    ...args: Parameters<Method<G, N>>
  ) => Promise<Awaited<ReturnType<Method<G, N>>>>;
};
export type AsyncWorkspace = AsyncRepository<'workspace'> & {
  policy: AsyncRepository<'policy'>;
  readonly ownerId: string;
  memory: AsyncRepository<'memory'> & {
    readonly ownerId: string;
    history: AsyncRepository<'history'>;
  };
  pages: AsyncRepository<'pages'>;
  computers: AsyncRepository<'computers'>;
  connections: AsyncRepository<'connections'>;
  abilities: AsyncRepository<'abilities'>;
  folders: AsyncRepository<'folders'>;
};
export interface AsyncRepositories {
  voiceDelegations: AsyncRepository<'voiceDelegations'>;
  evidence: AsyncRepository<'evidence'> & {
    indexRun(runId: string): Promise<void>;
  };
  jobs: Omit<AsyncRepository<'jobs'>, 'publishDream'> &
    Pick<MemoryJobRepository, 'publishDream'>;
  recall: AsyncRepository<'recall'>;
  access: AsyncRepository<'access'>;
  publication: AsyncRepository<'publication'>;
  context: AsyncRepository<'context'>;
  store: AsyncRepository<'store'>;
  workspace: AsyncWorkspace;
}
export interface RepositoryCallOptions {
  signal?: AbortSignal;
  priority?: StoragePriority;
}
export interface StorageRequest {
  kind: 'call';
  id: number;
  method: RepositoryMethod;
  args: unknown[];
  priority: StoragePriority;
  cancel: SharedArrayBuffer;
}
export interface StorageFailure {
  name: string;
  message: string;
  code?: string;
  status?: number;
  issues?: ZodError['issues'];
}
export type StorageResponse =
  | { kind: 'ready' | 'closed' }
  | { kind: 'result'; id: number; value?: unknown; error?: StorageFailure }
  | { kind: 'fatal'; error: StorageFailure };
const allowed = new Set(
  Object.entries(repositoryMethods).flatMap(([group, methods]) =>
    methods.map((method) => `${group}.${method}`),
  ),
);
export function isRepositoryMethod(value: unknown): value is RepositoryMethod {
  return typeof value === 'string' && allowed.has(value);
}
export function storageFailure(error: unknown): StorageFailure {
  const value =
    error instanceof Error
      ? (error as Error & { code?: string; status?: number })
      : new Error('Storage operation failed');
  return {
    name: value.name === 'Error' ? value.constructor.name : value.name,
    message: value.message,
    ...('code' in value && typeof value.code === 'string'
      ? { code: value.code }
      : {}),
    ...('status' in value && typeof value.status === 'number'
      ? { status: value.status }
      : {}),
    ...('issues' in value && Array.isArray(value.issues)
      ? { issues: value.issues as ZodError['issues'] }
      : {}),
  };
}
export function cancelledStorageError() {
  const error = new Error('Storage request cancelled');
  error.name = 'AbortError';
  return error;
}
