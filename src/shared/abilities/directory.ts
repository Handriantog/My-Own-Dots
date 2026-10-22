import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
/** Parents are host-private: never choose an Ability-writable state directory. */
export class DirectoryAnchor {
  private constructor(
    readonly path: string,
    private readonly device: number,
    private readonly inode: number,
  ) {}
  static async capture(path: string): Promise<DirectoryAnchor> {
    if (!isAbsolute(path) || (await realpath(path)) !== path)
      throw new Error('Unsafe Ability directory');
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.mode & 0o022 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Ability directory must be host-private');
    return new DirectoryAnchor(path, stat.dev, stat.ino);
  }
  async check(): Promise<void> {
    const current = await DirectoryAnchor.capture(this.path);
    if (current.device !== this.device || current.inode !== this.inode)
      throw new Error('Ability directory changed');
  }
}
