import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
export const sqliteStorageSchema = 4;
export function supportedSQLiteStorageSchema(
  value: number,
): value is 2 | 3 | 4 {
  return value === 2 || value === 3 || value === sqliteStorageSchema;
}

export const workspaceManifestSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    ownerId: z.string().min(1).max(256),
    storage: z.enum(['legacy-postgres', 'sqlite']),
    schema: z.number().int().min(1),
  })
  .strict();
export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;

/** Inspection never creates directories, databases or replacement identities. */
export async function readWorkspaceManifest(
  directory: string,
): Promise<WorkspaceManifest | undefined> {
  let file;
  try {
    file = await open(
      join(directory, 'workspace.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 16 * 1024)
      throw new Error('Invalid workspace manifest');
    return workspaceManifestSchema.parse(
      JSON.parse(await file.readFile('utf8')),
    );
  } catch (error) {
    throw new Error('Invalid or unsupported workspace manifest', {
      cause: error,
    });
  } finally {
    await file.close();
  }
}

/** Creation belongs only to explicit new-workspace/migration flows. Existing identities are immutable. */
export async function createWorkspaceManifest(
  directory: string,
  input: WorkspaceManifest,
): Promise<WorkspaceManifest> {
  const manifest = workspaceManifestSchema.parse(input);
  const path = join(directory, 'workspace.json');
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(manifest) + '\n');
    await file.sync();
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await file.close();
  }
  if (process.platform !== 'win32') {
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  return manifest;
}

/** Called only after the owned runtime has successfully upgraded its SQLite database. */
export async function updateWorkspaceManifestSchema(
  directory: string,
  ownerId: string,
): Promise<void> {
  const manifest = await readWorkspaceManifest(directory);
  if (!manifest) return;
  if (manifest.ownerId !== ownerId)
    throw new Error('Workspace manifest owner changed.');
  if (manifest.storage !== 'sqlite') return;
  if (!supportedSQLiteStorageSchema(manifest.schema))
    throw new Error('Unsupported SQLite workspace schema.');
  if (manifest.schema === sqliteStorageSchema) return;
  const temporary = join(directory, `.workspace-schema-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(
      JSON.stringify({ ...manifest, schema: sqliteStorageSchema }) + '\n',
    );
    await file.sync();
    await file.close();
    if (
      JSON.stringify(await readWorkspaceManifest(directory)) !==
      JSON.stringify(manifest)
    )
      throw new Error('Workspace manifest changed during schema upgrade.');
    await rename(temporary, join(directory, 'workspace.json'));
    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
}
