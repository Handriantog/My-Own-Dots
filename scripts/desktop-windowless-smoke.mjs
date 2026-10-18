import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// Uses a disposable workspace fixture. Never opens audio devices or calls AI.
const root = fileURLToPath(new URL('..', import.meta.url));
const data = await mkdtemp(path.join(tmpdir(), 'dots-windowless-'));
const artifacts = path.join(root, 'artifacts/desktop/windowless');
await mkdir(artifacts, { recursive: true });
const server = createServer((request, response) => {
  if (request.url === '/api/workspace') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><html><body><div id="root">Windowless voice fixture</div><script>
  window.fixture = { starts: 0, active: false, stops: [], errors: [], gestures: [], captureAttempts: 0 };
  navigator.mediaDevices.getUserMedia = async () => { window.fixture.captureAttempts++; throw Error('No hardware in fixture'); };
  window.addEventListener('dot-voice-start', () => {
    window.fixture.gestures.push(navigator.userActivation.isActive);
    const id = 'fixture-call-' + (++window.fixture.starts);
    window.fixture.callId = id;
    void window.dotVoice.begin(id).then(() => { window.fixture.active = true; }).catch(e => window.fixture.errors.push(e.message));
  });
  window.dotVoice.onStop(reason => {
    window.fixture.stops.push(reason);
    if (window.fixture.active) {
      window.fixture.active = false;
      void window.dotVoice.end(window.fixture.callId);
    }
  });
  window.dotVoice.onTalk(() => {
    void window.dotVoice.setReady(true).then(() => window.dotVoice.activate()).catch(e => window.fixture.errors.push(e.message));
  });
  void window.dotVoice.setReady(true);
  </script></body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
// Capture callbacks while still exercising actual Electron registration. Invoking
// the callback deterministically avoids sending keyboard input to other apps.
const bootstrap = path.join(data, 'smoke.cjs');
await writeFile(
  bootstrap,
  `const electron = require('electron');
global.__dotShortcuts = new Map();
const register = electron.globalShortcut.register.bind(electron.globalShortcut);
const unregister = electron.globalShortcut.unregister.bind(electron.globalShortcut);
electron.globalShortcut.register = (key, callback) => {
  const accepted = register(key, callback);
  if (accepted) global.__dotShortcuts.set(key, callback);
  return accepted;
};
electron.globalShortcut.unregister = key => { global.__dotShortcuts.delete(key); unregister(key); };
const menu = electron.Tray.prototype.setContextMenu;
electron.Tray.prototype.setContextMenu = function(value) { global.__dotMenu = value; return menu.call(this, value); };
require(${JSON.stringify(path.join(root, 'dist/desktop/main.cjs'))});
`,
);
let app;
try {
  app = await electron.launch({
    args: [bootstrap],
    cwd: tmpdir(),
    env: {
      ...process.env,
      DOTS_DESKTOP_DATA: data,
      DOTS_WORKSPACE_URL: `http://127.0.0.1:${server.address().port}/`,
    },
  });
  const overlay = await app.firstWindow();
  await overlay.waitForFunction(() => window.dotDiagnostics?.frames > 5);
  const shortcut = 'Command+Shift+Space';
  assert.equal(
    await app.evaluate(
      ({ globalShortcut }, key) => globalShortcut.isRegistered(key),
      shortcut,
    ),
    true,
  );
  const toggle = (key = shortcut) =>
    app.evaluate((_electron, key) => globalThis.__dotShortcuts.get(key)(), key);
  const chatCreated = app.waitForEvent('window');
  await toggle();
  const chat = await chatCreated;
  await chat.waitForFunction(() => window.fixture?.active);
  assert.deepEqual(await chat.evaluate(() => window.fixture.gestures), [true]);
  assert.equal(await chat.evaluate(() => window.dotVoice.isWindowless()), true);
  const hidden = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('desktop=1'))
        .isVisible(),
    );
  assert.equal(await hidden(), false);
  await overlay.waitForFunction(() => window.dotDiagnostics.frame.voiceActive);
  const position = await overlay.evaluate(
    () => window.dotDiagnostics.frame.simulation.root,
  );
  const poses = {};
  for (const phase of ['listening', 'thinking', 'speaking']) {
    await chat.evaluate(
      (phase) => window.dotVoice.phase(window.fixture.callId, phase),
      phase,
    );
    const start = await overlay.evaluate(
      () => window.dotDiagnostics.frame.simulation.atMs,
    );
    await overlay.waitForFunction(
      (start) => window.dotDiagnostics.frame.simulation.atMs > start + 700,
      start,
    );
    assert.deepEqual(
      await overlay.evaluate(() => window.dotDiagnostics.frame.simulation.root),
      position,
    );
    poses[phase] = await overlay.evaluate(
      () => window.dotDiagnostics.frame.simulation.pose,
    );
    assert.equal(
      await overlay.locator('.voice-status').isVisible(),
      phase !== 'speaking',
    );
    if (phase !== 'speaking')
      assert.equal(
        await overlay.locator('.voice-status').textContent(),
        phase === 'listening' ? 'Listening' : 'Thinking',
      );
    await overlay.screenshot({
      path: path.join(artifacts, `${phase}.png`),
      omitBackground: true,
    });
  }
  assert.ok(poses.speaking.mouth < 0.01);
  await overlay.waitForFunction(
    () => window.dotDiagnostics.frame.simulation.pose.speech > 0.35,
  );
  assert.ok(poses.thinking.look.y < -0.2);
  assert.equal(await hidden(), false);
  await toggle();
  await chat.waitForFunction(() => !window.fixture.active);
  await overlay.waitForFunction(
    () => document.querySelector('.voice-status').hidden,
  );
  assert.ok(
    (await chat.evaluate(() => window.fixture.stops)).includes('shortcut'),
  );
  assert.equal(await hidden(), false);
  assert.equal(
    await chat.evaluate(
      async () =>
        (await navigator.permissions.query({ name: 'microphone' })).state,
    ),
    'denied',
  );
  assert.equal(
    await chat.evaluate(
      async () => (await navigator.permissions.query({ name: 'camera' })).state,
    ),
    'denied',
  );
  const settingsCreated = app.waitForEvent('window');
  await app.evaluate(() =>
    globalThis.__dotMenu.items
      .find((item) => item.label === 'Customize Dot')
      .click(),
  );
  const settings = await settingsCreated;
  await settings.locator('#talk-shortcut').waitFor();
  await settings.locator('#talk-shortcut').click();
  await settings.waitForFunction(
    () =>
      document.querySelector('#talk-shortcut').getAttribute('aria-pressed') ===
      'true',
  );
  assert.equal(
    await app.evaluate(
      ({ globalShortcut }, key) => globalShortcut.isRegistered(key),
      shortcut,
    ),
    false,
  );
  await settings.keyboard.press('Meta+Shift+Y');
  await settings.getByText('Shortcut saved.', { exact: true }).waitFor();
  assert.equal(
    await app.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered('Command+Shift+Y'),
    ),
    true,
  );
  assert.equal(
    await app.evaluate(
      ({ globalShortcut }, key) => globalShortcut.isRegistered(key),
      shortcut,
    ),
    false,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(data, 'preferences.json'), 'utf8'))
      .talkShortcut,
    'Command+Shift+Y',
  );
  await settings.screenshot({
    path: path.join(artifacts, 'settings-custom.png'),
  });
  // A focused settings window must not disable the end-call shortcut.
  await toggle('Command+Shift+Y');
  await chat.waitForFunction(() => window.fixture.active);
  await toggle('Command+Shift+Y');
  await chat.waitForFunction(() => !window.fixture.active);
  // Reject a conflicting replacement without losing the currently working key.
  assert.equal(
    await app.evaluate(({ globalShortcut }) =>
      globalShortcut.register('Command+Shift+U', () => {}),
    ),
    true,
  );
  await settings.locator('#talk-shortcut').click();
  await settings.waitForFunction(
    () =>
      document.querySelector('#talk-shortcut').getAttribute('aria-pressed') ===
      'true',
  );
  await settings.keyboard.press('Meta+Shift+U');
  await settings.getByText(/already in use or unavailable/).waitFor();
  assert.equal(
    await app.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered('Command+Shift+Y'),
    ),
    true,
  );
  await app.evaluate(({ globalShortcut }) =>
    globalShortcut.unregister('Command+Shift+U'),
  );
  await settings.locator('#shortcut-disable').click();
  await settings.getByText('Shortcut disabled.', { exact: true }).waitFor();
  assert.equal(
    await app.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered('Command+Shift+Y'),
    ),
    false,
  );
  await settings.locator('#shortcut-reset').click();
  await settings.getByText('Shortcut saved.', { exact: true }).waitFor();
  await settings.screenshot({ path: path.join(artifacts, 'settings.png') });
  await toggle();
  await chat.waitForFunction(() => window.fixture.active);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  await chat.waitForFunction(() => !window.fixture.active);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
  await overlay.waitForFunction(() => window.dotDiagnostics.frame.visible);
  await toggle();
  await chat.waitForFunction(() => window.fixture.active);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL() === 'dots://app/index.html')
      .webContents.emit(
        'render-process-gone',
        {},
        { reason: 'crashed', exitCode: 1 },
      ),
  );
  await chat.waitForFunction(() => !window.fixture.active);
  assert.equal(await chat.evaluate(() => window.fixture.captureAttempts), 0);
  assert.deepEqual(await chat.evaluate(() => window.fixture.errors), []);
  const report = {
    defaultShortcut: shortcut,
    hiddenStart: true,
    trustedGesture: true,
    stationaryPhases: Object.keys(poses),
    toggleEnd: true,
    settingsRecorder: true,
    persisted: true,
    conflictRollback: true,
    disableAndReset: true,
    lockAndRendererFailureStop: true,
    microphoneCaptureAttempts: 0,
  };
  await writeFile(
    path.join(artifacts, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(data, { recursive: true, force: true });
}
