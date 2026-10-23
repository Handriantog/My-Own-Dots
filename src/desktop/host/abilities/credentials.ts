import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AbilityFailure } from '../../../shared/abilities/bridge.js';
import { canonicalJson } from '../../../shared/abilities/permissions.js';
import {
  protectedStorageAvailable,
  type ProtectedStorage,
} from '../backup-keys.js';
import { DirectoryAnchor } from './package.js';

const id = z.string().min(1).max(256);
export const accountScopeSchema = z.strictObject({
  workspaceId: id,
  dotId: id,
  bindingId: z.uuid(),
  source: id,
  abilityId: id,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  accountId: id,
  clientId: id,
  consentRevision: z.number().int().nonnegative().safe(),
});
const accountKeySchema = accountScopeSchema.extend({ handle: z.uuid() });
export type AccountScope = z.infer<typeof accountScopeSchema>;
export type AccountKey = z.infer<typeof accountKeySchema>;
export const accountTokenSchema = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9._~+/-]+=*$/);
const accountSchema = z.strictObject({
  accessToken: accountTokenSchema,
  refreshToken: accountTokenSchema.optional(),
  expiresAt: z.number().int().nonnegative().safe(),
  scopes: z.array(z.string().min(1).max(100)).max(50),
});
export type StoredAccount = z.infer<typeof accountSchema>;
const storedSchema = z.strictObject({
  version: z.literal(1),
  key: accountKeySchema,
  account: accountSchema,
});
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Encrypted host-profile files only. No worker or renderer imports this module. */
export class AbilityCredentials {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly options: {
      root: string;
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
  private requireAvailable(): void {
    if (!this.available()) throw new AbilityFailure('setup_needed');
  }
  private async serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => {}).then(action);
    this.pending = next;
    try {
      return await next;
    } catch (error) {
      throw error instanceof AbilityFailure
        ? error
        : new AbilityFailure('setup_needed');
    }
  }
  private directory(
    scope: Pick<AccountScope, 'workspaceId' | 'bindingId'>,
  ): string {
    return join(this.options.root, hash([scope.workspaceId, scope.bindingId]));
  }
  private path(scope: AccountScope): string {
    return join(this.directory(scope), hash(scope.accountId) + '.enc');
  }
  private async root(create: boolean): Promise<DirectoryAnchor | undefined> {
    if (
      (await realpath(dirname(this.options.root))) !==
      dirname(this.options.root)
    )
      throw new AbilityFailure('permission_denied');
    if (create)
      await mkdir(this.options.root, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
    try {
      return await DirectoryAnchor.capture(this.options.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !create)
        return undefined;
      throw error;
    }
  }
  private async currentRecord(
    scope: AccountScope,
  ): Promise<z.infer<typeof storedSchema> | undefined> {
    this.requireAvailable();
    accountScopeSchema.parse(scope);
    const root = await this.root(false);
    if (!root) return undefined;
    let directory: DirectoryAnchor;
    try {
      directory = await DirectoryAnchor.capture(this.directory(scope));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let file;
    try {
      file = await open(
        this.path(scope),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077 ||
        info.size < 1 ||
        info.size > 64 * 1024
      )
        throw new AbilityFailure('permission_denied');
      const encrypted = await file.readFile();
      await root.check();
      await directory.check();
      this.requireAvailable();
      const record = storedSchema.parse(
        JSON.parse(this.options.storage.decryptString(encrypted)),
      );
      const { handle: _handle, ...storedScope } = record.key;
      void _handle;
      return canonicalJson(storedScope) === canonicalJson(scope)
        ? record
        : undefined;
    } finally {
      await file.close();
    }
  }
  current(
    scope: AccountScope,
  ): Promise<{ key: AccountKey; account: StoredAccount } | undefined> {
    return this.serialize(() => this.currentRecord(scope));
  }
  read(key: AccountKey): Promise<StoredAccount | undefined> {
    return this.serialize(async () => {
      const { handle, ...scope } = accountKeySchema.parse(key);
      const record = await this.currentRecord(scope);
      return record?.key.handle === handle ? record.account : undefined;
    });
  }
  write(key: AccountKey, account: StoredAccount): Promise<void> {
    return this.serialize(async () => {
      this.requireAvailable();
      const value = storedSchema.parse({ version: 1, key, account });
      const encrypted = this.options.storage.encryptString(
        JSON.stringify(value),
      );
      if (!encrypted.length || encrypted.length > 64 * 1024)
        throw new AbilityFailure('setup_needed');
      const root = (await this.root(true))!;
      await mkdir(this.directory(key), { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
      const directory = await DirectoryAnchor.capture(this.directory(key));
      const temporary = join(directory.path, randomUUID() + '.tmp');
      try {
        const file = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(encrypted);
          await file.sync();
        } finally {
          await file.close();
        }
        await root.check();
        await directory.check();
        this.requireAvailable();
        await rename(temporary, this.path(key));
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }
  remove(key: AccountKey): Promise<void> {
    return this.serialize(async () => {
      const { handle, ...scope } = accountKeySchema.parse(key);
      const current = await this.currentRecord(scope);
      if (current?.key.handle !== handle) return;
      const root = await this.root(false);
      if (!root) return;
      const directory = this.directory(key);
      if (
        !(await lstat(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        }))
      )
        return;
      await DirectoryAnchor.capture(directory);
      await root.check();
      await rm(this.path(key), { force: true });
    });
  }
  clearBinding(workspaceId: string, bindingId: string): Promise<void> {
    return this.serialize(async () => {
      id.parse(workspaceId);
      z.uuid().parse(bindingId);
      const root = await this.root(false);
      if (!root) return;
      const directory = this.directory({ workspaceId, bindingId });
      if (
        !(await lstat(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        }))
      )
        return;
      await DirectoryAnchor.capture(directory);
      await root.check();
      await rm(directory, { recursive: true, force: true });
    });
  }
}
