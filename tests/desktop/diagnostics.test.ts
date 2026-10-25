import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { DesktopDiagnostics } from '../../src/desktop/host/diagnostics.js';

it('preserves an uncaught host exception even when the process immediately exits', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dots-diagnostics-'));
  try {
    const module = new URL(
      '../../src/desktop/host/diagnostics.ts',
      import.meta.url,
    ).href;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { DesktopDiagnostics } from ${JSON.stringify(module)};
      const log = new DesktopDiagnostics(${JSON.stringify(directory)});
      process.on('uncaughtExceptionMonitor', (error) => log.captureException(error));
      setImmediate(() => { throw new Error('test host failure'); });
    `,
      ],
      { encoding: 'utf8' },
    );
    expect(child.status).toBe(1);
    const saved = JSON.parse(
      await readFile(path.join(directory, 'last-exception.json'), 'utf8'),
    );
    const files = await readdir(path.join(directory, 'errors'));
    const daily = JSON.parse(
      (await readFile(path.join(directory, 'errors', files[0]), 'utf8')).trim(),
    );
    expect(daily).toMatchObject({
      source: 'desktop',
      event: 'uncaught_exception',
      error: { message: 'test host failure' },
    });
    expect(saved.message).toBe('test host failure');
    expect(saved.stack).toContain('test host failure');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps recent diagnostic events in order with bounded disk history', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dots-diagnostics-'));
  try {
    const log = new DesktopDiagnostics(directory, 200);
    await Promise.all([
      log.record('permission', { trusted: false }),
      log.record('permission', { trusted: true }),
    ]);
    const entries = (
      await readFile(path.join(directory, 'desktop.log'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries.map((e) => e.details.trusted)).toEqual([false, true]);
    for (let i = 0; i < 20; i++) await log.record('frame', { sequence: i });
    const latest = await readFile(path.join(directory, 'desktop.log'), 'utf8');
    expect(Buffer.byteLength(latest)).toBeLessThanOrEqual(200);
    expect(JSON.parse(latest.trim().split('\n').at(-1)!).details.sequence).toBe(
      19,
    );
    expect(
      Buffer.byteLength(
        await readFile(path.join(directory, 'desktop.previous.log')),
      ),
    ).toBeLessThanOrEqual(200);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not stop the companion when diagnostics cannot be written', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dots-diagnostics-'));
  try {
    const file = path.join(directory, 'file');
    await writeFile(file, 'not a directory');
    await expect(
      new DesktopDiagnostics(file).record('startup', {}),
    ).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
