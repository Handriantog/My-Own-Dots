import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  powerMonitor,
  protocol,
  screen,
  shell,
  systemPreferences,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { WorkspaceBackend } from './host/workspace-backend.js';
import { DesktopDots } from './host/desktop-dots.js';
import {
  DEFAULT_DOT_CUSTOMIZATION,
  dotCustomizationChangeSchema,
} from '../shared/dot-customization.js';
import {
  portableConfiguration,
  resolveWorkspaceLocation,
} from './host/workspace-location.js';
import { homedir } from 'node:os';
import { portableMachineBinding } from './host/portable-machine.js';
import { configurePortableProfile } from '../server/storage/restore-journal.js';
import { ArchiveWorkerClient } from './host/archive-worker-client.js';
import { WorkspaceWindow } from './host/workspace-window.js';
import { installWorkspaceMenu } from './host/workspace-menu.js';
import { createWorkspaceProtocol } from './host/workspace-protocol.js';
import { CompanionSimulation } from './core/simulation.js';
import { CompanionVisibility } from './core/visibility.js';
import { hitTestRig } from './core/rig-model.js';
import { buildWorld } from './core/world.js';
import { avatarHeight } from './shared/accessories.js';
import { HelperSupervisor } from './host/helper.js';
import { DesktopDiagnostics } from './host/diagnostics.js';
import { CompanionChatWindow } from './host/chat-window.js';
import { FolderApprovalWindow } from './host/folder-approval-window.js';
import { CompanionCloudMenu } from './host/cloud-menu.js';
import { TalkShortcut } from './host/talk-shortcut.js';
import { shortcutLabel } from './shared/talk-shortcut.js';
import type { CompanionVoiceState } from './shared/voice-contract.js';
import {
  CompanionClick,
  companionPanelBounds,
  companionMenuLayout,
} from './host/interaction.js';
import {
  PreferenceStore,
  parsePreferenceChange,
  restorePlacement,
} from './host/preferences.js';
import {
  PresentationMailbox,
  validPointerInput,
  overlayOrigin,
} from './host/presentation.js';
import type {
  DesktopDisplay,
  GeometrySnapshot,
  PointerInput,
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
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);
app.setName('My Own Dots');
const portable = portableConfiguration({
  platform: process.platform,
  executable: process.execPath,
  root: process.env.DOTS_PORTABLE_ROOT,
  appImage: process.env.APPIMAGE,
});
const desktopLocation = resolveWorkspaceLocation({
  platform: process.platform,
  home: homedir(),
  electronData: path.join(app.getPath('appData'), 'My Own Dots Desktop'),
  executable: process.execPath,
  portableRoot: portable?.root,
  portablePaths: portable?.paths,
});
app.setPath(
  'userData',
  process.env.DOTS_DESKTOP_USER_DATA ||
    process.env.DOTS_DESKTOP_DATA ||
    desktopLocation.profile,
);
const diagnosticsDirectory = path.join(app.getPath('userData'), 'diagnostics');
const diagnostics = new DesktopDiagnostics(diagnosticsDirectory);
process.on('uncaughtExceptionMonitor', (error) => {
  diagnostics.captureException(error);
});
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(start)
    .catch(async (error) => {
      console.error('Desktop companion startup failed:', error);
      await diagnostics.record('startup-failed', {
        message: String(error).slice(0, 2000),
      });
      app.quit();
    });
}

