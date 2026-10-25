import type { ActivityDriver } from '../../shared/abilities/activity.js';
import { AbilityController } from './abilities/controller.js';
import {
  desktopAbilityMethods,
  type DesktopAbilityMethod,
} from '../../shared/abilities/desktop.js';
import {
  BrowserWindow,
  dialog,
  ipcMain,
  screen,
  shell,
  safeStorage,
  type IpcMainInvokeEvent,
} from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  validateWorkspaceConfiguration,
  type WorkspaceBackend,
} from './workspace-backend.js';
import type {
  WorkspaceCommand,
  WorkspaceDestination,
  WorkspaceStatus,
} from '../shared/workspace-contract.js';
import {
  isWorkspacePage,
  workspaceRealtimeOrigin,
  type WorkspaceProtocolConnection,
} from './workspace-protocol.js';
import { destination, destinationFromUrl } from './workspace-navigation.js';
import { CompanionVoiceSession } from './voice-session.js';
import { CompanionFolderPicker } from './folder-picker.js';
import { StorageController } from './storage-controller.js';
import type { DesktopDiagnostics } from './diagnostics.js';
import { ArchiveWorkerClient } from './archive-worker-client.js';
import { BackupKeys } from './backup-keys.js';
import { storageMethods } from '../shared/storage-contract.js';
import {
  accessoriesKey,
  accessoriesQuery,
  DEFAULT_ACCESSORIES,
  DEFAULT_ACCESSORIES_KEY,
  type Accessories,
} from '../shared/accessories.js';
const recovery = 'dots://app/recovery.html';
const setupPage = `${recovery}#setup`;
const isRecoveryPage = (url: string) => url === recovery || url === setupPage;
/** Owns one persistent workspace window; handoff is an event so the editor can guard drafts. */
export class WorkspaceWindow {
  private disposed = false;
  private destroying?: Promise<void>;
  private window: BrowserWindow | null = null;
  private opening?: Promise<void>;
  private retrying?: Promise<void>;
  private connecting?: Promise<void>;
  private initializing = new Set<BrowserWindow>();
  private setup: BrowserWindow | null = null;
  private pendingDestination?: WorkspaceDestination;
  private pendingCommands: WorkspaceCommand[] = [];
  private resetNavigation = new Map<BrowserWindow, string>();
  private transportInterrupted = false;
  private changingConfiguration = false;
  private connection?: WorkspaceProtocolConnection;
  private failure?: WorkspaceStatus;
  private windows = new Set<BrowserWindow>();
  private loaded = new Set<BrowserWindow>();
  private voice: CompanionVoiceSession;
  private folders: CompanionFolderPicker;
  private storage: StorageController;
  private abilities: AbilityController;
  private abilitiesSuspended = false;
  private storageMaintenance = false;
  private unsubscribe: () => void;
  private saving?: ReturnType<typeof setTimeout>;
  private readonly context = (event: Electron.IpcMainEvent) => {
    event.returnValue = this.trusted(event);
  };
  constructor(
    private readonly bundle: string,
    private readonly data: string,
    private readonly backend: WorkspaceBackend,
    private readonly preferences: (dotId?: string) => void | Promise<void>,
    reviewFolders?: () => void,
    private readonly getColor: () => string = () => '#45a7ff',
    private readonly getAccessories: () => Accessories = () =>
      DEFAULT_ACCESSORIES,
    private readonly selectDesktopDot?: (dotId: string) => Promise<void>,
    private readonly diagnostics?: Pick<DesktopDiagnostics, 'record'>,
    activityDriver?: () => ActivityDriver | undefined,
  ) {
    this.voice = new CompanionVoiceSession(
      () => this.window,
      () => 'dots://workspace/',
      {
        active() {},
        ready() {},
        reviewFolders,
        playback: (dotId, active) => this.voicePlayback(dotId, active),
      },
      'dot:workspace-voice',
    );
    this.folders = new CompanionFolderPicker(
      () => this.window,
      () => 'dots://workspace/',
      'dot:workspace-folders',
    );
    this.abilities = new AbilityController({
      activityDriver,
      profile: data,
      bundle,
      storage: safeStorage,
      onUnavailable: (stage, code) => {
        void diagnostics?.record('ability-host-unavailable', { stage, code });
      },
      open: (url) => shell.openExternal(url),
      chooseAbility: async () => {
        const window = this.window;
        if (!window || this.disposed || !window.isVisible()) return;
        const result = await dialog.showOpenDialog(window, {
          title: 'Choose an Ability descriptor',
          filters: [{ name: 'Ability descriptor', extensions: ['json'] }],
          properties: ['openFile'],
        });
        return result.canceled || this.disposed
          ? undefined
          : result.filePaths[0];
      },
      choosePython: async () => {
        const window = this.window;
        if (!window || this.disposed || !window.isVisible()) return;
        const result = await dialog.showOpenDialog(window, {
          title: 'Choose a Python executable',
          properties: ['openFile'],
        });
        return result.canceled || this.disposed
          ? undefined
          : result.filePaths[0];
      },
      approvePython: async (runtime) => {
        const window = this.window;
        if (!window || this.disposed) return false;
        const result = await dialog.showMessageBox(window, {
          type: 'question',
          message: 'Use this Python for Abilities?',
          detail: `Executable: ${runtime.executable}\n\nRead-only access: ${runtime.readRoots.join('\n')}\n\nPython Abilities will use this interpreter. This does not grant access to other personal folders.`,
          buttons: ['Cancel', 'Use Python'],
          defaultId: 0,
          cancelId: 0,
        });
        return !this.disposed && result.response === 1;
      },
    });
    this.storage = new StorageController({
      profile: data,
      keys: (directory) =>
        new BackupKeys({
          file: path.join(directory, 'backup-password.bin'),
          storage: safeStorage,
          platform: process.platform,
        }),
      worker: new ArchiveWorkerClient({
        entry: path.join(bundle, 'archive-worker.cjs'),
      }),
      configuration: () => backend.configuration,
      connection: () => this.connection,
      beforeMaintenance: async () => {
        this.storageMaintenance = true;
        await this.abilities.quiesce();
      },
      afterMaintenance: async () => {
        this.storageMaintenance = false;
        await this.abilities.resumeMaintenance();
        if (!this.disposed && !this.abilitiesSuspended && this.connection)
          await this.abilities.attach(this.connection);
      },
      stopWorkspace: async () => {
        await this.resetDocuments();
        await backend.stop();
      },
      afterRestore: async () => {
        if (!this.disposed) await this.retry();
      },
    });
    this.storage.start();
    this.storage.subscribe((status) => {
      for (const window of this.windows)
        if (!window.isDestroyed())
          window.webContents.send('dot:storage:status', status);
    });
    for (const method of storageMethods) {
      ipcMain.handle(`dot:storage:${method}`, (event, input: unknown) => {
        if (!this.trusted(event)) throw new Error('Invalid storage sender');
        const window = BrowserWindow.fromWebContents(event.sender)!;
        return this.storage.invoke(method, input, {
          trusted: () => this.trusted(event),
          focused: () =>
            !window.isDestroyed() && window.isVisible() && window.isFocused(),
          chooseDirectory: async (kind) => {
            const chosen = await dialog.showOpenDialog(window, {
              title:
                kind === 'backup'
                  ? 'Choose a backup folder outside the workspace'
                  : kind === 'move'
                    ? 'Choose a parent folder for the moved workspace'
                    : 'Choose a parent folder for the restored workspace',
              properties: ['openDirectory', 'createDirectory'],
            });
            return chosen.canceled ? undefined : chosen.filePaths[0];
          },
          openDirectory: async (directory) => {
            const error = await shell.openPath(directory);
            if (error) throw new Error(error);
          },
          chooseBackupFile: async (defaultPath) => {
            const chosen = await dialog.showSaveDialog(window, {
              title: 'Save a Dot backup',
              buttonLabel: 'Choose location',
              defaultPath,
              filters: [{ name: 'Dot backup', extensions: ['dotbackup'] }],
              properties: ['createDirectory', 'showOverwriteConfirmation'],
            });
            return chosen.canceled ? undefined : chosen.filePath;
          },
          chooseArchive: async () => {
            const chosen = await dialog.showOpenDialog(window, {
              title: 'Choose a workspace backup',
              properties: ['openFile'],
              filters: [
                {
                  name: 'Dot workspace backups',
                  extensions: ['dotbackup', 'dotsbackup'],
                },
              ],
            });
            return chosen.canceled ? undefined : chosen.filePaths[0];
          },
          confirmRestore: async (mode) => {
            if (
              process.env.DOTS_WORKSPACE_DIR ||
              process.env.DOTS_WORKSPACE_URL
            )
              throw new Error(
                'The launcher fixes your workspace location. Remove its workspace override before switching to a restored workspace.',
              );
            const result = await dialog.showMessageBox(window, {
              type: 'warning',
              message:
                mode === 'replace'
                  ? 'Back up the current workspace and replace its selection?'
                  : 'Open the restored workspace?',
              detail:
                'Open conversations and unsaved page drafts will close. The original workspace is kept. Restored schedules and external access remain disabled.',
              buttons: [
                'Cancel',
                mode === 'replace'
                  ? 'Back Up and Replace Selection'
                  : 'Open Restored Workspace',
              ],
              defaultId: 0,
              cancelId: 0,
            });
            return result.response === 1;
          },
          confirmMigration: async (mode) => {
            if (
              process.env.DOTS_WORKSPACE_DIR ||
              process.env.DOTS_WORKSPACE_URL
            )
              throw new Error(
                'The launcher fixes your workspace location. Remove its workspace override before upgrading storage.',
              );
            const result = await dialog.showMessageBox(window, {
              type: 'warning',
              message:
                mode === 'prepare'
                  ? 'Upgrade workspace storage?'
                  : 'Finish storage upgrade?',
              detail:
                mode === 'prepare'
                  ? 'Save page drafts first. Dot will close chat, create and verify your backup, then prepare an upgraded copy. Review it before finishing. Your original workspace is kept.'
                  : 'Dot will check that the original data and backup have not changed. Automation will stay paused until you resume it. The original workspace and Docker storage are kept.',
              buttons: [
                'Cancel',
                mode === 'prepare' ? 'Start Upgrade' : 'Finish Upgrade',
              ],
              defaultId: 0,
              cancelId: 0,
            });
            return result.response === 1;
          },
          confirmMove: async (mode) => {
            if (
              process.env.DOTS_WORKSPACE_DIR ||
              process.env.DOTS_WORKSPACE_URL
            )
              throw new Error(
                'The launcher fixes your workspace location. Remove its workspace override before moving.',
              );
            const result = await dialog.showMessageBox(window, {
              type: 'warning',
              message:
                mode === 'prepare'
                  ? 'Prepare a workspace copy at a new location?'
                  : 'Switch to the verified workspace copy?',
              detail:
                'Open conversations and unsaved drafts will close. Dot verifies the copy before switching and keeps the original folder. Schedules pause and external access needs fresh approval.',
              buttons: [
                'Cancel',
                mode === 'prepare' ? 'Prepare Copy' : 'Switch Workspace',
              ],
              defaultId: 0,
              cancelId: 0,
            });
            return result.response === 1;
          },
        });
      });
    }
    for (const method of Object.keys(
      desktopAbilityMethods,
    ) as DesktopAbilityMethod[]) {
      ipcMain.handle(`dot:abilities:${method}`, (event, input: unknown) =>
        this.abilities.invoke(method, input, {
          trusted: () =>
            this.trusted(event) &&
            isWorkspacePage(event.senderFrame?.url ?? ''),
        }),
      );
    }
    ipcMain.on('dot:workspace:context', this.context);
    const handle = (
      name: string,
      callback: (event: IpcMainInvokeEvent, value: unknown) => unknown,
    ) =>
      ipcMain.handle(`dot:workspace:${name}`, (event, value: unknown) => {
        if (!this.trusted(event)) throw new Error('Invalid workspace sender');
        return callback(event, value);
      });
    handle('open', (_event, value) => this.open(destination(value)));
    handle('status', () => this.failure ?? this.backend.status);
    handle('retry', async () => {
      await this.storage.cancelActive();
      return this.retry();
    });
    handle('preferences', (_event, dotId) => {
      if (
        dotId !== undefined &&
        (typeof dotId !== 'string' || !dotId || dotId.length > 128)
      )
        throw new Error('Invalid Dot.');
      return this.preferences(dotId as string | undefined);
    });
    handle('select-desktop-dot', (_event, dotId) => {
      if (
        typeof dotId !== 'string' ||
        !dotId ||
        dotId.length > 128 ||
        !this.selectDesktopDot
      )
        throw new Error('Invalid Dot.');
      return this.selectDesktopDot(dotId);
    });
    handle('backend-settings', () => this.openBackendSettings());
    handle('choose', async (event) => {
      this.requireRecovery(event);
      if (process.env.DOTS_WORKSPACE_DIR || process.env.DOTS_WORKSPACE_URL)
        throw new Error(
          'Your launcher supplies the workspace location. Change DOTS_WORKSPACE_DIR or DOTS_WORKSPACE_URL in the launcher, then reopen the app.',
        );
      const window = BrowserWindow.fromWebContents(event.sender)!;
      if (!window.isVisible() || !window.isFocused())
        throw new Error('Focus the workspace to choose a folder.');
      const selected = await dialog.showOpenDialog(window, {
        title: 'Choose an existing Dots workspace',
        properties: ['openDirectory'],
      });
      if (this.disposed || selected.canceled || !selected.filePaths[0])
        return false;
      this.requireRecovery(event);
      if (this.loaded.size) {
        const confirm = await dialog.showMessageBox(window, {
          type: 'warning',
          message: 'Switch to another workspace?',
          detail:
            'Open conversations and unsaved page drafts in this app will close. Existing workspace data is kept.',
          buttons: ['Cancel', 'Switch Workspace'],
          defaultId: 0,
          cancelId: 0,
        });
        if (this.disposed || confirm.response !== 1) return false;
      }
      this.requireRecovery(event);
      await this.storage.cancelActive();
      await this.resetDocuments();
      if (this.disposed) return false;
      await this.backend.setWorkspaceDirectory(selected.filePaths[0]);
      if (this.disposed) return false;
      await this.retry();
      return true;
    });
    handle('configure', async (event, value) => {
      this.requireRecovery(event);
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([k, v]) => k.length > 80 || typeof v !== 'string' || v.length > 4096,
        )
      )
        throw new Error('Invalid configuration');
      const values = value as Record<string, string>;
      validateWorkspaceConfiguration(values);
      if (this.changingConfiguration)
        throw new Error('Configuration change is already in progress.');
      this.changingConfiguration = true;
      try {
        if (this.loaded.size) {
          const confirm = await dialog.showMessageBox(
            BrowserWindow.fromWebContents(event.sender)!,
            {
              type: 'warning',
              message: 'Apply workspace configuration?',
              detail:
                'Open conversations and unsaved page drafts in this app will close. Existing workspace data is kept.',
              buttons: ['Cancel', 'Apply Configuration'],
              defaultId: 0,
              cancelId: 0,
            },
          );
          if (this.disposed) return;
          if (confirm.response !== 1)
            throw new Error(
              'Configuration change cancelled. Your drafts and settings are unchanged.',
            );
        }
        this.requireRecovery(event);
        // Finish any in-flight navigation before invalidating every old document.
        await this.retrying;
        await this.connecting;
        if (this.disposed) return;
        await this.storage.cancelActive();
        await this.resetDocuments();
        if (this.disposed) return;
        await this.backend.stop();
        if (this.disposed) return;
        await this.backend.configure(values);
      } finally {
        this.changingConfiguration = false;
      }
    });
    this.unsubscribe = backend.subscribe((status) => {
      if (this.disposed) return;
      this.failure = undefined;
      if (status.phase === 'error' || status.phase === 'stopped') {
        this.connection = undefined;
        void this.abilities.suspend().catch(() => {});
      }
      for (const window of this.windows)
        if (!window.isDestroyed())
          window.webContents.send('dot:workspace:status', status);
    });
  }
  get activeConnection() {
    return this.connection;
  }
  customizationChanged(
    state: import('../../shared/dot-customization.js').DesktopDotState,
  ): void {
    for (const window of this.windows)
      if (!window.isDestroyed() && isWorkspacePage(window.webContents.getURL()))
        window.webContents.send('dot:workspace:customization', state);
  }
  private async resetDocuments() {
    await this.abilities.suspend();
    this.pendingDestination = undefined;
    this.connection = undefined;
    this.loaded.clear();
    const resetId = randomUUID();
    for (const window of this.windows) {
      if (window === this.setup || window.isDestroyed()) continue;
      this.resetNavigation.set(window, resetId);
      // The native discard confirmation has already authorized this one unload.
      const allowDiscard = (event: Electron.Event) => event.preventDefault();
      window.webContents.on('will-prevent-unload', allowDiscard);
      try {
        await window.loadURL(recovery);
      } finally {
        window.webContents.removeListener('will-prevent-unload', allowDiscard);
      }
      if (this.disposed) return;
    }
  }
  private sendStatus(status: WorkspaceStatus) {
    for (const window of this.windows)
      if (!window.isDestroyed())
        window.webContents.send('dot:workspace:status', status);
  }
  private trusted(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>) {
    return (
      !this.disposed &&
      [...this.windows].some(
        (w) =>
          !w.isDestroyed() &&
          event.sender === w.webContents &&
          event.senderFrame === w.webContents.mainFrame &&
          (isWorkspacePage(event.senderFrame.url) ||
            isRecoveryPage(event.senderFrame.url)),
      )
    );
  }
  private requireRecovery(event: IpcMainInvokeEvent) {
    if (!this.trusted(event) || !isRecoveryPage(event.senderFrame?.url ?? ''))
      throw new Error('Configuration is available in workspace recovery.');
  }
  voicePlayback(dotId: string, active: boolean): void {
    this.abilities.voicePlayback(dotId, active);
  }

  register(window: BrowserWindow, initializing = false): () => void {
    if (this.disposed) {
      if (!window.isDestroyed()) window.destroy();
      return () => {};
    }
    if (initializing) this.initializing.add(window);
    this.windows.add(window);
    window.on('closed', () => {
      this.windows.delete(window);
      this.initializing.delete(window);
      this.loaded.delete(window);
      this.resetNavigation.delete(window);
    });
    window.webContents.on('render-process-gone', () =>
      this.loaded.delete(window),
    );
    window.webContents.on('did-finish-load', () => {
      if (this.disposed || window.isDestroyed()) return;
      if (isWorkspacePage(window.webContents.getURL())) {
        this.loaded.add(window);
        this.updateAppearance();
        this.resetNavigation.delete(window);
        if (window === this.window)
          for (const command of this.pendingCommands.splice(0))
            window.webContents.send('dot:workspace:command', command);
      } else this.loaded.delete(window);
    });
    return () => {
      this.initializing.delete(window);
    };
  }
  ready(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return (this.connecting ??= this.establish().finally(() => {
      this.connecting = undefined;
    }));
  }
  private async establish() {
    try {
      if (this.disposed) return;
      const connection = await this.backend.start();
      if (this.disposed) return;
      if (!this.abilitiesSuspended && !this.storageMaintenance)
        await this.abilities.attach(connection);
      if (this.disposed) return;
      if (
        this.connection === connection ||
        (this.connection?.url === connection.url &&
          this.connection?.ownerToken === connection.ownerToken)
      )
        return;
      const next: WorkspaceProtocolConnection = { ...connection };
      this.connection = next;
      next.connectOrigin = await workspaceRealtimeOrigin(connection);
      if (this.disposed) return;
      if (this.connection !== next)
        throw new Error('Workspace stopped while connecting.');
    } catch (error) {
      if (!this.disposed) throw error;
    }
  }
  transportFailed() {
    if (this.disposed || this.failure) return;
    void this.diagnostics?.record('workspace-transport-interrupted', {});
    this.transportInterrupted = true;
    void this.abilities.suspend().catch(() => {});
    this.failure = {
      phase: 'error',
      message:
        'Connection to the local workspace was interrupted. Retry to reconnect; your draft stays open.',
    };
    for (const window of this.windows)
      if (!window.isDestroyed())
        window.webContents.send('dot:workspace:status', this.failure);
  }
  retry(): Promise<void> {
    if (this.disposed || this.changingConfiguration) return Promise.resolve();
    return (this.retrying ??= this.reconnect().finally(() => {
      this.retrying = undefined;
    }));
  }
  private async reconnect() {
    try {
      if (this.disposed) return;
      if (
        this.transportInterrupted ||
        (this.connection?.owned && this.connection.warning)
      )
        await this.backend.stop();
      this.transportInterrupted = false;
      if (this.disposed) return;
      await this.ready();
      if (this.disposed) return;
      for (const window of this.windows)
        if (
          window !== this.setup &&
          !this.initializing.has(window) &&
          !window.isDestroyed() &&
          !this.loaded.has(window)
        ) {
          try {
            await window.loadURL(
              `dots://workspace/?surface=${window === this.window ? 'workspace' : 'companion'}&dotColor=${encodeURIComponent(this.getColor())}${accessoriesQuery(this.getAccessories())}${this.resetNavigation.has(window) ? `&resetNavigation=${this.resetNavigation.get(window)}` : ''}`,
            );
          } catch {
            if (!this.disposed) {
              this.failure = {
                phase: 'error',
                message:
                  'The workspace interface could not load. Retry to reopen it; if this persists, reinstall the application.',
              };
              this.sendStatus(this.failure);
            }
            return;
          }
          if (this.disposed || window.isDestroyed()) return;
          if (window === this.window && this.pendingDestination) {
            window.webContents.send(
              'dot:workspace:navigate',
              this.pendingDestination,
            );
            this.pendingDestination = undefined;
          }
        }
      this.failure = undefined;
      this.sendStatus(this.backend.status);
    } catch {
      /* Supervisor emits a safe actionable error to recovery and loaded views. */
    }
  }
  updateAppearance(): void {
    if (this.disposed) return;
    const color = this.getColor();
    const accessories = accessoriesKey(this.getAccessories());
    for (const window of this.windows) {
      if (window.isDestroyed()) continue;
      const current = window.webContents.getURL();
      if (!isWorkspacePage(current)) continue;
      // Only appearance data enters the trusted bundled document. Keep its
      // current route and drafts intact, and retain the tint across reloads.
      void window.webContents
        .executeJavaScript(
          `(() => {
            const url = new URL(location.href);
            if (url.protocol !== 'dots:' || url.host !== 'workspace' ||
                url.pathname !== '/' || url.username || url.password ||
                !['workspace', 'companion'].includes(url.searchParams.get('surface'))) return;
            const color = ${JSON.stringify(color)};
            const accessories = ${JSON.stringify(accessories)};
            const defaultAccessories = ${JSON.stringify(DEFAULT_ACCESSORIES_KEY)};
            if (url.searchParams.get('dotColor') === color &&
                (url.searchParams.get('dotAccessories') || defaultAccessories) === accessories) return;
            url.searchParams.set('dotColor', color);
            if (accessories === defaultAccessories) url.searchParams.delete('dotAccessories');
            else url.searchParams.set('dotAccessories', accessories);
            history.replaceState(history.state, '', url.href);
            window.dispatchEvent(new Event('dot:appearance'));
          })();`,
        )
        .catch(() => {});
    }
  }
  async open(target?: WorkspaceDestination) {
    try {
      if (this.disposed) return;
      if (this.opening) await this.opening;
      if (this.disposed) return;
      if (!this.window || this.window.isDestroyed()) {
        this.opening ??= this.create().finally(() => {
          this.opening = undefined;
        });
        await this.opening;
      }
      if (this.disposed) return;
      const window = this.window!;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      if (target && Object.keys(target).length) {
        if (isWorkspacePage(window.webContents.getURL()))
          window.webContents.send('dot:workspace:navigate', target);
        else this.pendingDestination = target;
      }
    } catch (error) {
      if (!this.disposed) throw error;
    }
  }
  async command(command: WorkspaceCommand) {
    await this.open();
    if (this.disposed || !this.window || this.window.isDestroyed()) return;
    if (this.loaded.has(this.window))
      this.window.webContents.send('dot:workspace:command', command);
    else this.pendingCommands.push(command);
  }
  suspend() {
    if (this.disposed) return;
    this.abilitiesSuspended = true;
    this.voice.stop('suspended');
    void this.abilities.suspend().catch(() => {});
  }
  resume() {
    if (this.disposed) return;
    this.abilitiesSuspended = false;
    if (this.connection && !this.storageMaintenance)
      void this.abilities.attach(this.connection).catch(() => {});
  }
  async recover() {
    await this.openBackendSettings();
  }
  async openBackendSettings() {
    try {
      if (this.disposed) return;
      if (this.setup && !this.setup.isDestroyed()) {
        this.setup.show();
        this.setup.focus();
        return;
      }
      const window = new BrowserWindow({
        width: 720,
        height: 780,
        minWidth: 560,
        minHeight: 600,
        title: 'Workspace setup',
        show: false,
        webPreferences: {
          preload: path.join(this.bundle, 'chat-preload.cjs'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      this.setup = window;
      this.register(window);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guard = (event: Electron.Event, url: string) => {
        if (url !== setupPage) event.preventDefault();
      };
      window.webContents.on('will-navigate', guard);
      window.webContents.on('will-redirect', guard);
      window.on('closed', () => {
        if (this.setup === window) this.setup = null;
      });
      await window.loadURL(setupPage);
      if (this.disposed || window.isDestroyed()) return;
      window.show();
      window.focus();
    } catch (error) {
      if (!this.disposed) throw error;
    }
  }
  private async create() {
    if (this.disposed) return;
    let bounds = { width: 1280, height: 840 };
    try {
      const contents = await readFile(
        path.join(this.data, 'workspace-window.json'),
        'utf8',
      );
      if (this.disposed) return;
      const saved = JSON.parse(contents) as Electron.Rectangle;
      if (
        ['x', 'y', 'width', 'height'].every((k) =>
          Number.isFinite(saved[k as keyof Electron.Rectangle]),
        ) &&
        saved.width >= 900 &&
        saved.height >= 600 &&
        screen
          .getAllDisplays()
          .some(
            (d) =>
              saved.x + saved.width > d.workArea.x &&
              saved.x < d.workArea.x + d.workArea.width &&
              saved.y + saved.height > d.workArea.y &&
              saved.y < d.workArea.y + d.workArea.height,
          )
      )
        bounds = saved;
    } catch {
      /* Default geometry on first launch or removed monitor. */
    }
    if (this.disposed) return;
    const window = new BrowserWindow({
      ...bounds,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: 'My Own Dots',
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#f7f8fa',
      webPreferences: {
        preload: path.join(this.bundle, 'chat-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.window = window;
    this.register(window);
    this.voice.attach(window);
    this.folders.attach(window);
    const external = (url: string) => {
      if (this.disposed) return;
      const target = destinationFromUrl(url);
      if (target) {
        void this.open(target);
        return;
      }
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    };
    window.webContents.setWindowOpenHandler(({ url }) => {
      external(url);
      return { action: 'deny' };
    });
    const guard = (event: Electron.Event, url: string) => {
      const target = destinationFromUrl(url);
      if (target) {
        event.preventDefault();
        void this.open(target);
        return;
      }
      if (isWorkspacePage(url) || url === recovery) return;
      event.preventDefault();
      external(url);
    };
    window.webContents.on('will-navigate', guard);
    window.webContents.on('will-redirect', guard);
    window.webContents.on(
      'did-start-navigation',
      (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) this.voice.stop('navigation');
      },
    );
    window.webContents.on('did-navigate', () => this.voice.reset());
    window.webContents.on('render-process-gone', () => {
      if (this.disposed || window.isDestroyed()) return;
      this.voice.reset();
      this.loaded.delete(window);
      void window.loadURL(recovery).catch(() => {});
    });
    window.webContents.on('unresponsive', () =>
      this.voice.stop('unresponsive'),
    );
    window.on('hide', () => this.voice.stop('hidden'));
    window.on('minimize', () => this.voice.stop('minimized'));
    window.on('close', (event) => {
      event.preventDefault();
      window.hide();
    });
    const save = () => {
      if (this.disposed) return;
      if (this.saving) clearTimeout(this.saving);
      this.saving = setTimeout(() => {
        void this.saveGeometry().catch(() => {});
      }, 300);
    };
    window.on('resize', save);
    window.on('move', save);
    await window.loadURL(recovery);
    if (this.disposed || window.isDestroyed()) return;
    window.show();
    await this.retry();
  }
  private async saveGeometry() {
    if (!this.window || this.window.isDestroyed()) return;
    const bounds = this.window.getNormalBounds();
    await mkdir(this.data, { recursive: true });
    await writeFile(
      path.join(this.data, 'workspace-window.json'),
      JSON.stringify(bounds),
      { mode: 0o600 },
    );
  }
  destroy(): Promise<void> {
    if (this.destroying) return this.destroying;
    // Synchronous terminal barrier: no suspended operation may restart the backend.
    this.disposed = true;
    this.connection = undefined;
    this.pendingDestination = undefined;
    this.pendingCommands = [];
    this.resetNavigation.clear();
    if (this.saving) clearTimeout(this.saving);
    const saved = this.saveGeometry().catch(() => {});
    this.unsubscribe();
    this.voice.destroy();
    this.folders.destroy();
    const abilities = this.abilities.stop();
    const storage = this.storage.close();
    for (const method of storageMethods)
      ipcMain.removeHandler(`dot:storage:${method}`);
    for (const method of Object.keys(desktopAbilityMethods))
      ipcMain.removeHandler(`dot:abilities:${method}`);
    ipcMain.removeListener('dot:workspace:context', this.context);
    for (const name of [
      'open',
      'status',
      'retry',
      'preferences',
      'select-desktop-dot',
      'backend-settings',
      'choose',
      'configure',
    ])
      ipcMain.removeHandler(`dot:workspace:${name}`);
    this.setup?.destroy();
    this.window?.destroy();
    this.setup = null;
    this.window = null;
    this.windows.clear();
    this.loaded.clear();
    this.initializing.clear();
    return (this.destroying = Promise.all([saved, storage, abilities]).then(
      () => {},
    ));
  }
}
