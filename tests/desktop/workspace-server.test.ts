import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = process.cwd();
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const result = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return result;
}
async function fixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dots-server-'));
  cleanups.push(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, 'dist/client'), { recursive: true });
  await writeFile(
    path.join(workspace, 'dist/client/index.html'),
    'browser-only-spa',
  );
  const database = path.join(workspace, 'state.sqlite');
  const children: ChildProcess[] = [];
  cleanups.push(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        );
        child.kill('SIGTERM');
        await exited;
      }
    }
  });
  function start(port: number) {
    const child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href,
        path.join(root, 'src/server/index.ts'),
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          PORT: String(port),
          DATABASE_PATH: database,
          DOTS_DESKTOP_API_ONLY: '0',
          CONVERSATION_BACKEND: 'intelligence',
          LLM_BACKEND: 'openai',
          OWNER_TOKEN: 'fixture-owner-token-at-least-24',
          INTELLIGENCE_API_KEY: '',
          CPK_INTELLIGENCE_API_KEY: '',
          OPENAI_API_KEY: '',
        },
        stdio: 'ignore',
      },
    );
    children.push(child);
    return child;
  }
  return { start, database };
}
async function ready(url: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Server exited ${child.exitCode}`);
    try {
      const response = await fetch(url, {
        headers: { authorization: 'Bearer fixture-owner-token-at-least-24' },
      });
      if (response.status !== 503) return response;
    } catch {
      /* Wait for listener. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Server startup timed out');
}
it('production startup authenticates identity and serves APIs without the browser SPA by default', async () => {
  const { start } = await fixture();
  const chosen = await port();
  const child = start(chosen);
  const base = `http://127.0.0.1:${chosen}`;
  const response = await ready(`${base}/api/desktop/identity`, child);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    service: 'my-own-dots',
    protocol: 1,
    workspaceId: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect((await fetch(`${base}/api/desktop/identity`)).status).toBe(401);
  const browser = await fetch(base);
  expect(browser.status).toBe(404);
  expect(await browser.text()).not.toContain('browser-only-spa');
}, 15000);
it('prevents a second runner on the same database even with a different port', async () => {
  const { start } = await fixture();
  const firstPort = await port();
  const first = start(firstPort);
  await ready(`http://127.0.0.1:${firstPort}/api/desktop/identity`, first);
  const second = start(await port());
  const result = await Promise.race([
    new Promise((resolve) => second.once('exit', (code) => resolve(code))),
    new Promise((resolve) => setTimeout(() => resolve('still-running'), 5000)),
  ]);
  expect(result).not.toBe('still-running');
  expect(result).not.toBe(0);
  expect(
    (
      await fetch(`http://127.0.0.1:${firstPort}/api/desktop/identity`, {
        headers: { authorization: 'Bearer fixture-owner-token-at-least-24' },
      })
    ).ok,
  ).toBe(true);
}, 15000);
