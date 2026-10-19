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
import { createServer } from 'node:http';

// Start the web workspace before running. --live sends one real AI request.
// The separate voice fixture checks host permissions without opening audio devices.
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, 'artifacts/desktop');
await mkdir(artifacts, { recursive: true });
const data = await mkdtemp(path.join(tmpdir(), 'dots-chat-smoke-'));
await writeFile(
  path.join(data, 'preferences.json'),
  JSON.stringify({
    version: 1,
    color: '#f5a0be',
    volume: 0,
    muted: true,
    paused: false,
    reducedMotion: false,
    displayId: null,
    placement: null,
  }),
);
const workspace = process.env.DOTS_WORKSPACE_URL || 'http://127.0.0.1:4310/';
const executablePath = process.env.DOTS_DESKTOP_EXECUTABLE;
const app = await electron.launch({
  ...(executablePath
    ? { executablePath, args: [] }
    : { args: [path.join(root, 'dist/desktop')] }),
  cwd: tmpdir(),
  env: {
    ...process.env,
    DOTS_DESKTOP_DATA: data,
    DOTS_WORKSPACE_URL: 'http://127.0.0.1:1/',
  },
});
const errors = [];
let closed = false;
// Simulates a running API with no built frontend (a clean dev checkout).
const apiOnly = createServer((request, response) => {
  response.writeHead(request.url === '/api/workspace' ? 200 : 404, {
    'content-type':
      request.url === '/api/workspace' ? 'application/json' : 'text/plain',
  });
  response.end(request.url === '/api/workspace' ? '{}' : 'Not found');
});
await new Promise((resolve) => apiOnly.listen(0, '127.0.0.1', resolve));
const voiceFixture = createServer((request, response) => {
  if (request.url === '/api/workspace') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><html><body><div id="root">Desktop voice boundary fixture</div>
<script>
window.fixture = { talks: 0, starts: 0, activated: false, stops: [], captureAttempts: 0 };
window.addEventListener('dot-voice-start', () => {
  window.fixture.starts++;
  window.fixture.activated = navigator.userActivation.isActive;
});
if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
  window.fixture.captureAttempts++;
  throw new Error('This smoke check must never open an audio device');
};
if (window.dotVoice) window.dotVoice.setReady(true);
</script></body></html>`);
});
await new Promise((resolve) => voiceFixture.listen(0, '127.0.0.1', resolve));
try {
  const overlay = await app.firstWindow();
  await overlay.waitForFunction(() => window.dotDiagnostics?.frames > 5);
  const openMenu = async () => {
    const point = await overlay.evaluate(() => ({
      x: window.dotDiagnostics.frame.simulation.root.x,
      y: window.dotDiagnostics.frame.simulation.root.y - 55,
    }));
    await app.evaluate(({ screen, BrowserWindow, ipcMain }, point) => {
      const original = screen.getCursorScreenPoint;
      screen.getCursorScreenPoint = () => point;
      const window = BrowserWindow.getAllWindows().find(
        (item) => item.webContents.getURL() === 'dots://app/index.html',
      );
      const event = {
        sender: window.webContents,
        senderFrame: window.webContents.mainFrame,
      };
      for (const kind of ['down', 'up'])
        ipcMain.emit('dot:pointer', event, {
          kind,
          point,
          atMs: performance.now(),
        });
      screen.getCursorScreenPoint = original;
    }, point);
  };
  const menuCreated = app.waitForEvent('window');
  await openMenu();
  const menu = await menuCreated;
  await menu.getByRole('button', { name: 'Chat', exact: true }).waitFor();
  assert.equal(await menu.getByRole('button').count(), 3);
  const heldRoot = await overlay.evaluate(
    () => window.dotDiagnostics.frame.simulation.root,
  );
  const heldUntil = await overlay.evaluate(
    () => window.dotDiagnostics.frame.simulation.atMs + 600,
  );
  await overlay.waitForFunction(
    (until) => window.dotDiagnostics.frame.simulation.atMs >= until,
    heldUntil,
  );
  assert.deepEqual(
    await overlay.evaluate(() => window.dotDiagnostics.frame.simulation.root),
    heldRoot,
  );
  assert.equal(
    await menu.getByRole('button', { name: 'Talk', exact: true }).isEnabled(),
    true,
  );
  assert.equal(await menu.evaluate(() => typeof window.require), 'undefined');
  await menu.screenshot({
    path: path.join(artifacts, 'cloud-menu.png'),
    omitBackground: true,
  });
  await menu.keyboard.press('Escape');
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes('menu.html'))
        .isVisible(),
    ),
    false,
  );
  await openMenu();
  await menu.getByRole('button', { name: 'Hide', exact: true }).click();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find(
          (window) => window.webContents.getURL() === 'dots://app/index.html',
        )
        .isVisible(),
    ),
    false,
  );
  await app.evaluate(({ app }) => app.emit('second-instance'));
  await openMenu();
  const newWindow = app.waitForEvent('window');
  await menu.getByRole('button', { name: 'Talk', exact: true }).click();
  const chat = await newWindow;
  chat.on('pageerror', (error) => errors.push(error.message));
  await chat.getByText('Your workspace is offline', { exact: false }).waitFor();
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    3,
  );
  assert.equal(await chat.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await chat.locator('img').count(), 0);
  await chat.screenshot({ path: path.join(artifacts, 'chat-offline.png') });
  await chat
    .getByLabel('Workspace address')
    .fill(`http://127.0.0.1:${apiOnly.address().port}/`);
  await chat.getByRole('button', { name: 'Connect to workspace' }).click();
  await chat.getByText('Your workspace is offline', { exact: false }).waitFor();
  assert.equal(chat.url(), 'dots://app/chat.html');
  let releaseWorkspace;
  const workspaceReady = new Promise((resolve) => {
    releaseWorkspace = resolve;
  });
  await chat.route('**/api/workspace', async (route) => {
    await workspaceReady;
    await route.continue();
  });
  await chat.getByLabel('Workspace address').fill(workspace);
  await chat.getByRole('button', { name: 'Connect to workspace' }).click();
  await chat.locator('.companion-connecting').waitFor();
  assert.equal(await chat.locator('.mascot').count(), 0);
  await chat.screenshot({ path: path.join(artifacts, 'chat-connecting.png') });
  releaseWorkspace();
  await chat.getByLabel('Choose your Dot').waitFor({ timeout: 20000 });
  assert.equal(
    await chat
      .locator('.app')
      .evaluate((element) =>
        [...element.childNodes].some(
          (node) =>
            node.nodeType === Node.TEXT_NODE && node.textContent === '0',
        ),
      ),
    false,
  );
  await chat
    .locator(
      '.empty-chat-persona .companion-avatar canvas[data-color="#f5a0be"]',
    )
    .waitFor();
  assert.equal(await chat.locator('.empty-chat-persona img').count(), 0);
  assert.equal(await chat.evaluate(() => typeof window.dotChat), 'undefined');
  assert.deepEqual(
    await chat.evaluate(() => Object.keys(window.dotVoice).sort()),
    [
      'activate',
      'begin',
      'cancelStart',
      'cancelTalk',
      'end',
      'isWindowless',
      'onStop',
      'onTalk',
      'phase',
      'reportError',
      'setReady',
    ],
  );
  assert.deepEqual(await chat.evaluate(() => Object.keys(window.dotFolders)), [
    'choose',
  ]);
  // Exercise the trusted gesture bridge using a mocked native dialog. Never
  // open the owner's chooser or submit this fixture path for approval.
  await app.evaluate(({ dialog }) => {
    globalThis.folderDialogOriginal = dialog.showOpenDialog;
    globalThis.folderDialogCalls = 0;
    dialog.showOpenDialog = async () => {
      globalThis.folderDialogCalls++;
      return {
        canceled: false,
        filePaths: ['/tmp/dots-folder-picker-fixture'],
      };
    };
  });
  await chat.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'folder-picker-smoke';
    button.textContent = 'Test folder chooser bridge';
    button.onclick = () => {
      void window.dotFolders.choose().then((value) => {
        window.folderPickerSmoke = value;
      });
    };
    document.body.prepend(button);
  });
  await chat.locator('#folder-picker-smoke').click();
  await chat.waitForFunction(
    () => window.folderPickerSmoke?.path === '/tmp/dots-folder-picker-fixture',
  );
  assert.equal(await app.evaluate(() => globalThis.folderDialogCalls), 1);
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis.folderDialogOriginal;
  });
  await chat
    .locator('#folder-picker-smoke')
    .evaluate((element) => element.remove());
  assert.equal(await chat.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await chat.locator('.icon-rail').isVisible(), false);
  assert.equal(await chat.locator('.sidebar').isVisible(), false);
  assert.equal(await chat.locator('.topbar').isVisible(), false);
  assert.equal(await chat.locator('.mobile-menu').isVisible(), false);
  await chat
    .getByLabel('Start a conversation', { exact: true })
    .fill('Hello, Dot');
  await chat.screenshot({ path: path.join(artifacts, 'chat-ready.png') });
  const voiceSettings = chat.getByRole('button', {
    name: 'Voice & personality',
    exact: true,
  });
  if (await voiceSettings.count()) {
    await voiceSettings.click();
    await chat.getByLabel('Voice', { exact: true }).waitFor();
    await chat.waitForFunction(
      () => !document.querySelector('select[aria-label="Voice"]').disabled,
    );
    assert.equal(
      await chat.getByLabel('Voice', { exact: true }).locator('option').count(),
      28,
    );
    assert.equal(
      await chat
        .getByLabel('Personality', { exact: true })
        .locator('option')
        .count(),
      4,
    );
    await chat.screenshot({ path: path.join(artifacts, 'voice-settings.png') });
    await voiceSettings.click();
  }
  await chat
    .getByRole('button', { name: 'Folder access', exact: true })
    .click();
  await chat.locator('.folder-access-panel').waitFor();
  await chat.waitForFunction(
    () => !document.querySelector('.folder-access-panel [role="status"]'),
  );
  assert.equal(
    await chat.locator('.folder-access-panel [role="alert"]').count(),
    0,
  );
  await chat.screenshot({ path: path.join(artifacts, 'folder-settings.png') });
  await chat
    .getByRole('button', { name: 'Folder access', exact: true })
    .click();
  await chat.reload();
  await chat
    .locator(
      '.empty-chat-persona .companion-avatar canvas[data-color="#f5a0be"]',
    )
    .waitFor();
  await chat
    .getByLabel('Start a conversation', { exact: true })
    .fill('Hello, Dot');
  assert.equal(
    await chat.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );

  let liveReply = false;
  if (process.argv.includes('--live')) {
    await chat
      .getByLabel('Start a conversation', { exact: true })
      .fill(
        'This is a desktop chat connection check. Reply only: Desktop chat is connected. Do not use any tools.',
      );
    await chat
      .getByRole('button', { name: 'Start conversation', exact: true })
      .click();
    await chat
      .locator('.chat-bubble.assistant')
      .filter({ hasText: 'Desktop chat is connected.' })
      .waitFor({ timeout: 180000 });
    liveReply = true;
    await chat.screenshot({ path: path.join(artifacts, 'chat-reply.png') });
    const selected = await chat.getByLabel('Conversation history').inputValue();
    await chat.reload();
    await chat
      .locator('.chat-bubble.assistant')
      .filter({ hasText: 'Desktop chat is connected.' })
      .waitFor({ timeout: 20000 });
    assert.equal(
      await chat.getByLabel('Conversation history').inputValue(),
      selected,
    );
  }
  const windowsBefore = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  );
  // Exercise appearance refresh without discarding the current draft. Reopening
  // below must reconcile this stale client color with the host's saved pink.
  if (!liveReply) {
    await chat.evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.set('dotColor', '#b4e2b3');
      history.replaceState(history.state, '', url.href);
      window.dispatchEvent(new Event('dot:appearance'));
    });
    await chat
      .locator('.companion-avatar canvas[data-color="#b4e2b3"]')
      .waitFor();
    assert.equal(
      await chat
        .getByLabel('Start a conversation', { exact: true })
        .inputValue(),
      'Hello, Dot',
    );
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('desktop=1'))
      .close(),
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes('desktop=1'))
        .isVisible(),
    ),
    false,
  );
  await openMenu();
  await menu.getByRole('button', { name: 'Chat', exact: true }).click();
  await chat
    .locator('.companion-avatar canvas[data-color="#f5a0be"]')
    .waitFor();
  if (!liveReply)
    assert.equal(
      await chat
        .getByLabel('Start a conversation', { exact: true })
        .inputValue(),
      'Hello, Dot',
    );
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    windowsBefore,
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes('desktop=1'))
        .isVisible(),
    ),
    true,
  );
  // A disposable workspace validates only the native voice boundary. It does
  // not claim that the live server's models, provider, or microphone are ready.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('desktop=1'))
      .loadURL('dots://app/chat.html'),
  );
  await chat.evaluate(
    (address) => window.dotChat.connect(address),
    `http://127.0.0.1:${voiceFixture.address().port}/`,
  );
  await chat
    .getByText('Desktop voice boundary fixture', { exact: true })
    .waitFor();
  // This no-audio call also acts as an IPC ordering barrier for setReady.
  await chat.evaluate(async () => {
    await window.dotVoice.begin('fixture-ready-12345678');
    await window.dotVoice.end('fixture-ready-12345678');
  });
  await openMenu();
  await menu.getByRole('button', { name: 'Talk', exact: true }).click();
  await chat.evaluate(() => {
    window.dotVoice.onTalk(() => {
      window.fixture.talks++;
    });
  });
  assert.equal(await chat.evaluate(() => window.fixture.talks), 1);
  await chat.evaluate(() => window.dotVoice.activate());
  assert.deepEqual(
    await chat.evaluate(() => ({
      starts: window.fixture.starts,
      activated: window.fixture.activated,
    })),
    { starts: 1, activated: true },
  );
  assert.equal(
    await chat.evaluate(async () => {
      try {
        await window.dotVoice.activate();
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  const beforeCallPermissions = await chat.evaluate(async () => ({
    microphone: (await navigator.permissions.query({ name: 'microphone' }))
      .state,
    camera: (await navigator.permissions.query({ name: 'camera' })).state,
  }));
  assert.equal(beforeCallPermissions.microphone, 'denied');
  assert.equal(beforeCallPermissions.camera, 'denied');
  const rejectedSubframe = await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows().find((item) =>
      item.webContents.getURL().includes('desktop=1'),
    );
    const event = {
      sender: window.webContents,
      senderFrame: { url: window.webContents.mainFrame.url },
      returnValue: null,
    };
    ipcMain.emit('dot:voice:context', event);
    return event.returnValue === false;
  });
  assert.equal(rejectedSubframe, true);
  await chat.evaluate(async () => {
    window.dotVoice.onStop((reason) => {
      window.fixture.stops.push(reason);
      void window.dotVoice.end('fixture-call-12345678');
    });
    await window.dotVoice.begin('fixture-call-12345678');
  });
  await overlay.waitForFunction(
    () => window.dotDiagnostics.frame.voiceActive === true,
  );
  assert.equal(
    await chat.evaluate(
      async () => (await navigator.permissions.query({ name: 'camera' })).state,
    ),
    'denied',
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('desktop=1'))
      .close(),
  );
  await chat.waitForFunction(() => window.fixture.stops.length === 1);
  await overlay.waitForFunction(
    () => window.dotDiagnostics.frame.voiceActive === false,
  );
  const hiddenBeginRejected = await chat.evaluate(async () => {
    try {
      await window.dotVoice.begin('fixture-call-87654321');
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(hiddenBeginRejected, true);
  assert.equal(await chat.evaluate(() => window.fixture.captureAttempts), 0);
  const voiceBoundary = {
    nativeTalkGesture: true,
    activationConsumedOnce: true,
    syntheticWorkspace: true,
    queuedTalkIntent: true,
    microphoneDeniedWithoutCall: true,
    cameraDeniedDuringCall: true,
    forgedSubframeRejected: true,
    hiddenBeginRejected: true,
    closeAcknowledged: true,
    microphoneCaptureAttempts: 0,
  };
  const report = {
    at: new Date().toISOString(),
    cloudBubbles: 3,
    menuHoldsPosition: true,
    customizedCompanionAvatar: true,
    escapeAndHide: true,
    loadingAvatarFlash: false,
    offlineRecovery: true,
    sandboxed: true,
    compactLayout: true,
    reopenReusesWindow: true,
    voiceSettings: { voices: 28, personalities: 4 },
    folderAccess: { mockedNativeChooser: true, settingsLoaded: true },
    liveReply,
    voiceBoundary,
    errors,
  };
  // Do not publish passing evidence before the native lifecycle has shut down.
  await app.close();
  closed = true;
  report.cleanShutdown = true;
  await writeFile(
    path.join(artifacts, 'chat-smoke.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, []);
} finally {
  if (!closed) await app.close();
  await new Promise((resolve) => apiOnly.close(resolve));
  await new Promise((resolve) => voiceFixture.close(resolve));
  await rm(data, { recursive: true, force: true });
}
