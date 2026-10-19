import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { stopProcess } = await import(
  pathToFileURL(path.join(process.cwd(), 'scripts/desktop-smoke-process.mjs'))
    .href
);
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }),
  );
});
async function start(source: string) {
  const child = spawn(process.execPath, ['-e', source]);
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve());
  });
  return child;
}
it('waits for graceful termination without escalating', async () => {
  const child = await start(
    "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 25)); console.log('ready'); setInterval(() => {}, 1000)",
  );
  expect(await stopProcess(child, { timeoutMs: 1000 })).toEqual({
    forced: false,
  });
  expect(child.exitCode).toBe(0);
});
it('kills a process that ignores termination within a bounded interval', async () => {
  const child = await start(
    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
  );
  const before = Date.now();
  expect(await stopProcess(child, { timeoutMs: 50 })).toEqual({ forced: true });
  expect(child.signalCode).toBe('SIGKILL');
  expect(Date.now() - before).toBeLessThan(2000);
});
it('handles an already exited child without sending another signal', async () => {
  const child = await start("console.log('ready')");
  await new Promise((resolve) => child.once('exit', resolve));
  expect(await stopProcess(child, { timeoutMs: 50 })).toEqual({
    forced: false,
  });
  expect(child.exitCode).toBe(0);
});
