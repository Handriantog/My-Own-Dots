import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BackupKeys,
  type ProtectedStorage,
} from '../../src/desktop/host/backup-keys.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture(
  platform: NodeJS.Platform = 'linux',
  backend = 'gnome_libsecret',
) {
  const directory = await mkdtemp(join(tmpdir(), 'dot-backup-key-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  // OS cryptography is an injected boundary. These tests check what the app
  // persists and which backends it admits, not the OS encryption primitive.
  let plaintext = '';
  const encrypted = Buffer.from([0, 231, 119, 7, 65, 99]);
  const storage: ProtectedStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: vi.fn((value) => {
      plaintext = value;
      return encrypted;
    }),
    decryptString: vi.fn((value) => {
      if (!value.equals(encrypted)) throw new Error('invalid ciphertext');
      return plaintext;
    }),
  };
  const file = join(directory, 'recovery-password.bin');
  return {
    directory,
    file,
    storage,
    keys: new BackupKeys({ file, storage, platform }),
    encrypted,
  };
}

describe('protected backup passwords', () => {
  it.each(['basic_text', 'unknown', 'future_unreviewed_backend'])(
    'Linux %s never remembers password',
    async (backend) => {
      const f = await fixture('linux', backend);
      expect(f.keys.available()).toBe(false);
      await expect(
        f.keys.remember('private recovery password'),
      ).rejects.toThrow(/secure storage/i);
      expect(f.storage.encryptString).not.toHaveBeenCalled();
      expect(await readdir(f.directory)).toEqual([]);
    },
  );
  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])(
    'allows the reviewed Linux %s backend',
    async (backend) => {
      const f = await fixture('linux', backend);
      expect(f.keys.available()).toBe(true);
      await f.keys.remember('private recovery password');
      expect(await readFile(f.file)).toEqual(f.encrypted);
      expect(
        (await readFile(f.file)).includes(
          Buffer.from('private recovery password'),
        ),
      ).toBe(false);
      expect(await f.keys.recall()).toBe('private recovery password');
      expect((await stat(f.file)).mode & 0o777).toBe(0o600);
      await f.keys.forget();
      expect(await f.keys.recall()).toBeUndefined();
    },
  );
  it.each(['darwin', 'win32'] as const)(
    'uses available OS storage on %s without the Linux API',
    async (platform) => {
      const f = await fixture(platform);
      delete f.storage.getSelectedStorageBackend;
      expect(f.keys.available()).toBe(true);
      await f.keys.remember('recovery password');
      expect(await f.keys.recall()).toBe('recovery password');
    },
  );
  it('unavailable encryption neither overwrites an existing key nor decrypts it', async () => {
    const f = await fixture();
    await f.keys.remember('existing password');
    f.storage.isEncryptionAvailable = () => false;
    await expect(f.keys.remember('replacement password')).rejects.toThrow();
    await expect(f.keys.recall()).rejects.toThrow();
    expect(f.storage.decryptString).not.toHaveBeenCalled();
    expect(await readFile(f.file)).toEqual(f.encrypted);
  });
  it('provider errors never expose the password', async () => {
    const f = await fixture();
    f.storage.encryptString = () => {
      throw new Error('secret password');
    };
    await expect(f.keys.remember('secret password')).rejects.toThrow(
      'Could not protect the backup password.',
    );
    expect(await readdir(f.directory)).toEqual([]);
  });
});
