import {
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import type { FolderApprovalPending } from '../../shared/folder-access.js';
import {
  approvalPage,
  type FolderApprovalState,
} from '../shared/approval-contract.js';
import type { Rect } from '../shared/contracts.js';
import type { WorkspaceBackendConnection } from './workspace-backend.js';
import { CompanionFolderPicker } from './folder-picker.js';

function localAddress(
  connection?: WorkspaceBackendConnection,
): URL | undefined {
  try {
    const url = new URL(connection!.url);
    if (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    )
      return url;
  } catch {
    /* No active local workspace. */
  }
}

function parseRequests(value: unknown): FolderApprovalPending[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('Invalid approval feed');
  const fields = [
    'requestId',
    'threadId',
    'dotId',
    'dotName',
    'toolCallId',
  ] as const;
  return value.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !fields.every(
        (key) =>
          typeof (entry as Record<string, unknown>)[key] === 'string' &&
          (entry as Record<string, string>)[key].length > 0 &&
          (entry as Record<string, string>)[key].length <= 500,
      )
    )
      throw new Error('Invalid approval request');
    return Object.fromEntries(
      fields.map((key) => [key, (entry as Record<string, string>)[key]]),
    ) as FolderApprovalPending;
  });
}

/** A read-only watcher; only the owner's existing approval card can grant access. */
export class FolderApprovalWindow {
  private window: BrowserWindow | null = null;
  private loaded = false;
  private disposed = false;
  private available = false;
  private healthy = false;
  private connection: WorkspaceBackendConnection | undefined;
  private requests: FolderApprovalPending[] = [];
  private selected: string | null = null;
  private dismissed = new Set<string>();
  private pending?: { controller: AbortController; done: Promise<void> };
  private timer?: ReturnType<typeof setInterval>;
  private lastState = '';
  private lastBounds = '';
  private lastSummary = '';
  private readonly folders: CompanionFolderPicker;
  private readonly context = (event: IpcMainEvent) => {
    event.returnValue = this.trusted(event);
  };

  constructor(
    private readonly bundle: string,
    private readonly getConnection: () =>
      WorkspaceBackendConnection | undefined,
    private readonly getBounds: () => Rect,
    private readonly changed: () => void,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.folders = new CompanionFolderPicker(
      () => this.window,
      () => approvalPage,
      'dot:approval-folders',
      (url) => url === approvalPage,
    );
    ipcMain.on('dot:approval:context', this.context);
    for (const name of ['state', 'dismiss', 'next'] as const)
      ipcMain.handle(`dot:approval:${name}`, (event, ...args: unknown[]) => {
        if (args.length || !this.trusted(event))
          throw new Error('Invalid approval sender');
        if (name === 'state') return this.state();
        if (
          !this.available ||
          !this.healthy ||
          !this.window?.isVisible() ||
          !this.window.isFocused()
        )
          throw new Error('Focus the folder approval window first');
        if (name === 'dismiss') this.dismiss();
        else this.next();
      });
  }

