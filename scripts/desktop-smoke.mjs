import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifactDirectory = path.join(root, 'artifacts/desktop');
await mkdir(artifactDirectory, { recursive: true });
const data = await mkdtemp(path.join(tmpdir(), 'dots-desktop-smoke-'));
await writeFile(
  path.join(data, 'preferences.json'),
  JSON.stringify({
    version: 1,
    color: '#45a7ff',
    volume: 0.33,
    muted: true,
    paused: false,
    reducedMotion: false,
    displayId: null,
    placement: null,
  }),
);
const executablePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : undefined;
const app = await electron.launch({
  ...(executablePath
    ? { executablePath, args: [] }
    : { args: [path.join(root, 'dist/desktop')] }),
  cwd: tmpdir(),
  env: { ...process.env, DOTS_DESKTOP_DATA: data },
});
const errors = [];
app.process().stderr.on('data', (data) => {
  const message = String(data);
  if (!message.includes('Debugger') && !message.includes('For help'))
    errors.push(message.trim());
});
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.dotDiagnostics?.frames > 10, null, {
    timeout: 20000,
  });
  const state = await page.evaluate(() => ({
    action: window.dotDiagnostics.frame.simulation.action,
    position: window.dotDiagnostics.frame.simulation.root,
    frames: window.dotDiagnostics.frames,
    renderMs: window.dotDiagnostics.renderMs,
    node: typeof window.process,
    require: typeof window.require,
    bridge: Object.keys(window.dot).sort(),
    color: window.dotDiagnostics.frame.preferences.color,
    volume: window.dotDiagnostics.frame.preferences.volume,
    audio: window.dotDiagnostics.audio,
  }));
  assert.equal(state.node, 'undefined');
  assert.equal(state.require, 'undefined');
  assert.equal(state.audio?.decoded, 69);
  assert.equal(state.volume, 0.33);
  assert.deepEqual(state.bridge, [
    'ack',
    'onFrame',
    'pointer',
    'ready',
    'reportError',
  ]);
  const windowFlags = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      visible: w.isVisible(),
      focusable: w.isFocusable(),
      focused: w.isFocused(),
      alwaysOnTop: w.isAlwaysOnTop(),
      allSpaces: w.isVisibleOnAllWorkspaces(),
      bounds: w.getBounds(),
    })),
  );
  assert.equal(windowFlags.length, 1);
  assert.equal(windowFlags[0].visible, true);
  assert.equal(windowFlags[0].focusable, false);
  assert.equal(windowFlags[0].alwaysOnTop, true);
  assert.equal(windowFlags[0].allSpaces, true);
  const second = spawn(
    app.process().spawnfile,
    executablePath ? [] : [path.join(root, 'dist/desktop')],
    {
      cwd: tmpdir(),
      env: { ...process.env, DOTS_DESKTOP_DATA: data },
      stdio: 'ignore',
    },
  );
  const secondExit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      second.kill();
      reject(new Error('Second launch did not yield to the existing instance'));
    }, 8000);
    second.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    second.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(secondExit, 0);
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  await page.screenshot({
    path: path.join(artifactDirectory, 'live-overlay.png'),
    omitBackground: true,
  });
  const report = {
    at: new Date().toISOString(),
    executablePath: executablePath ?? 'development bundle',
    state,
    windowFlags,
    secondLaunchExitCode: secondExit,
    errors,
    note: 'Window flags are configuration evidence; native focus, stacking, Spaces and physical drag require separate interaction checks.',
  };
  await writeFile(
    path.join(artifactDirectory, 'smoke.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, []);
} finally {
  await app.close();
  const saved = JSON.parse(
    await readFile(path.join(data, 'preferences.json'), 'utf8'),
  );
  assert.equal(saved.volume, 0.33);
  assert.equal(saved.muted, true);
  assert.ok(saved.displayId);
  assert.ok(saved.placement);
  console.log('Preferences persisted on clean shutdown.');
  await rm(data, { recursive: true, force: true });
}
