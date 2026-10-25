import { z } from 'zod';

export const folderAccessSchema = z.enum(['read', 'readwrite', 'execute']);
export type FolderAccess = z.infer<typeof folderAccessSchema>;
export const folderPermissionLabel = (access: FolderAccess) =>
  access === 'execute'
    ? 'Read, edit and run commands'
    : access === 'readwrite'
      ? 'Read and write'
      : 'Read only';
/** Host-only execution capability. Never accepted from provider arguments. */
export type FolderExecutionScope = {
  grantId: string;
  path: string;
  identity: { dev: string; ino: string };
  access: 'execute';
};
export type FolderRequest = {
  id: string;
  threadId: string;
  dotId: string;
  reason: string;
  folderHint: string;
  requestedAccess: FolderAccess;
  status: 'pending' | 'approved' | 'declined';
  expiresAt: number;
  grantId?: string;
};
/** Absolute paths are only returned by the authenticated owner API. */
export type FolderGrant = {
  id: string;
  dotId: string;
  name: string;
  path: string;
  access: FolderAccess;
  createdAt: number;
  revokedAt?: number;
};
export type FolderSelection = { id: string; path: string; name: string };
export type FolderDecision = {
  approved: boolean;
  grantId?: string;
  name?: string;
  access?: FolderAccess;
  message: string;
};
export type FolderRequestDetail = {
  request: FolderRequest;
  selection?: FolderSelection;
  grant?: FolderGrant;
  decision?: FolderDecision;
};
/** A durable approval awaiting its client tool result, including saved decisions. */
export type FolderApprovalPending = {
  requestId: string;
  threadId: string;
  dotId: string;
  dotName: string;
  toolCallId: string;
};
export const folderRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000),
    folderHint: z.string().trim().max(200),
    access: folderAccessSchema,
  })
  .strict();
export const folderDecisionSchema = z
  .object({
    toolCallId: z.string().trim().min(1).max(200),
    approve: z.boolean(),
    selectionId: z.uuid().optional(),
    access: folderAccessSchema.optional(),
  })
  .strict();
export const folderApprovalSchema = z.object({ requestId: z.uuid() }).strict();
export const folderApprovalTool = {
  name: 'review_local_folder_access',
  description:
    'Ask the owner to review the actual local folder and approve read, editing, or command execution access for this Dot. Use the request ID returned by request_local_folder_access. Only the owner can grant access. Call once and wait for the approval result before using the folder.',
  parameters: z.toJSONSchema(folderApprovalSchema),
};
