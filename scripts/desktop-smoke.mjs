import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifactDirectory = path.join(root, 'artifacts/desktop');
await mkdir(artifactDirectory, { recursive: true });
const data = await mkdtemp(path.join(tmpdir(), 'dots-desktop-smoke-'));
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
    audio: window.dotDiagnostics.audio,
  }));
  assert.equal(state.node, 'undefined');
  assert.equal(state.require, 'undefined');
  assert.equal(state.audio?.decoded, 69);
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
  await page.screenshot({
    path: path.join(artifactDirectory, 'live-overlay.png'),
    omitBackground: true,
  });
  const report = {
    at: new Date().toISOString(),
    executablePath: executablePath ?? 'development bundle',
    state,
    windowFlags,
    errors,
    note: 'Window flags are configuration evidence; native focus, stacking, Spaces and physical drag require separate interaction checks.',
  };
  await writeFile(
    path.join(artifactDirectory, 'smoke.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
  await rm(data, { recursive: true, force: true });
}
