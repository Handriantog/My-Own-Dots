import type {
  AbilityManifest,
  JsonValue,
  ReleaseDescriptor,
} from './manifest.js';
export type {
  AbilityManifest,
  AbilityPermission,
  JsonValue,
  LimitedSchema,
  ReleaseDescriptor,
} from './manifest.js';
export type {
  CapabilityRequest,
  CapabilityReply,
  InvocationOutcome,
  OwnerResult,
  AbilityErrorCode,
} from './protocol.js';

export interface InstallReview {
  id: string;
  descriptor: ReleaseDescriptor;
  descriptorUrl: string;
  descriptorSha256: string;
  archiveUrl: string;
  expiresAt: number;
}
export interface VerifiedPackage {
  digest: string;
  descriptor: ReleaseDescriptor;
  manifest: AbilityManifest;
  root: string;
  files: { path: string; sha256: string; size: number; executable: boolean }[];
}
export interface Binding {
  id: string;
  dotId: string;
  digest: string;
  manifest: AbilityManifest;
  grants: string[];
  settings: Record<string, JsonValue>;
  revision: number;
  enabled: boolean;
  approvedAt: number;
  restored: boolean;
}
/** Minted by the service/host. Never accept these fields from a worker or model. */
export interface InvocationContext {
  workspaceId: string;
  sessionId: string;
  dotId: string;
  bindingId: string;
  digest: string;
  grantRevision: number;
  invocationId: string;
  tool: string;
  threadId: string;
  channel?: 'text' | 'voice';
}
export interface InvocationRequest {
  context: InvocationContext;
  arguments: Record<string, JsonValue>;
  settings: Record<string, JsonValue>;
  selectionRef?: string;
  /** Desktop-resolved only; excluded from backend requests and model output. */
  selection?: Record<string, JsonValue>;
}
