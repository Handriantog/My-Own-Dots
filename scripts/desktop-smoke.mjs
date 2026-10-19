import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopProcess } from './desktop-smoke-process.mjs';

// Process/API acceptance only. Native UI interaction belongs to a separate check.
const root = fileURLToPath(new URL('..', import.meta.url));
if (process.argv.includes('--help')) {
  console.log(
    'Usage: npm run desktop:smoke -- [packaged-executable]\nBuild first with npm run desktop:build. Uses a disposable workspace and userData; no AI, Docker or microphone. Writes artifacts/desktop/process-smoke.json.',
  );
  process.exit(0);
}
if (process.argv.length > 3)
  throw new Error('Supply at most one executable path.');
const executable = process.argv[2]
  ? path.resolve(process.argv[2])
  : createRequire(import.meta.url)('electron');
const args = process.argv[2] ? [] : [path.join(root, 'dist/desktop')];
const directory = await mkdtemp(path.join(tmpdir(), 'dots-desktop-smoke-'));
const workspace = path.join(directory, 'workspace');
const data = path.join(directory, 'userData');
const database = path.join(workspace, 'data.sqlite');
const lock = `${database}.runtime-lock`;
const reportPath = path.join(root, 'artifacts/desktop/process-smoke.json');
const report = {
  at: new Date().toISOString(),
  executable: process.argv[2] ? executable : 'development bundle',
  checks: [],
  limits:
    'Process/API checks only: no native pixels, navigation, compact handoff, real conversations, AI calls, microphone, speaker, Docker or subscription setup acceptance.',
};
const interruption = new AbortController();
const interrupted = () => interruption.abort(new Error('Smoke interrupted.'));
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    interruption.signal.throwIfAborted();
    if (await check()) return;
    await delay(50);
  }
  throw new Error(message);
}
async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
let child;
let childError;
let backendPid;
let port;
let output = '';
try {
  await mkdir(workspace);
  await mkdir(data);
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const token = randomBytes(32).toString('hex');
  await writeFile(
    path.join(workspace, '.env'),
    `HOST=127.0.0.1\nPORT=${port}\nDATABASE_PATH=data.sqlite\nOWNER_TOKEN=${token}\nOWNER_ID=disposable-desktop-smoke\nCONVERSATION_BACKEND=intelligence\nLLM_BACKEND=openai\nOPENAI_API_KEY=\nINTELLIGENCE_API_KEY=\nCPK_INTELLIGENCE_API_KEY=\nLOCAL_VOICE_ENABLED=0\nDO_NOT_TRACK=1\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(data, 'preferences.json'),
    JSON.stringify({
      version: 1,
      muted: true,
      paused: true,
      reducedMotion: true,
    }),
  );
  const workspaceId = createHash('sha256')
    .update(path.join(await realpath(workspace), 'data.sqlite'))
    .digest('hex');
  const url = `http://127.0.0.1:${port}`;
  // Do not inherit launcher overrides, provider keys or NODE_OPTIONS.
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG'].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  Object.assign(env, {
    DOTS_DESKTOP_USER_DATA: data,
    DOTS_WORKSPACE_DIR: workspace,
    DO_NOT_TRACK: '1',
  });
  const request = (route, options = {}) =>
    fetch(`${url}${route}`, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(1500), interruption.signal]),
    });
  async function launch() {
    interruption.signal.throwIfAborted();
    assert.equal(await portOpen(port), false, 'Disposable port is occupied.');
    childError = undefined;
    output = '';
    child = spawn(executable, args, {
      cwd: directory,
      env,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.once('error', (error) => {
      childError = error;
    });
    child.stderr.on('data', (chunk) => {
      output = (output + chunk).slice(-4000);
    });
    const started = performance.now();
    await until(
      async () => {
        if (childError) throw childError;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Desktop exited before readiness: ${output}`);
        try {
          const response = await request('/api/desktop/identity');
          if (!response.ok) return false;
          const identity = await response.json();
          assert.equal(identity.service, 'my-own-dots');
          assert.equal(identity.protocol, 1);
          assert.equal(identity.workspaceId, workspaceId);
          return true;
        } catch (error) {
          if (error.code === 'ERR_ASSERTION') throw error;
          return false;
        }
      },
      30_000,
      `Desktop readiness timed out: ${output}`,
    );
    const lease = JSON.parse(await readFile(lock, 'utf8'));
    assert.ok(Number.isInteger(lease.pid) && lease.pid > 0);
    backendPid = lease.pid;
    assert.ok(alive(backendPid), 'Owned backend is not running.');
    return Math.round(performance.now() - started);
  }
  async function quit() {
    const started = performance.now();
    const { forced } = await stopProcess(child);
    assert.equal(forced, false, 'Desktop required forced termination.');
    assert.equal(child.exitCode, 0, 'Desktop did not quit successfully.');
    await until(
      async () => !(await portOpen(port)) && !alive(backendPid),
      7000,
      'Quit left the owned backend or port running.',
    );
    await assert.rejects(readFile(lock), { code: 'ENOENT' });
    const result = {
      shutdownMs: Math.round(performance.now() - started),
      exitCode: child.exitCode,
      signal: child.signalCode,
      ownedBackendStopped: true,
      runtimeLockRemoved: true,
      portClosed: true,
    };
    child = undefined;
    backendPid = undefined;
    return result;
  }
  const startupMs = await launch();
  assert.equal(
    (
      await fetch(`${url}/api/desktop/identity`, {
        signal: AbortSignal.timeout(1500),
      })
    ).status,
    401,
  );
  assert.equal(
    (await request('/', { headers: { authorization: '' } })).status,
    404,
  );
  const state = await request('/api/state');
  assert.equal(state.status, 200);
  assert.ok(Array.isArray((await state.json()).tasks));
  const created = await request('/api/spaces', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Disposable persistence check',
      description: 'No AI calls',
    }),
  });
  assert.equal(created.status, 201);
  const space = await created.json();
  assert.ok(space.id);
  report.checks.push({
    launch: 1,
    startupMs,
    authenticatedIdentity: true,
    unauthenticatedIdentityStatus: 401,
    apiStatus: 200,
    rootStatus: 404,
    persistedSpaceId: space.id,
    ...(await quit()),
  });
  const restartMs = await launch();
  const saved = await request('/api/workspace');
  assert.equal(saved.status, 200);
  assert.ok(
    (await saved.json()).spaces.some(
      (item) =>
        item.id === space.id && item.name === 'Disposable persistence check',
    ),
    'Space did not survive desktop restart.',
  );
  report.checks.push({
    launch: 2,
    startupMs: restartMs,
    sqlitePersistence: true,
    ...(await quit()),
  });
  interruption.signal.throwIfAborted();
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error = String(error);
  process.exitCode = 1;
} finally {
  // Each child owns a fresh detached process group. Never signal by name or port.
  // On failure terminate that group even if the parent exited before its backend.
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      await stopProcess(child, { timeoutMs: 1000 });
      await delay(250);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    } catch (error) {
      if (error.code !== 'ESRCH') report.cleanupError = String(error);
    }
  }
  // Preserve fixtures if shutdown cannot be confirmed; never remove an open DB.
  const stopped =
    (!backendPid || !alive(backendPid)) && (!port || !(await portOpen(port)));
  if (stopped) await rm(directory, { recursive: true, force: true });
  else {
    report.cleanupError = `Disposable fixture retained because backend shutdown was not confirmed: ${directory}`;
    report.pass = false;
    process.exitCode = 1;
  }
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
