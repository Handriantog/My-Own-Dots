import type { FolderApprovalPending } from '../../shared/folder-access.js';

export interface FolderApprovalState {
  request: FolderApprovalPending | null;
  count: number;
}

/** Presentation only. Decisions use the existing authenticated folder API. */
export interface DesktopApprovalBridge {
  state(): Promise<FolderApprovalState>;
  onState(callback: (state: FolderApprovalState) => void): () => void;
  dismiss(): Promise<void>;
  next(): Promise<void>;
}

export const approvalPage = 'dots://workspace/?surface=approval';
