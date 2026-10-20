import type { ArchiveManifest } from '../../shared/storage-archive.js';
export const storageMethods = [
  'status',
  'chooseBackupDirectory',
  'backupNow',
  'setAutomatic',
  'previewRestore',
  'restore',
  'previewMigration',
  'migrate',
  'cancel',
] as const;

export interface StorageOperationStatus {
  id: string;
  kind: 'backup' | 'restore' | 'migration';
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
  migration?: boolean;
  destination?: string;
  backupPath?: string;
  operationId: string;
  expiresAt?: number;
  workspaceId: string;
  counts: Record<string, number>;
  coverage: ArchiveManifest['coverage'];
  warnings: string[];
}
export interface StorageStatus {
  workspaceDirectory?: string;
  storageEngine?: 'legacy-postgres' | 'sqlite';
  migrationAvailable?: boolean;
  secureStorage: boolean;
  recoveryWarnings?: string[];
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
  previewMigration(input: { passphrase: string }): Promise<void>;
  migrate(input: { operationId: string }): Promise<void>;
  restore(input: {
    operationId: string;
    mode: 'new' | 'replace';
  }): Promise<void>;
  cancel(operationId: string): Promise<void>;
  onStatus(callback: (status: StorageStatus) => void): () => void;
}