  get count(): number {
    return this.requests.length;
  }
  get isOpen(): boolean {
    return (
      !!this.window && !this.window.isDestroyed() && this.window.isVisible()
    );
  }

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, 1500);
    this.timer.unref();
    void this.refresh();
  }

  /** Called with Dot's visibility and placement; no network work on frame ticks. */
  sync(available: boolean): void {
    if (this.disposed) return;
    this.available = available;
    this.reconcileConnection();
    this.present();
  }

  private reconcileConnection(): void {
    const next = this.getConnection();
    if (next === this.connection) return;
    this.connection = next;
    this.pending?.controller.abort();
    this.pending = undefined;
    this.healthy = false;
    this.requests = [];
    this.selected = null;
    this.dismissed.clear();
    this.window?.destroy();
    this.window = null;
    this.loaded = false;
    this.lastBounds = this.lastState = '';
    this.notify();
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    this.reconcileConnection();
    if (this.pending) return this.pending.done;
    // Keep the same review mounted while its native sheet owns the interaction.
    // Selection and approval still validate the live request on the server.
    if (this.folders.choosing) return;
    const connection = this.connection;
    const address = localAddress(connection);
    if (!connection || !address) {
      this.present();
      return;
    }
    const controller = new AbortController();
    const pending = { controller, done: Promise.resolve() };
    this.pending = pending;
    pending.done = (async () => {
      try {
        const response = await this.fetcher(
          new URL('/api/folder-approvals', address),
          {
            headers: connection.ownerToken
              ? { authorization: `Bearer ${connection.ownerToken}` }
              : {},
            redirect: 'error',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(4000),
            ]),
          },
        );
        if (!response.ok) throw new Error('Approval feed unavailable');
        const requests = parseRequests(await response.json());
        if (
          this.disposed ||
          controller.signal.aborted ||
          this.getConnection() !== connection ||
          this.folders.choosing
        )
          return;
        this.requests = requests;
        this.healthy = true;
        const ids = new Set(requests.map((request) => request.requestId));
        this.dismissed = new Set(
          [...this.dismissed].filter((id) => ids.has(id)),
        );
        if (!this.selected || !ids.has(this.selected))
          this.selected =
            requests.find((request) => !this.dismissed.has(request.requestId))
              ?.requestId ?? null;
      } catch {
        if (
          this.connection === connection &&
          !controller.signal.aborted &&
          !this.folders.choosing
        )
          this.healthy = false;
      } finally {
        if (this.pending === pending) this.pending = undefined;
        if (!this.disposed) this.present();
      }
    })();
    return pending.done;
  }

  review(focus = true): void {
    if (this.disposed) return;
    this.dismissed.clear();
    this.selected ??= this.requests[0]?.requestId ?? null;
    this.present();
    if (focus && this.isOpen) this.window?.focus();
    void this.refresh();
  }

  private dismiss(): void {
    if (this.selected) this.dismissed.add(this.selected);
    this.selected =
      this.requests.find((request) => !this.dismissed.has(request.requestId))
        ?.requestId ?? null;
    this.present();
  }

  private next(): void {
    const index = this.requests.findIndex(
      (request) => request.requestId === this.selected,
    );
    this.selected =
      this.requests[(index + 1) % this.requests.length]?.requestId ?? null;
    if (this.selected) this.dismissed.delete(this.selected);
    this.present();
  }

  private state(): FolderApprovalState {
    return {
      request: this.healthy
        ? (this.requests.find(
            (request) => request.requestId === this.selected,
          ) ?? null)
        : null,
      count: this.requests.length,
    };
  }

  private trusted(
    event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  ): boolean {
    return (
      !this.disposed &&
      !!this.window &&
      !this.window.isDestroyed() &&
      this.getConnection() === this.connection &&
      event.sender === this.window.webContents &&
      event.senderFrame === this.window.webContents.mainFrame &&
      event.senderFrame?.url === approvalPage
    );
  }

  private present(): void {
    const show =
      this.available && this.healthy && !!this.selected && !this.disposed;
    if (show && !this.window) this.create();
    const window = this.window;
    if (window && !window.isDestroyed()) {
      const state = this.state();
      const serialized = JSON.stringify(state);
      if (this.loaded && serialized !== this.lastState) {
        this.lastState = serialized;
        window.webContents.send('dot:approval:changed', state);
      }
      if (show && this.loaded) {
        const bounds = this.getBounds();
        const serializedBounds = JSON.stringify(bounds);
        if (serializedBounds !== this.lastBounds) {
          window.setBounds(bounds);
          this.lastBounds = serializedBounds;
        }
        if (!window.isVisible()) window.showInactive();
      } else if (window.isVisible()) window.hide();
    }
    this.notify();
  }

  private notify(): void {
    const summary = `${this.isOpen}:${this.count}`;
    if (summary === this.lastSummary) return;
    this.lastSummary = summary;
    this.changed();
  }

  private create(): void {
    const window = new BrowserWindow({
      ...this.getBounds(),
      show: false,
      title: 'Dot folder approval',
      frame: false,
      backgroundColor: '#fafaf8',
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(this.bundle, 'approval-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    this.window = window;
    this.loaded = false;
    this.lastBounds = this.lastState = '';
    this.folders.attach(window);
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-redirect', (event) => event.preventDefault());
    window.on('close', (event) => {
      event.preventDefault();
      this.dismiss();
    });
    window.on('closed', () => {
      if (this.window !== window) return;
      this.window = null;
      this.loaded = false;
      this.notify();
    });
    window.webContents.on('render-process-gone', () => {
      this.healthy = false;
      window.destroy();
    });
    void window
      .loadURL(approvalPage)
      .then(() => {
        if (this.disposed || this.window !== window || window.isDestroyed())
          return;
        this.loaded = true;
        this.present();
      })
      .catch(() => {
        if (this.window !== window) return;
        this.healthy = false;
        window.destroy();
      });
  }

  destroy(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.pending?.controller.abort();
    this.folders.destroy();
    ipcMain.removeListener('dot:approval:context', this.context);
    for (const name of ['state', 'dismiss', 'next'])
      ipcMain.removeHandler(`dot:approval:${name}`);
    this.window?.destroy();
    this.window = null;
  }
}
