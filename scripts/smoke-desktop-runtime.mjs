import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const electron = require('electron');
const workspace = await mkdtemp(path.join(tmpdir(), 'dots-packaged-node-'));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const token = 'disposable-smoke-token-longer-than-24';
const bundle = path.join(root, 'dist/desktop/app');
const child = spawn(electron, [path.join(bundle, 'server/index.js')], {
  cwd: workspace,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    HOST: '127.0.0.1',
    PORT: String(port),
    OWNER_TOKEN: token,
    DATABASE_PATH: path.join(workspace, 'data.sqlite'),
    DOTS_DESKTOP_API_ONLY: '1',
    DOTS_RUNTIME_ROOT: bundle,
    CONVERSATION_BACKEND: 'intelligence',
    LLM_BACKEND: 'openai',
    OPENAI_API_KEY: '',
    INTELLIGENCE_API_KEY: '',
    CPK_INTELLIGENCE_API_KEY: '',
    DO_NOT_TRACK: '1',
  },
  stdio: 'ignore',
});
let failed;
child.on('error', (error) => {
  failed = error;
});
try {
  let identity;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (failed || child.exitCode !== null)
      throw new Error(
        `Bundled backend exited before readiness (${child.exitCode}).`,
      );
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/desktop/identity`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(500),
        },
      );
      if (response.ok) {
        identity = await response.json();
        break;
      }
    } catch {
      /* Wait for bundled startup. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (
    identity?.service !== 'my-own-dots' ||
    identity.protocol !== 1 ||
    !/^[a-f0-9]{64}$/.test(identity.workspaceId)
  )
    throw new Error('Packaged identity failed.');
  if ((await fetch(`http://127.0.0.1:${port}/`)).status !== 404)
    throw new Error('Packaged backend served browser assets.');
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok || !Array.isArray((await response.json()).tasks))
    throw new Error('Packaged SQLite API failed.');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const done = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([
      done,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await done;
    }
  }
  await rm(workspace, { recursive: true, force: true });
}

console.log(
  'PASS: Electron bundled Node launched shipped ESM backend outside checkout, authenticated identity, SQLite API, API-only response and clean shutdown. No AI calls.',
);
