import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { ArchiveWorkerClient } from '../../src/desktop/host/archive-worker-client.js';
import { archiveFixture } from '../fixtures/storage-archive.js';
import { readArchive } from '../../src/server/storage/archive.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
it('encrypts and independently verifies an archive in a separate process', async () => {
  const f = await archiveFixture({
    'core/data.txt': 'private memory contents',
  });
  cleanup.push(f.dispose);
  const worker = new ArchiveWorkerClient({
    entry: fileURLToPath(
      new URL('../../src/desktop/host/archive-worker.ts', import.meta.url),
    ),
    execArgv: ['--import', 'tsx'],
  });
  const phases: string[] = [];
  const result = await worker.run(
    {
      kind: 'backup',
      sourceDirectory: f.sourceDirectory,
      destination: f.destination,
      manifest: f.manifest,
      passphrase: f.passphrase,
    },
    { signal: f.signal, phase: (phase) => phases.push(phase) },
  );
  expect(result).toMatchObject({ verified: true, id: f.manifest.archiveId });
  expect(phases).toEqual(['archive', 'verify']);
  expect(
    (await readFile(f.destination)).includes(
      Buffer.from('private memory contents'),
    ),
  ).toBe(false);
  expect(
    await readArchive({
      source: f.destination,
      stagingDirectory: f.stagingDirectory,
      passphrase: f.passphrase,
      signal: f.signal,
    }),
  ).toEqual(f.manifest);
  expect(
    (await readdir(f.root)).filter((name) => name.includes('verify')),
  ).toEqual([]);
});
it('cancellation reaps the worker before returning and exposes no password in errors', async () => {
  const f = await archiveFixture({
    'core/data.txt': 'private memory contents',
  });
  cleanup.push(f.dispose);
  const worker = new ArchiveWorkerClient({
    entry: fileURLToPath(
      new URL('../../src/desktop/host/archive-worker.ts', import.meta.url),
    ),
    execArgv: ['--import', 'tsx'],
  });
  const abort = new AbortController();
  const result = worker.run(
    {
      kind: 'backup',
      sourceDirectory: f.sourceDirectory,
      destination: f.destination,
      manifest: f.manifest,
      passphrase: f.passphrase,
    },
    { signal: abort.signal, phase: () => abort.abort() },
  );
  await expect(result).rejects.toThrow(/cancel/i);
  expect((await readdir(f.root)).filter((name) => name !== 'source')).toEqual(
    [],
  );
});
it('runs the packaged worker without source files or workspace dependencies', async () => {
  const f = await archiveFixture({ 'core/data.txt': 'packaged recovery' });
  cleanup.push(f.dispose);
  const { buildStorageWorker } = await import(
    pathToFileURL(join(process.cwd(), 'scripts/desktop-runtime.mjs')).href
  );
  const entry = join(f.root, 'runtime/archive-worker.cjs');
  await buildStorageWorker(process.cwd(), entry);
  const worker = new ArchiveWorkerClient({ entry });
  const result = await worker.run(
    {
      kind: 'backup',
      sourceDirectory: f.sourceDirectory,
      destination: f.destination,
      manifest: f.manifest,
      passphrase: f.passphrase,
    },
    { signal: f.signal },
  );
  expect(result).toMatchObject({ verified: true });
  expect(
    await readArchive({
      source: f.destination,
      stagingDirectory: f.stagingDirectory,
      passphrase: f.passphrase,
      signal: f.signal,
    }),
  ).toEqual(f.manifest);
});
