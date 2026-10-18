import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import path from 'node:path';
import type { Point } from '../shared/contracts.js';
import type { CompanionMenuLayout } from './interaction.js';

const menuPage = 'dots://app/menu.html';

/** A focusable, transparent menu; the ambient Dot remains non-focusing. */
export class CompanionCloudMenu {
  private window: BrowserWindow | null = null;
  private requested = false;
  private revision = 0;
  private layout: CompanionMenuLayout | null = null;
  private ignored = false;
  private readonly onAction = (event: IpcMainEvent, action: unknown) => {
    const window = this.window;
    if (
      !this.requested ||
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !event.senderFrame.url.startsWith(`${menuPage}?`) ||
      !['chat', 'talk', 'hide', 'dismiss'].includes(String(action))
    )
      return;
    this.close();
    if (action === 'chat' || action === 'talk' || action === 'hide')
      this.callbacks.action(action);
  };

  constructor(
    private readonly bundle: string,
    private readonly callbacks: {
      change(open: boolean): void;
      action(action: 'chat' | 'talk' | 'hide'): void;
    },
  ) {
    ipcMain.on('dot:menu:action', this.onAction);
  }

  get isOpen(): boolean {
    return this.requested;
  }

  async open(
    layout: CompanionMenuLayout,
    reducedMotion: boolean,
    voiceReady = false,
  ): Promise<void> {
    if (this.requested) return;
    const revision = ++this.revision;
    this.requested = true;
    this.layout = layout;
    const { bounds } = layout;
    this.callbacks.change(true);
    if (!this.window || this.window.isDestroyed()) {
      const window = new BrowserWindow({
        ...bounds,
        title: 'Dot menu',
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
        skipTaskbar: true,
        alwaysOnTop: true,
        acceptFirstMouse: true,
        type: 'panel',
        webPreferences: {
          preload: path.join(this.bundle, 'menu-preload.cjs'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      this.window = window;
      window.setAlwaysOnTop(true, 'pop-up-menu');
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.on('render-process-gone', () => this.close());
      window.on('blur', () => this.close());
      window.on('closed', () => {
        this.close();
        this.window = null;
      });
    }
    const window = this.window;
    window.setBounds(bounds);
    this.ignored = false;
    window.setIgnoreMouseEvents(false);
    try {
      const params = new URLSearchParams({
        layout: JSON.stringify(layout),
        still: reducedMotion ? '1' : '0',
        voice: voiceReady ? '1' : '0',
      });
      await window.loadURL(`${menuPage}?${params}`);
      if (!this.requested || this.revision !== revision || window.isDestroyed())
        return;
      window.show();
      window.focus();
    } catch {
      if (this.revision === revision) this.close();
    }
  }

  /** Let the Dot and desktop receive pointer input through the open center. */
  pointer(point: Point): void {
    if (
      !this.requested ||
      !this.layout ||
      !this.window ||
      this.window.isDestroyed()
    )
      return;
    const ignored = !Object.values(this.layout.items).some(
      (rect) =>
        point.x >= rect.x &&
        point.x < rect.x + rect.width &&
        point.y >= rect.y &&
        point.y < rect.y + rect.height,
    );
    if (this.ignored === ignored) return;
    this.ignored = ignored;
    this.window.setIgnoreMouseEvents(ignored, { forward: true });
  }

  close(): void {
    if (!this.requested) return;
    this.requested = false;
    ++this.revision;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
    this.callbacks.change(false);
  }

  destroy(): void {
    this.close();
    ipcMain.removeListener('dot:menu:action', this.onAction);
    this.window?.destroy();
    this.window = null;
  }
}
