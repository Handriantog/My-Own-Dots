import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Structural boundary for Electron safeStorage, used only in the native host. */
export interface ProtectedStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
const linuxBackends = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
]);

export function protectedStorageAvailable(
  storage: ProtectedStorage,
  platform: NodeJS.Platform,
): boolean {
  try {
    return (
      storage.isEncryptionAvailable() &&
      (platform !== 'linux' ||
        linuxBackends.has(storage.getSelectedStorageBackend?.() ?? ''))
    );
  } catch {
    return false;
  }
}

export class BackupKeys {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly options: {
      file: string;
      storage: ProtectedStorage;
      platform: NodeJS.Platform;
    },
  ) {}

  available(): boolean {
    return protectedStorageAvailable(
      this.options.storage,
      this.options.platform,
    );
  }

  remember(passphrase: string): Promise<void> {
    return this.serialize(async () => {
      this.requireAvailable();
      if (!passphrase || passphrase.length > 4096)
        throw new Error(
          'Enter a backup password between 1 and 4096 characters.',
        );
      let encrypted: Buffer;
      try {
        encrypted = this.options.storage.encryptString(passphrase);
      } catch {
        throw new Error('Could not protect the backup password.');
      }
      this.requireAvailable();
      if (!encrypted.length || encrypted.length > 64 * 1024)
        throw new Error('Could not protect the backup password.');
      await mkdir(dirname(this.options.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.options.file}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(encrypted);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.options.file);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  recall(): Promise<string | undefined> {
    return this.serialize(async () => {
      this.requireAvailable();
      let encrypted: Buffer;
      try {
        const metadata = await lstat(this.options.file);
        if (!metadata.isFile() || metadata.size > 64 * 1024)
          throw new Error('Invalid protected password file.');
        encrypted = await readFile(this.options.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return undefined;
        throw new Error('Could not read the protected backup password.', {
          cause: error,
        });
      }
      try {
        return this.options.storage.decryptString(encrypted);
      } catch {
        throw new Error(
          'Could not unlock the backup password. Enter the recovery password again.',
        );
      }
    });
  }

  forget(): Promise<void> {
    return this.serialize(() => rm(this.options.file, { force: true }));
  }

  private requireAvailable(): void {
    if (!this.available())
      throw new Error(
        'Secure storage is unavailable. Enter the recovery password for each manual backup.',
      );
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => {}).then(work);
    this.pending = result;
    return result;
  }
}
