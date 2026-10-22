import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseReleaseDescriptor } from '../../../shared/abilities/manifest.js';
import { canonicalJson } from '../../../shared/abilities/permissions.js';
import type {
  InstallReview,
  VerifiedPackage,
} from '../../../shared/abilities/types.js';
import {
  fetchGitHub,
  resolveGitHubRelease,
  type GitHubFetch,
} from './github.js';
import {
  DirectoryAnchor,
  verifyAbilityPackage,
  verifyInstalledPackage,
} from './package.js';

type Transport = {
  resolve: typeof resolveGitHubRelease;
  download: GitHubFetch;
};
export class AbilityInstaller {
  private readonly pending = new Map<string, Promise<VerifiedPackage>>();
  constructor(
    private readonly root: string,
    private readonly transport: Transport = {
      resolve: resolveGitHubRelease,
      download: fetchGitHub,
    },
  ) {}
  async prepare(
    review: InstallReview,
    signal: AbortSignal,
  ): Promise<VerifiedPackage> {
    parseReleaseDescriptor(review.descriptor);
    signal.throwIfAborted();
    if (review.expiresAt <= Date.now())
      throw new Error('Ability review expired');
    const key = createHash('sha256')
      .update(canonicalJson(review.descriptor))
      .update(review.descriptorSha256)
      .digest('hex');
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.install(structuredClone(review), signal);
      this.pending.set(key, pending);
      void pending.finally(() => this.pending.delete(key)).catch(() => {});
    }
    const pkg = await pending;
    signal.throwIfAborted();
    return structuredClone(pkg);
  }
  private async install(
    review: InstallReview,
    signal: AbortSignal,
  ): Promise<VerifiedPackage> {
    if ((await realpath(dirname(this.root))) !== dirname(this.root))
      throw new Error('Unsafe Ability storage parent');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const anchor = await DirectoryAnchor.capture(this.root);
    const current = await this.transport.resolve(review.descriptorUrl, signal);
    if (
      canonicalJson(current.descriptor) !== canonicalJson(review.descriptor) ||
      current.descriptorSha256 !== review.descriptorSha256 ||
      current.archiveUrl !== review.archiveUrl
    )
      throw new Error('Ability release changed since review');
    await anchor.check();
    const bytes = await this.transport.download(
      review.archiveUrl,
      review.descriptor.asset.compressedBytes,
      signal,
    );
    signal.throwIfAborted();
    await anchor.check();
    if (
      bytes.length !== review.descriptor.asset.compressedBytes ||
      createHash('sha256').update(bytes).digest('hex') !==
        review.descriptor.asset.sha256
    )
      throw new Error('Ability download differs from review');
    const staging = join(this.root, 'staging'),
      packages = join(this.root, 'packages');
    for (const directory of [staging, packages]) {
      await anchor.check();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await DirectoryAnchor.capture(directory);
    }
    const stageAnchor = await DirectoryAnchor.capture(staging),
      packageAnchor = await DirectoryAnchor.capture(packages);
    const temporary = await mkdtemp(join(staging, 'download-'));
    let verified: VerifiedPackage | undefined;
    try {
      await anchor.check();
      await stageAnchor.check();
      const file = await open(
        join(temporary, 'artifact.tar.gz'),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      verified = await verifyAbilityPackage(
        join(temporary, 'artifact.tar.gz'),
        review,
        staging,
        signal,
      );
      signal.throwIfAborted();
      await anchor.check();
      await stageAnchor.check();
      await packageAnchor.check();
      const target = join(packages, verified.digest);
      try {
        await lstat(target);
        await verifyInstalledPackage({ ...verified, root: target });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          await rename(verified.root, target);
        } catch (moveError) {
          if (
            !['EEXIST', 'ENOTEMPTY'].includes(
              (moveError as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw moveError;
          await verifyInstalledPackage({ ...verified, root: target });
        }
      }
      await anchor.check();
      await packageAnchor.check();
      const result = { ...verified, root: target };
      await verifyInstalledPackage(result);
      return result;
    } finally {
      try {
        await anchor.check();
        await stageAnchor.check();
        await rm(temporary, { recursive: true, force: true });
        if (verified) await rm(verified.root, { recursive: true, force: true });
      } catch {
        /* Never follow a replaced parent during recovery. */
      }
    }
  }
}