async function start(): Promise<void> {
  if (process.platform !== 'darwin')
    throw new Error('This companion build currently supports macOS only.');
  if (portable)
    await configurePortableProfile(app.getPath('userData'), portable.root);
  const rendererDirectory = path.join(__dirname, 'renderer');
  let sourceRoot: string | undefined;
  if (!app.isPackaged) {
    try {
      sourceRoot = (
        JSON.parse(
          await readFile(path.join(__dirname, 'dev-source.json'), 'utf8'),
        ) as { sourceRoot?: string }
      ).sourceRoot;
    } catch {
      /* Packaged applications use Application Support. */
    }
  }
  const backend = new WorkspaceBackend({
    openWebsite: (url) => shell.openExternal(url),
    bundle: path.join(__dirname, 'app'),
    data: app.getPath('userData'),
    sourceRoot,
    portableRoot: portable?.root,
    portablePaths: portable?.paths,
    portableMachineId: portable
      ? portableMachineBinding(
          path.join(app.getPath('appData'), 'My Own Dots Desktop'),
          portable.root,
        )
      : undefined,
    recoverStorage: async () => {
      await new ArchiveWorkerClient({
        entry: path.join(__dirname, 'archive-worker.cjs'),
      }).run(
        { kind: 'recover', profile: app.getPath('userData') },
        { signal: new AbortController().signal },
      );
    },
  });
  const store = new PreferenceStore(app.getPath('userData'));
  let preferences = await store.load();
  let switchingDesktop = false;
  const workspace = new WorkspaceWindow(
    __dirname,
    app.getPath('userData'),
    backend,
    (dotId) => openSettings(dotId),
    () => folderApprovals.review(false),
    () => preferences.color,
    () => preferences.accessories,
    async (dotId) => {
      if (switchingDesktop)
        throw new Error('The desktop Dot is already switching.');
      if (chat.voiceEngaged)
        throw new Error('End the desktop call before switching Dots.');
      switchingDesktop = true;
      try {
        await desktopDots.select(dotId);
      } finally {
        switchingDesktop = false;
      }
    },
  );
  protocol.handle(
    'dots',
    createWorkspaceProtocol(
      rendererDirectory,
      () => workspace.activeConnection,
      fetch,
      () => workspace.transportFailed(),
    ),
  );
  app.dock?.show();
  void diagnostics.record('startup', {
    executable: process.execPath,
    pid: process.pid,
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  });
  const displays = (): DesktopDisplay[] =>
    screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
    }));
  let currentDisplays = displays();
  let world = buildWorld(null, currentDisplays, performance.now());
  const savedPoint = restorePlacement(preferences, currentDisplays);
  let simulation = new CompanionSimulation(
    world,
    Date.now(),
    savedPoint,
    savedPoint ? (preferences.displayId ?? undefined) : undefined,
  );
  let overlay: BrowserWindow;
  let settingsWindow: BrowserWindow | null = null;
  let settingsDotId: string | undefined;
  let settingsConnection: typeof workspace.activeConnection;
  let voiceActive = false;
  let voiceState: CompanionVoiceState = null;
  let voiceError = '';
  let shortcutError = '';
  const chat = new CompanionChatWindow(
    __dirname,
    app.getPath('userData'),
    () => preferences.color,
    {
      canStart: () => !switchingDesktop,
      active(value) {
        voiceActive = value;
      },
      ready() {
        if (quitting) return;
        companionMenu.close();
        rebuildMenu();
      },
      state(value) {
        if (value && !voiceState) cancelCapture();
        voiceState = value;
        updateOptions();
        if (!quitting) rebuildMenu();
      },
      error: reportVoiceError,
      reviewFolders: () => folderApprovals.review(false),
    },
    workspace,
    () => preferences.accessories,
  );
  let activeDesktopDotId: string | null = null;
  const desktopDots = new DesktopDots(
    () => workspace.activeConnection,
    preferences,
    (state) => {
      const selected = state?.dots.find((dot) => dot.id === state.dotId);
      if (activeDesktopDotId !== (state?.dotId ?? null)) {
        chat.stopVoice('desktop-dot-changed');
        activeDesktopDotId = state?.dotId ?? null;
      }
      applyPreferences(selected?.customization ?? DEFAULT_DOT_CUSTOMIZATION);
      if (state) workspace.customizationChanged(state);
    },
  );
  const clickGesture = new CompanionClick();
  let dismissMenuClick = false;
  let menuOpen = false;
  const companionMenu = new CompanionCloudMenu(__dirname, {
    change(open) {
      menuOpen = open;
      updateOptions();
    },
    action(action) {
      if (action === 'chat') openChat();
      else if (action === 'talk') openTalk();
      else {
        userHidden = true;
        chat.hide();
        syncVisibility();
      }
    },
  });
  let audioError = '';
  let rendererReady = false,
    userHidden = false,
    osSuspended = false,
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
    lastPresented = -Infinity,
    lastDiagnostic = -Infinity,
    mode = '';
  let ignored = true;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let healthySince: number | null = null;
  const mailbox = new PresentationMailbox();
  const appearance = new CompanionVisibility();
  let animatingVisibility = false;
  let hideAfterSequence: number | null = null;
  const tray = new Tray(
    nativeImage
      .createFromPath(path.join(rendererDirectory, 'desktop-dot/icon.png'))
      .resize({ width: 20, height: 20 }),
  );
  tray.setToolTip('My Own Dots — your desktop companion');
  const talkShortcut = new TalkShortcut(globalShortcut, () => {
    toggleWindowlessTalk();
  });
  const helper = new HelperSupervisor(
    path.join(__dirname, 'native/desktop-observer'),
    {
      scene: (snapshot) => {
        refreshWorld(snapshot);
        syncVisibility();
      },
      status: (message) => {
        setStatus(message);
        cancelCapture();
        refreshWorld(null);
        syncVisibility();
      },
      pointer: (input) => {
        if (!capturing) return;
        handlePointer({
          kind: input.down ? 'move' : 'up',
          point: input.point,
          atMs: performance.now(),
        });
      },
    },
  );
  function setStatus(next: string): void {
    if (status !== next) {
      status = next;
      void diagnostics.record('status', { status });
      rebuildMenu();
    }
  }
  const folderApprovals = new FolderApprovalWindow(
    __dirname,
    () => workspace.activeConnection,
    () => panelBounds(320, 250),
    () => {
      updateOptions();
      if (!quitting) rebuildMenu();
    },
  );
  function updateOptions(): void {
    animatingVisibility = appearance.sample(performance.now()).active;
    simulation.setOptions({
      paused: preferences.paused || menuOpen || folderApprovals.isOpen,
      frozen: menuOpen || folderApprovals.isOpen || animatingVisibility,
      voice: voiceState,
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
        placementSpace: 'bounds',
        placement: {
          x: Math.max(0, Math.min(1, (f.root.x - d.bounds.x) / d.bounds.width)),
          y: Math.max(
            0,
            Math.min(1, (f.root.y - d.bounds.y) / d.bounds.height),
          ),
        },
      };
    return store.save(preferences).catch(() => {
      setStatus('Could not save companion preferences');
    });
  }
  function changePreferences(change: Partial<Preferences>): void {
    const dotId = desktopDots.current?.dotId;
    if (!dotId) {
      setStatus('Open your workspace to customize a Dot.');
      return;
    }
    void desktopDots
      .update(dotId, dotCustomizationChangeSchema.parse(change))
      .catch(() => setStatus('Could not save Dot customization.'));
  }
  function applyPreferences(change: Partial<Preferences>): void {
    if (change.talkShortcut !== undefined) {
      talkShortcut.set(change.talkShortcut);
      shortcutError = '';
    }
    preferences = { ...preferences, ...change };
    if (change.accessories) refreshWorld(helper.current(performance.now()));
    if (change.color || change.accessories) {
      chat.updateAppearance();
      workspace.updateAppearance();
    }
    updateOptions();
    rebuildMenu();
    void savePreferences();
  }
  function cancelCapture(): void {
    handlePointer({
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
  function handlePointer(input: PointerInput): void {
    if (input.kind === 'down') {
      dismissMenuClick = companionMenu.isOpen;
      if (dismissMenuClick) companionMenu.close();
    }
    simulation.pointer(input);
    const clicked = clickGesture.pointer(input);
    if (input.kind === 'up' || input.kind === 'cancel') {
      capturing = false;
      helper.command('release');
    }
    if (clicked && !dismissMenuClick) openCompanionMenu();
  }
  function panelBounds(width: number, height: number) {
    const frame = simulation.frame();
    const display =
      currentDisplays.find((d) => d.id === frame.displayId) ??
      currentDisplays[0];
    return companionPanelBounds(frame.root, display.workArea, width, height);
  }
  function openChat(): void {
    if (quitting) return;
    userHidden = false;
    syncVisibility();
    void chat.open(panelBounds(440, 620)).catch((error) => {
      void diagnostics.record('chat-open-failed', {
        message: String(error).slice(0, 300),
      });
    });
  }
  function openTalk(): void {
    if (quitting) return;
    if (switchingDesktop) return;
    userHidden = false;
    syncVisibility();
    void chat.talk(panelBounds(440, 620)).catch((error) => {
      void diagnostics.record('chat-open-failed', {
        message: String(error).slice(0, 300),
      });
    });
  }
  function reportVoiceError(message: string): void {
    voiceError = message.slice(0, 500);
    rebuildMenu();
    if (Notification.isSupported()) {
      const notice = new Notification({
        title: 'Dot could not continue talking',
        body: voiceError,
      });
      notice.on('click', openChat);
      notice.show();
    }
  }
  function toggleWindowlessTalk(): void {
    if (quitting || osSuspended) return;
    if (switchingDesktop) return;
    userHidden = false;
    voiceError = '';
    companionMenu.close();
    syncVisibility();
    if (!visible && !chat.voiceEngaged) {
      reportVoiceError(
        'Dot is unavailable. Choose Recover companion from the menu bar, then try Talk again.',
      );
      return;
    }
    void chat.toggleWindowless(panelBounds(440, 620)).catch((error) => {
      reportVoiceError(
        error instanceof Error
          ? error.message
          : 'Could not start Talk. Open Chat to check your connection.',
      );
    });
  }
  function openCompanionMenu(): void {
    if (quitting) return;
    if (companionMenu.isOpen) {
      companionMenu.close();
      return;
    }
    const frame = simulation.frame();
    const display =
      currentDisplays.find((d) => d.id === frame.displayId) ??
      currentDisplays[0];
    void companionMenu.open(
      companionMenuLayout(frame.root, display.bounds),
      preferences.reducedMotion ||
        systemPreferences.getAnimationSettings().prefersReducedMotion,
      chat.voiceReady,
    );
  }
  function refreshWorld(snapshot: GeometrySnapshot | null): void {
    const key = `${snapshot?.helperSession ?? 'none'}:${snapshot?.seq ?? 0}:${displayRevision}:${avatarHeight(preferences.accessories)}`;
    if (key === worldKey) return;
    worldKey = key;
    if (!snapshot && capturing) cancelCapture();
    world = buildWorld(
      snapshot,
      currentDisplays,
      performance.now(),
      new Set([process.pid]),
      avatarHeight(preferences.accessories),
    );
    simulation.setWorld(world);
    if (snapshot && !assetError)
      setStatus(
        snapshot.accessibility
          ? snapshot.sceneValid
            ? 'Window playground active'
            : 'Refreshing desktop scene…'
          : 'Floor-only · allow this app in Accessibility',
      );
    else if (!snapshot && !assetError)
      setStatus('Floor-only · window tracking unavailable');
  }
  function syncVisibility(): void {
    const now = performance.now();
    const available =
      rendererReady &&
      !osSuspended &&
      helper.current(now)?.sceneValid !== false &&
      !assetError;
    const next = !!available && !userHidden;
    folderApprovals.sync(next);
    if (userHidden || osSuspended) chat.hide();
    if ((!rendererReady || assetError) && chat.windowlessVoice)
      chat.stopVoice('companion-unavailable');
    if (!overlay || overlay.isDestroyed()) return;
    // A lock or invalid scene must also interrupt an already-running hide.
    if (next === visible && (available || !overlay.isVisible())) return;
    visible = next;
    appearance.setVisible(
      visible,
      now,
      preferences.reducedMotion ||
        systemPreferences.getAnimationSettings().prefersReducedMotion,
      !available,
    );
    hideAfterSequence = null;
    healthySince = null;
    void diagnostics.record('visibility', {
      visible,
      rendererReady,
      userHidden,
      osSuspended,
      assetError,
      status,
    });
    if (visible) {
      simulation.resume(now);
    } else {
      companionMenu.close();
      cancelCapture();
      simulation.suspend();
      overlay.setIgnoreMouseEvents(true, { forward: true });
      ignored = true;
      if (!available) overlay.hide();
    }
    updateOptions();
    mailbox.reset();
    deliver(mailbox.offer(presentation()));
    rebuildMenu();
  }
  function rebuildMenu(): void {
    const phaseLabel = voiceState
      ? {
          connecting: 'Connecting…',
          listening: 'Listening',
          thinking: 'Thinking…',
          speaking: 'Speaking',
          approval: folderApprovals.count
            ? 'Needs your folder approval'
            : 'Needs your approval — open Chat',
        }[voiceState]
      : '';
    tray.setToolTip(
      voiceError
        ? `Dot: ${voiceError}`
        : phaseLabel
          ? `Dot: ${phaseLabel}`
          : 'My Own Dots — your desktop companion',
    );
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
        label: 'Open Workspace',
        click: () => {
          void workspace.open();
        },
      },
      { label: 'Chat with Dot', click: openChat },
      {
        label: `Review folder requests (${folderApprovals.count})`,
        enabled: folderApprovals.count > 0,
        click: () => {
          userHidden = false;
          companionMenu.close();
          syncVisibility();
          folderApprovals.review();
        },
      },
      { label: 'Talk with Dot', click: openTalk },
      {
        label: voiceState ? 'End talk' : 'Talk without a window',
        click: toggleWindowlessTalk,
      },
      {
        label: `Talk shortcut: ${shortcutLabel(preferences.talkShortcut)}`,
        enabled: false,
      },
      ...(phaseLabel ? [{ label: phaseLabel, enabled: false }] : []),
      ...(voiceError ? [{ label: voiceError, enabled: false }] : []),
      ...(shortcutError ? [{ label: shortcutError, enabled: false }] : []),
      {
        label: 'Chat connection…',
        click: () => {
          userHidden = false;
          syncVisibility();
          void chat.configure(panelBounds(440, 620)).catch(() => {});
        },
      },
      {
        label: 'Customize Dot',
        click: () => {
          void openSettings().catch(() =>
            setStatus('Open your workspace to customize a Dot.'),
          );
        },
      },
      {
        label: 'Body color',
        submenu: [
          ['Sky', '#45a7ff'],
          ['Rose', '#f5a0be'],
          ['Sage', '#b4e2b3'],
          ['Lavender', '#b8a4ef'],
          ['Cream', '#f4e9d3'],
          ['Midnight', '#292b40'],
        ].map(([label, color]) => ({
          label,
          type: 'radio',
          checked: preferences.color === color,
          click: () => changePreferences({ color }),
        })),
      },
      {
        label: 'Mute effects',
        type: 'checkbox',
        checked: preferences.muted,
        click: () => changePreferences({ muted: !preferences.muted }),
      },
      {
        label: 'Effects volume',
        submenu: [0, 0.2, 0.4, 0.6, 0.8, 1].map((volume) => ({
          label: `${volume * 100}%`,
          type: 'radio',
          checked: preferences.volume === volume,
          click: () => changePreferences({ volume }),
        })),
      },
      ...(audioError
        ? [{ label: 'Sound unavailable · motion still active', enabled: false }]
        : []),
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
      ...(!systemPreferences.isTrustedAccessibilityClient(false)
        ? [
            {
              label:
                'After an update, remove and re-add this app in Accessibility',
              enabled: false,
            },
          ]
        : []),
      { label: 'Retry window tracking', click: () => helper.restart() },
      {
        label: 'Open diagnostic logs…',
        click: () => {
          void shell.openPath(diagnosticsDirectory);
        },
      },
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
    const display =
      currentDisplays.find((d) => d.id === state.displayId) ??
      currentDisplays[0];
    return {
      sequence: ++sequence,
      sentAtMs: performance.now(),
      origin: overlayOrigin(
        state.root,
        display,
        !!state.grip,
        avatarHeight(preferences.accessories),
      ),
      simulation: state,
      events: simulation.drainEvents(),
      preferences: { ...preferences },
      hovered: hitTestRig(cursor, state),
      visible: show,
      appearance: appearance.sample(performance.now()),
      voiceActive,
      voiceState,
      displayBounds: (
        currentDisplays.find((d) => d.id === state.displayId) ??
        currentDisplays[0]
      ).bounds,
    };
  }
  function deliver(frame: PresentationFrame | null): void {
    if (!frame || !rendererReady || overlay.isDestroyed()) return;
    const current = overlay.getBounds();
    if (current.x !== frame.origin.x || current.y !== frame.origin.y)
      overlay.setPosition(frame.origin.x, frame.origin.y, false);
    const actual = overlay.getBounds();
    frame.origin = { x: actual.x, y: actual.y };
    if (!frame.visible && frame.appearance?.alpha === 0)
      hideAfterSequence = frame.sequence;
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
  function recoverRenderer(reason = 'manual'): void {
    // A renderer can report both unresponsive and gone for the same failure.
    if (retryTimer) return;
    if (chat.windowlessVoice) chat.stopVoice('companion-unavailable');
    healthySince = null;
    void diagnostics.record('renderer-recovery', {
      reason,
      attempt: restarts + 1,
    });
    rendererReady = false;
    companionMenu.close();
    cancelCapture();
    simulation.suspend();
    appearance.setVisible(false, performance.now(), false, true);
    hideAfterSequence = null;
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
  function settingsTrusted(event: IpcMainInvokeEvent): boolean {
    return (
      !!settingsWindow &&
      !settingsWindow.isDestroyed() &&
      event.sender.id === settingsWindow.webContents.id &&
      event.senderFrame === settingsWindow.webContents.mainFrame &&
      event.senderFrame.url === 'dots://app/settings.html'
    );
  }
  async function openSettings(dotId?: string): Promise<void> {
    if (quitting) return;
    await workspace.ready();
    const state = await desktopDots.sync();
    if (quitting) return;
    const target = dotId ?? state?.dotId;
    if (!target || !state?.dots.some((dot) => dot.id === target))
      throw new Error('Save this Dot before customizing it.');
    if (
      settingsWindow &&
      (settingsDotId !== target ||
        settingsConnection !== workspace.activeConnection)
    )
      settingsWindow.destroy();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    settingsDotId = target;
    settingsConnection = workspace.activeConnection;
    settingsWindow = new BrowserWindow({
      width: 500,
      height: Math.min(480, screen.getPrimaryDisplay().workArea.height),
      resizable: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: '#1c1c1f',
      title: 'Customize Dot',
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    settingsWindow.webContents.on('will-navigate', (event) =>
      event.preventDefault(),
    );
    settingsWindow.on('closed', () => {
      settingsWindow = null;
      resumeShortcut();
    });
    settingsWindow.on('blur', resumeShortcut);
    settingsWindow.webContents.on('render-process-gone', resumeShortcut);
    settingsWindow.webContents.on('unresponsive', resumeShortcut);
    void settingsWindow.loadURL('dots://app/settings.html');
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
    overlay.webContents.on('console-message', (details) => {
      if (details.level === 'error')
        void diagnostics.record('renderer-console-error', {
          message: details.message.slice(0, 2000),
        });
    });
    overlay.webContents.on('will-navigate', (event) => event.preventDefault());
    overlay.webContents.on('render-process-gone', (_event, details) => {
      void diagnostics.record('renderer-gone', { ...details });
      if (!quitting) recoverRenderer('process-gone');
    });
    overlay.webContents.on('unresponsive', () => {
      if (!quitting) recoverRenderer('unresponsive');
    });
    overlay.webContents.on('did-fail-load', (_event, _code, message) => {
      void diagnostics.record('renderer-load-failed', { code: _code, message });
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
    void diagnostics.record('renderer-ready', {});
    assetError = '';
    refreshWorld(helper.current(performance.now()));
    syncVisibility();
    deliver(mailbox.offer(presentation()));
  });
  ipcMain.on('dot:ack', (event, seq: unknown) => {
    if (
      trusted(event) &&
      typeof seq === 'number' &&
      Number.isSafeInteger(seq)
    ) {
      // Show only after the first frame is painted; keep the native window
      // alive for the entire departure, including its final transparent frame.
      if (mailbox.isAwaiting(seq)) {
        if (visible && !overlay.isVisible()) overlay.showInactive();
        else if (!visible && seq === hideAfterSequence) overlay.hide();
      }
      if (visible && mailbox.isAwaiting(seq)) {
        const now = performance.now();
        healthySince ??= now;
        // Bound consecutive failures, not independent stalls over app lifetime.
        if (now - healthySince >= 5000) restarts = 0;
      }
      deliver(mailbox.ack(seq));
    }
  });
  ipcMain.on('dot:pointer', (event, input: unknown) => {
    if (
      !trusted(event) ||
      !visible ||
      animatingVisibility ||
      !validPointerInput(input)
    )
      return;
    const actual = screen.getCursorScreenPoint();
    if (input.kind === 'down') {
      if (!hitTestRig(actual, simulation.frame())) return;
      capturing = true;
      helper.command('capture');
    }
    if (!capturing && input.kind !== 'hover') return;
    handlePointer({
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
    void diagnostics.record('renderer-error', {
      message: message.slice(0, 2000),
    });
    if (message.startsWith('Audio:')) {
      audioError = message.slice(0, 200);
      rebuildMenu();
      return;
    }
    assetError = message.slice(0, 200);
    rendererReady = false;
    syncVisibility();
    rebuildMenu();
    if (message.includes('Graphics context lost'))
      recoverRenderer('graphics-context-lost');
  });
  folderApprovals.start();
  helper.start();
  try {
    talkShortcut.set(preferences.talkShortcut);
  } catch (error) {
    shortcutError = String(error);
  }
  rebuildMenu();
  function resumeShortcut(): void {
    if (quitting) return;
    try {
      talkShortcut.pause(false);
      talkShortcut.set(preferences.talkShortcut);
      shortcutError = '';
    } catch (error) {
      shortcutError = String(error);
    }
    if (settingsWindow && !settingsWindow.isDestroyed())
      settingsWindow.webContents.send('dot:preferences:capture-reset');
    if (!quitting) rebuildMenu();
  }
  ipcMain.handle('dot:preferences:shortcut-status', (event) => {
    if (!settingsTrusted(event)) throw new Error('Invalid settings sender');
    return shortcutError;
  });
  ipcMain.handle(
    'dot:preferences:capture-shortcut',
    (event, value: unknown) => {
      if (
        !settingsTrusted(event) ||
        typeof value !== 'boolean' ||
        (value && !settingsWindow?.isFocused())
      )
        throw new Error('Focus Customize Dot to record a shortcut.');
      if (value) talkShortcut.pause(true);
      else resumeShortcut();
    },
  );
  function readDotPreferences() {
    const dot = desktopDots.current?.dots.find(
      (dot) => dot.id === settingsDotId,
    );
    if (!dot || settingsConnection !== workspace.activeConnection)
      throw new Error('The workspace changed. Reopen customization.');
    return {
      ...preferences,
      ...dot.customization,
      dotId: dot.id,
      dotName: dot.name,
    };
  }
  ipcMain.handle('dot:preferences:read', (event) => {
    if (!settingsTrusted(event)) throw new Error('Invalid settings sender');
    return readDotPreferences();
  });
  ipcMain.handle('dot:preferences:update', async (event, value: unknown) => {
    if (!settingsTrusted(event)) throw new Error('Invalid settings sender');
    const change = parsePreferenceChange(value);
    if (!change) throw new Error('Invalid preferences');
    const target = readDotPreferences().dotId;
    const { talkShortcut: shortcut, ...customization } = change;
    if (shortcut !== undefined) applyPreferences({ talkShortcut: shortcut });
    if (Object.keys(customization).length)
      await desktopDots.update(
        target,
        dotCustomizationChangeSchema.parse(customization),
      );
    if (!settingsTrusted(event)) throw new Error('Customization was closed.');
    return readDotPreferences();
  });
  let tickCount = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    refreshWorld(helper.current(now));
    // A live transition hides the panel; an expired/unavailable observation
    // is floor-only mode. It must not leave a latched invisible companion.
    syncVisibility();
    if (animatingVisibility !== appearance.sample(now).active) updateOptions();
    if (now - lastDiagnostic >= 5000) {
      lastDiagnostic = now;
      const state = simulation.frame();
      void diagnostics.record('health', {
        visible,
        rendererReady,
        userHidden,
        osSuspended,
        status,
        assetError,
        restarts,
        action: state.action,
        root: state.root,
        displayId: state.displayId,
        bounds: overlay.isDestroyed() ? null : overlay.getBounds(),
        nativeVisible: !overlay.isDestroyed() && overlay.isVisible(),
        appHidden: app.isHidden(),
        accessibility: helper.current(now)?.accessibility ?? null,
      });
    }
    if (!visible && !overlay.isVisible()) return;
    if (mailbox.stalled(now)) {
      recoverRenderer('frame-timeout');
      return;
    }
    if (visible && !animatingVisibility) {
      const cursor = screen.getCursorScreenPoint();
      companionMenu.pointer(cursor);
      handlePointer({
        kind: capturing ? 'move' : 'hover',
        point: cursor,
        atMs: now,
      });
    }
    // Frozen advancement updates the clock without moving the rig, so a short
    // reduced-motion fade cannot accumulate a physics jump on completion.
    if (visible) simulation.advance(now);
    const resting = ['idle', 'sit', 'sleep'].includes(
      simulation.frame().action,
    );
    if (
      visible &&
      resting &&
      !capturing &&
      !animatingVisibility &&
      now - lastPresented < 1000 / 30 - 2
    )
      return;
    lastPresented = now;
    const frame = presentation();
    const shouldIgnore =
      !visible || animatingVisibility || (!capturing && !frame.hovered);
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
      appearance.setVisible(false, performance.now(), false, true);
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
    workspace.suspend();
    osSuspended = true;
    syncVisibility();
  };
  const resume = () => {
    workspace.resume();
    osSuspended = false;
    worldKey = '';
    refreshWorld(null);
    helper.command('refresh');
    syncVisibility();
  };
  powerMonitor.on('suspend', suspend);
  powerMonitor.on('lock-screen', suspend);
  powerMonitor.on('resume', resume);
  powerMonitor.on('unlock-screen', resume);
  installWorkspaceMenu(workspace, () => {
    void openSettings().catch(() =>
      setStatus('Open your workspace to customize a Dot.'),
    );
  });
  app.on('activate', () => {
    if (quitting) return;
    void workspace.open();
  });
  void workspace
    .open()
    .then(() => desktopDots.sync())
    .catch(() => {});
  const customizationTimer = setInterval(() => {
    void desktopDots.sync().catch(() => {});
  }, 3000);
  app.on('second-instance', () => {
    if (quitting) return;
    void workspace.open();
    userHidden = false;
    if (rendererReady) syncVisibility();
    else recoverRenderer();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    folderApprovals.destroy();
    const workspaceShutdown = workspace.destroy();
    talkShortcut.destroy();
    chat.destroy();
    clearInterval(ticker);
    clearInterval(customizationTimer);
    if (retryTimer) clearTimeout(retryTimer);
    cancelCapture();
    simulation.suspend();
    helper.stop();
    void Promise.allSettled([
      savePreferences(),
      workspaceShutdown.finally(() => backend.stop()),
    ]).finally(() => {
      tray.destroy();
      settingsWindow?.destroy();
      companionMenu.destroy();
      overlay.destroy();
      app.exit(0);
    });
  });
  app.on('window-all-closed', () => {});
}
