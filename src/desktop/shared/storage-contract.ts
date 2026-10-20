import type { ArchiveManifest } from '../../shared/storage-archive.js';
export const storageMethods = [
  'status',
  'chooseBackupDirectory',
  'backupNow',
  'setAutomatic',
  'previewRestore',
  'restore',
  'cancel',
] as const;

export interface StorageOperationStatus {
  id: string;
  kind: 'backup' | 'restore';
  phase:
    | 'queued'
    | 'snapshot'
    | 'archive'
    | 'verify'
    | 'ready'
    | 'failed'
    | 'cancelled';
  error?: string;
}
export interface StorageRestorePreview {
  operationId: string;
  workspaceId: string;
  counts: Record<string, number>;
  coverage: ArchiveManifest['coverage'];
  warnings: string[];
}
export interface StorageStatus {
  secureStorage: boolean;
  destination?: string;
  automatic: boolean;
  lastAttempt?: string;
  lastSuccess?: string;
  error?: string;
  operation?: StorageOperationStatus;
  coverage?: ArchiveManifest['coverage'];
  preview?: StorageRestorePreview;
}
export interface DesktopStorageBridge {
  status(): Promise<StorageStatus>;
  chooseBackupDirectory(): Promise<boolean>;
  backupNow(input: { passphrase: string; remember: boolean }): Promise<void>;
  setAutomatic(input: { enabled: boolean }): Promise<void>;
  previewRestore(input: { passphrase: string }): Promise<void>;
  restore(input: {
    operationId: string;
    mode: 'new' | 'replace';
  }): Promise<void>;
  cancel(operationId: string): Promise<void>;
  onStatus(callback: (status: StorageStatus) => void): () => void;
}
