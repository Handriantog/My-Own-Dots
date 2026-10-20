import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { validateArchivePaths } from '../../server/storage/archive-paths.js';

const portableSchema = z
  .object({ version: z.literal(1), workspace: z.string(), profile: z.string() })
  .strict();
export type PortableLayout = z.infer<typeof portableSchema>;
function validateLayout(input: PortableLayout): PortableLayout {
  const layout = portableSchema.parse(input);
  validateArchivePaths([layout.workspace, layout.profile]);
  if (
    [layout.workspace, layout.profile].some((value) => value.includes('\\')) ||
    layout.workspace.startsWith(layout.profile + '/') ||
    layout.profile.startsWith(layout.workspace + '/')
  )
    throw new Error(
      'Portable workspace and profile must be separate relative paths',
    );
  return layout;
}
export async function readPortableLayout(
  root: string,
): Promise<PortableLayout> {
  const file = await open(
    path.join(root, 'portable.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 16 * 1024)
      throw new Error('Invalid portable marker');
    return validateLayout(JSON.parse(await file.readFile('utf8')));
  } finally {
    await file.close();
  }
}
/** Small startup configuration only; called before Electron opens its profile. */
export function portableConfiguration(input: {
  platform: NodeJS.Platform;
  executable: string;
  root?: string;
  appImage?: string;
}) {
  const fsPath = input.platform === 'win32' ? path.win32 : path.posix;
  let root = input.root;
  if (root && !fsPath.isAbsolute(root))
    throw new Error('Portable root must be absolute');
  if (!root) {
    if (input.platform === 'darwin') {
      const bundle = input.executable.match(/^(.*)\/[^/]+\.app\/Contents\//);
      root = bundle?.[1] ?? fsPath.dirname(input.executable);
    } else
      root = fsPath.dirname(
        input.platform === 'linux' && input.appImage
          ? input.appImage
          : input.executable,
      );
  }
  if (!fsPath.isAbsolute(root))
    throw new Error('Portable root must be absolute');
  let file;
  try {
    file = openSync(
      fsPath.join(root, 'portable.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (!input.root && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return;
    throw error;
  }
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.size > 16 * 1024)
      throw new Error('Invalid portable marker');
    return {
      root,
      paths: validateLayout(JSON.parse(readFileSync(file, 'utf8'))),
    };
  } finally {
    closeSync(file);
  }
}
interface LocationInput {
  platform: NodeJS.Platform;
  home: string;
  localAppData?: string;
  xdgDataHome?: string;
  electronData: string;
  selected?: string;
  portableRoot?: string;
  portablePaths?: PortableLayout;
  executable: string;
}
/** Pure platform resolution; only an explicit portable root enables portable placement. */
export function resolveWorkspaceLocation(input: LocationInput) {
  const fsPath = input.platform === 'win32' ? path.win32 : path.posix;
  const absolute = (value: string) => {
    if (!fsPath.isAbsolute(value))
      throw new Error('Workspace location must be absolute');
    return fsPath.normalize(value);
  };
  let profile = absolute(input.electronData);
  let workspace: string;
  if (input.portableRoot) {
    const root = absolute(input.portableRoot);
    if (
      root
        .split(/[\\/]/)
        .some((part) => /\.app$/i.test(part) || part.startsWith('.mount_'))
    )
      throw new Error(
        'Choose a portable root outside application bundles and AppImage mounts',
      );
    const layout = validateLayout(
      input.portablePaths ?? {
        version: 1,
        workspace: 'workspace',
        profile: 'desktop-profile',
      },
    );
    workspace = fsPath.join(root, layout.workspace);
    profile = fsPath.join(root, layout.profile);
  } else if (input.platform === 'darwin')
    workspace = fsPath.join(profile, 'workspace');
  else if (input.platform === 'win32')
    workspace = fsPath.join(
      absolute(
        input.localAppData ??
          fsPath.join(absolute(input.home), 'AppData', 'Local'),
      ),
      'My Own Dots',
      'workspace',
    );
  else if (input.platform === 'linux')
    workspace = fsPath.join(
      input.xdgDataHome && fsPath.isAbsolute(input.xdgDataHome)
        ? input.xdgDataHome
        : fsPath.join(absolute(input.home), '.local/share'),
      'my-own-dots/workspace',
    );
  else throw new Error('Unsupported desktop workspace platform');
  return {
    workspace: input.selected ? absolute(input.selected) : workspace,
    profile,
    portable: !!input.portableRoot,
  };
}
