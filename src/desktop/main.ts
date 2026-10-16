import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  screen,
  shell,
  systemPreferences,
  Tray,
  type IpcMainEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompanionSimulation } from './core/simulation.js';
import { hitTestRig } from './core/rig-model.js';
import { buildWorld } from './core/world.js';
import { HelperSupervisor } from './host/helper.js';
import { PreferenceStore } from './host/preferences.js';
import { PresentationMailbox, validPointerInput } from './host/presentation.js';
import type {
  DesktopDisplay,
  GeometrySnapshot,
  Preferences,
  PresentationFrame,
} from './shared/contracts.js';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dots',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    },
  },
]);
app.setName('My Own Dots');
app.setPath(
  'userData',
  process.env.DOTS_DESKTOP_DATA ||
    path.join(app.getPath('appData'), 'My Own Dots Desktop'),
);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(start)
    .catch((error) => {
      console.error('Desktop companion startup failed:', error);
      app.quit();
    });
}

async function start(): Promise<void> {
  if (process.platform !== 'darwin')
    throw new Error('This companion build currently supports macOS only.');
  const rendererDirectory = path.join(__dirname, 'renderer');
  protocol.handle('dots', (request) => {
    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad path', { status: 400 });
    }
    const file = path.resolve(rendererDirectory, `.${pathname}`);
    if (url.host !== 'app' || !file.startsWith(rendererDirectory + path.sep))
      return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  app.dock?.hide();
  const store = new PreferenceStore(app.getPath('userData'));
  let preferences = await store.load();
  const displays = (): DesktopDisplay[] =>
    screen
      .getAllDisplays()
      .map((d) => ({
        id: String(d.id),
        bounds: d.bounds,
        workArea: d.workArea,
        scaleFactor: d.scaleFactor,
      }));
  let currentDisplays = displays();
  let world = buildWorld(null, currentDisplays, performance.now());
  const savedDisplay = currentDisplays.find(
    (d) => d.id === preferences.displayId,
  );
  const savedPoint =
    savedDisplay && preferences.placement
      ? {
          x:
            savedDisplay.workArea.x +
            preferences.placement.x * savedDisplay.workArea.width,
          y:
            savedDisplay.workArea.y +
            preferences.placement.y * savedDisplay.workArea.height,
        }
      : undefined;
  let simulation = new CompanionSimulation(world, Date.now(), savedPoint);
  let overlay: BrowserWindow;
  let rendererReady = false,
    userHidden = false,
    osSuspended = false,
    sceneInvalid = false,
    visible = false,
    capturing = false,
    quitting = false;
  let status = 'Starting desktop companion…',
    assetError = '',
    restarts = 0,
    sequence = 0;
  let displayRevision = 0,
    worldKey = '',
    lastSaved = 0,
    mode = '';
  let ignored = true;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const mailbox = new PresentationMailbox();
  const tray = new Tray(
    nativeImage
      .createFromPath(path.join(rendererDirectory, 'desktop-dot/icon.png'))
      .resize({ width: 20, height: 20 }),
  );
  tray.setToolTip('My Own Dots — your desktop companion');
  const helper = new HelperSupervisor(
    path.join(__dirname, 'native/desktop-observer'),
    {
      scene: (snapshot) => {
        sceneInvalid = !snapshot.sceneValid;
        refreshWorld(snapshot);
        syncVisibility();
      },
      status: (message) => {
        setStatus(message);
        cancelCapture();
        refreshWorld(null);
      },
      pointer: (input) => {
        if (!capturing) return;
        simulation.pointer({
          kind: input.down ? 'move' : 'up',
          point: input.point,
          atMs: performance.now(),
        });
        if (!input.down) {
          capturing = false;
          helper.command('release');
        }
      },
    },
  );
  function setStatus(next: string): void {
    if (status !== next) {
      status = next;
      rebuildMenu();
    }
  }
  function updateOptions(): void {
    simulation.setOptions({
      paused: preferences.paused,
      reducedMotion:
        preferences.reducedMotion ||
        systemPreferences.getAnimationSettings().prefersReducedMotion,
    });
  }
  function savePreferences(): Promise<void> {
    const f = simulation.frame(),
      d = currentDisplays.find((d) => d.id === f.displayId);
    if (d && !f.grip)
      preferences = {
        ...preferences,
        displayId: d.id,
        placement: {
          x: Math.max(
            0,
            Math.min(1, (f.root.x - d.workArea.x) / d.workArea.width),
          ),
          y: Math.max(
            0,
            Math.min(1, (f.root.y - d.workArea.y) / d.workArea.height),
          ),
        },
      };
    return store.save(preferences).catch(() => {
      setStatus('Could not save companion preferences');
    });
  }
  function changePreferences(change: Partial<Preferences>): void {
    preferences = { ...preferences, ...change };
    updateOptions();
    rebuildMenu();
    void savePreferences();
  }
  function cancelCapture(): void {
    simulation.pointer({
      kind: 'cancel',
      point: screen.getCursorScreenPoint(),
      atMs: performance.now(),
    });
    capturing = false;
    helper.command('release');
    if (overlay && !overlay.isDestroyed()) {
      overlay.setIgnoreMouseEvents(true, { forward: true });
      ignored = true;
    }
  }
  function refreshWorld(snapshot: GeometrySnapshot | null): void {
    const key = `${snapshot?.helperSession ?? 'none'}:${snapshot?.seq ?? 0}:${displayRevision}`;
    if (key === worldKey) return;
    worldKey = key;
    world = buildWorld(
      snapshot,
      currentDisplays,
      performance.now(),
      new Set([process.pid]),
    );
    simulation.setWorld(world);
    if (snapshot && !assetError)
      setStatus(
        snapshot.accessibility
          ? snapshot.sceneValid
            ? 'Window playground active'
            : 'Refreshing desktop scene…'
          : 'Floor-only · enable Accessibility for window play',
      );
    else if (!snapshot && !assetError)
      setStatus('Floor-only · window tracking unavailable');
  }
  function syncVisibility(): void {
    const next =
      rendererReady &&
      !userHidden &&
      !osSuspended &&
      !sceneInvalid &&
      !assetError;
    if (next === visible || !overlay || overlay.isDestroyed()) return;
    visible = next;
    if (visible) {
      simulation.resume(performance.now());
      mailbox.reset();
      overlay.showInactive();
    } else {
      cancelCapture();
      simulation.suspend();
      mailbox.reset();
      const frame = presentation(false);
      overlay.webContents.send('dot:frame', frame);
      overlay.hide();
    }
    rebuildMenu();
  }
  function rebuildMenu(): void {
    const items: MenuItemConstructorOptions[] = [
      { label: 'My Own Dots', enabled: false },
      {
        label: assetError
          ? `Character needs recovery: ${assetError.slice(0, 65)}`
          : status,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: preferences.paused ? 'Resume roaming' : 'Pause roaming',
        type: 'checkbox',
        checked: preferences.paused,
        click: () => changePreferences({ paused: !preferences.paused }),
      },
      {
        label: 'Reduce motion',
        type: 'checkbox',
        checked: preferences.reducedMotion,
        click: () =>
          changePreferences({ reducedMotion: !preferences.reducedMotion }),
      },
      {
        label: userHidden ? 'Show Dot' : 'Hide Dot',
        click: () => {
          userHidden = !userHidden;
          syncVisibility();
        },
      },
      {
        label: 'Recover companion',
        click: () => {
          userHidden = false;
          assetError = '';
          restarts = 0;
          if (!rendererReady) recoverRenderer();
          else {
            helper.restart();
            syncVisibility();
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Enable window play in System Settings…',
        click: () => {
          systemPreferences.isTrustedAccessibilityClient(true);
          void shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
          );
        },
      },
      { label: 'Retry window tracking', click: () => helper.restart() },
      { type: 'separator' },
      {
        label: 'Quit My Own Dots',
        accelerator: 'Command+Q',
        click: () => app.quit(),
      },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(items));
  }
  function presentation(show = visible): PresentationFrame {
    const state = simulation.frame();
    const cursor = screen.getCursorScreenPoint();
    return {
      sequence: ++sequence,
      sentAtMs: performance.now(),
      origin: {
        x: Math.floor(state.root.x - 160),
        y: Math.floor(state.root.y - 200),
      },
      simulation: state,
      events: simulation.drainEvents(),
      preferences: { ...preferences },
      hovered: hitTestRig(cursor, state),
      visible: show,
    };
  }
  function deliver(frame: PresentationFrame | null): void {
    if (!frame || !rendererReady || overlay.isDestroyed()) return;
    const current = overlay.getBounds();
    if (current.x !== frame.origin.x || current.y !== frame.origin.y)
      overlay.setPosition(frame.origin.x, frame.origin.y, false);
    const actual = overlay.getBounds();
    frame.origin = { x: actual.x, y: actual.y };
    overlay.webContents.send('dot:frame', frame);
  }
  function trusted(event: IpcMainEvent): boolean {
    return (
      !overlay.isDestroyed() &&
      event.sender.id === overlay.webContents.id &&
      event.senderFrame === overlay.webContents.mainFrame &&
      event.senderFrame.url === 'dots://app/index.html'
    );
  }
  function recoverRenderer(): void {
    rendererReady = false;
    cancelCapture();
    simulation.suspend();
    mailbox.reset();
    if (overlay && !overlay.isDestroyed()) overlay.hide();
    visible = false;
    if (restarts++ >= 2) {
      assetError = 'Renderer unavailable; choose Recover companion';
      rebuildMenu();
      return;
    }
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (quitting) return;
      assetError = '';
      if (overlay.isDestroyed()) createOverlay();
      else void overlay.loadURL('dots://app/index.html');
    }, 300);
  }
  function createOverlay(): void {
    overlay = new BrowserWindow({
      width: 320,
      height: 320,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      type: 'panel',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    overlay.setAlwaysOnTop(true, 'pop-up-menu');
    overlay.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    overlay.setIgnoreMouseEvents(true, { forward: true });
    ignored = true;
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.webContents.on('will-navigate', (event) => event.preventDefault());
    overlay.webContents.on('render-process-gone', () => {
      if (!quitting) recoverRenderer();
    });
    overlay.webContents.on('unresponsive', () => {
      if (!quitting) recoverRenderer();
    });
    overlay.webContents.on('did-fail-load', (_event, _code, message) => {
      assetError = message;
      rendererReady = false;
      syncVisibility();
      rebuildMenu();
    });
    overlay.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        userHidden = true;
        syncVisibility();
      }
    });
    void overlay.loadURL('dots://app/index.html');
  }
  createOverlay();
  updateOptions();
  rebuildMenu();
  ipcMain.on('dot:ready', (event) => {
    if (!trusted(event)) return;
    rendererReady = true;
    assetError = '';
    refreshWorld(helper.current(performance.now()));
    syncVisibility();
    deliver(mailbox.offer(presentation()));
  });
  ipcMain.on('dot:ack', (event, seq: unknown) => {
    if (trusted(event) && typeof seq === 'number' && Number.isSafeInteger(seq))
      deliver(mailbox.ack(seq));
  });
  ipcMain.on('dot:pointer', (event, input: unknown) => {
    if (!trusted(event) || !visible || !validPointerInput(input)) return;
    const actual = screen.getCursorScreenPoint();
    if (input.kind === 'down') {
      if (!hitTestRig(actual, simulation.frame())) return;
      capturing = true;
      helper.command('capture');
    }
    if (!capturing && input.kind !== 'hover') return;
    simulation.pointer({
      kind: input.kind,
      point: actual,
      atMs: performance.now(),
    });
    if (input.kind === 'up' || input.kind === 'cancel') {
      capturing = false;
      helper.command('release');
    }
  });
  ipcMain.on('dot:error', (event, message: unknown) => {
    if (!trusted(event) || typeof message !== 'string') return;
    assetError = message.slice(0, 200);
    rendererReady = false;
    syncVisibility();
    rebuildMenu();
    if (message.includes('Graphics context lost')) recoverRenderer();
  });
  helper.start();
  let tickCount = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    refreshWorld(helper.current(now));
    if (
      osSuspended ||
      userHidden ||
      !rendererReady ||
      sceneInvalid ||
      assetError
    )
      return;
    if (mailbox.stalled(now)) {
      recoverRenderer();
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    simulation.pointer({
      kind: capturing ? 'move' : 'hover',
      point: cursor,
      atMs: now,
    });
    simulation.advance(now);
    const frame = presentation();
    const shouldIgnore = !capturing && !frame.hovered;
    if (ignored !== shouldIgnore) {
      overlay.setIgnoreMouseEvents(shouldIgnore, { forward: true });
      ignored = shouldIgnore;
    }
    deliver(mailbox.offer(frame));
    const newMode = ['idle', 'sit', 'sleep'].includes(frame.simulation.action)
      ? 'idle'
      : 'active';
    if (mode !== newMode) {
      mode = newMode;
      helper.command(newMode);
    }
    if (now - lastSaved > 5000 && !capturing) {
      lastSaved = now;
      void savePreferences();
    }
    if (++tickCount % 120 === 0) updateOptions();
  }, 1000 / 60);
  function refreshDisplays(): void {
    currentDisplays = displays();
    displayRevision++;
    if (!currentDisplays.length) {
      osSuspended = true;
      syncVisibility();
      return;
    }
    if (!currentDisplays.some((d) => d.id === simulation.frame().displayId)) {
      // A removed physical screen has no continuous visible return route.
      overlay.hide();
      visible = false;
      cancelCapture();
      world = buildWorld(null, currentDisplays, performance.now());
      simulation = new CompanionSimulation(world);
      updateOptions();
    }
    helper.command('refresh');
    refreshWorld(helper.current(performance.now()));
    syncVisibility();
  }
  screen.on('display-added', refreshDisplays);
  screen.on('display-removed', refreshDisplays);
  screen.on('display-metrics-changed', refreshDisplays);
  const suspend = () => {
    osSuspended = true;
    syncVisibility();
  };
  const resume = () => {
    osSuspended = false;
    sceneInvalid = false;
    worldKey = '';
    refreshWorld(null);
    helper.command('refresh');
    syncVisibility();
  };
  powerMonitor.on('suspend', suspend);
  powerMonitor.on('lock-screen', suspend);
  powerMonitor.on('resume', resume);
  powerMonitor.on('unlock-screen', resume);
  app.on('second-instance', () => {
    userHidden = false;
    if (rendererReady) syncVisibility();
    else recoverRenderer();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    clearInterval(ticker);
    if (retryTimer) clearTimeout(retryTimer);
    cancelCapture();
    simulation.suspend();
    helper.stop();
    void savePreferences().finally(() => {
      tray.destroy();
      overlay.destroy();
      app.exit(0);
    });
  });
  app.on('window-all-closed', () => {});
}
