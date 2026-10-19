// Historical companion UI harness; not validated for the native workspace migration.
throw new Error(
  'Retired companion UI harness: use npm run desktop:smoke for process/API checks and docs/desktop/verification.md for native acceptance. Update this historical harness before reuse.',
);

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = await mkdtemp(path.join(tmpdir(), 'dots-visibility-'));
const output = path.join(root, 'artifacts/desktop/visibility');
await mkdir(output, { recursive: true });
await writeFile(
  path.join(data, 'preferences.json'),
  JSON.stringify({
    version: 1,
    color: '#45a7ff',
    volume: 0.4,
    muted: false,
    paused: true,
    reducedMotion: false,
    talkShortcut: '',
    displayId: null,
    placement: null,
  }),
);
const bootstrap = path.join(data, 'smoke.cjs');
await writeFile(
  bootstrap,
  `const {Tray}=require('electron');
const setMenu=Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu=function(menu){global.__dotMenu=menu;return setMenu.call(this,menu);};
require(${JSON.stringify(path.join(root, 'dist/desktop/main.cjs'))});`,
);
let app;
try {
  app = await electron.launch({
    // Exercise real Web Audio scheduling with the Chromium output muted.
    args: [bootstrap, '--mute-audio'],
    cwd: tmpdir(),
    env: { ...process.env, DOTS_DESKTOP_DATA: data },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(
    () =>
      window.dotDiagnostics?.frame.appearance.alpha === 1 &&
      !window.dotDiagnostics.frame.appearance.active,
  );
  const nativeVisible = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL() === 'dots://app/index.html')
        .isVisible(),
    );
  const click = (label) =>
    app.evaluate(
      (_electron, label) =>
        globalThis.__dotMenu.items.find((item) => item.label === label).click(),
      label,
    );
  const state = () => page.evaluate(() => window.dotDiagnostics.frame);
  await page.evaluate(() => {
    window.popPlays = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (Math.abs((this.buffer?.duration ?? 0) - 0.12) < 0.0001)
        window.popPlays.push({ ...window.dotDiagnostics.frame.appearance });
      return start.apply(this, args);
    };
  });
  const position = (await state()).simulation.root;
  await click('Hide Dot');
  await page.waitForFunction(() => {
    const a = window.dotDiagnostics.frame.appearance;
    return a.circle === 1 && a.scaleX > 0.2 && a.burst === 1;
  });
  assert.equal(await nativeVisible(), true);
  assert.deepEqual((await state()).simulation.root, position);
  await page.waitForFunction(
    () => window.dotDiagnostics.frame.appearance.alpha === 0,
  );
  // A final renderer acknowledgment triggers the native hide.
  await app.evaluate(
    ({ BrowserWindow }) =>
      new Promise((resolve) => {
        const window = BrowserWindow.getAllWindows().find(
          (w) => w.webContents.getURL() === 'dots://app/index.html',
        );
        if (!window.isVisible()) resolve();
        else window.once('hide', resolve);
      }),
  );
  assert.equal(await nativeVisible(), false);
  const hidePops = await page.evaluate(() => window.popPlays);
  assert.equal(hidePops.length, 1);
  assert.equal(hidePops[0].circle, 1);
  await click('Show Dot');
  await page.waitForFunction(() => {
    const a = window.dotDiagnostics.frame.appearance;
    return a.circle === 1 && a.scaleX > 0.2;
  });
  assert.equal(await nativeVisible(), true);
  assert.deepEqual((await state()).simulation.root, position);
  await page.waitForFunction(
    () =>
      window.dotDiagnostics.frame.appearance.alpha === 1 &&
      !window.dotDiagnostics.frame.appearance.active,
  );
  assert.equal(await page.evaluate(() => window.popPlays.length), 2);
  await click('Hide Dot');
  await page.waitForFunction(
    () => window.dotDiagnostics.frame.appearance.circle > 0.2,
  );
  await click('Show Dot');
  await page.waitForFunction(
    () =>
      window.dotDiagnostics.frame.appearance.alpha === 1 &&
      !window.dotDiagnostics.frame.appearance.active,
  );
  assert.equal(await nativeVisible(), true);
  assert.deepEqual((await state()).simulation.root, position);
  assert.equal(await page.evaluate(() => window.popPlays.length), 2);
  await click('Reduce motion');
  await click('Hide Dot');
  await page.waitForFunction(() => {
    const a = window.dotDiagnostics.frame.appearance;
    return a.alpha > 0 && a.alpha < 1;
  });
  assert.equal((await state()).appearance.scaleX, 1);
  assert.equal((await state()).appearance.scaleY, 1);
  await click('Show Dot');
  await page.waitForFunction(
    () => window.dotDiagnostics.frame.appearance.alpha === 1,
  );
  await click('Hide Dot');
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  assert.equal(await nativeVisible(), false);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('unlock-screen'));
  assert.equal(await nativeVisible(), false); // Preserve explicit user hiding.
  assert.deepEqual(errors, []);
  const report = {
    animatedHide: true,
    animatedShow: true,
    circleBeforePop: true,
    timedAudioCues: true,
    rootAnchored: true,
    quickReversal: true,
    reducedMotionFade: true,
    immediateLockHide: true,
    errors,
  };
  await writeFile(
    path.join(output, 'native-report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app?.close();
  await rm(data, { recursive: true, force: true });
}
