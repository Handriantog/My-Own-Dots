import {
  BrowserWindow,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Rect } from '../shared/contracts.js';
import { workspaceAddress } from './interaction.js';
import { CompanionVoiceSession } from './voice-session.js';
import { CompanionFolderPicker } from './folder-picker.js';

const connectionPage = 'dots://app/chat.html';

/** Hosts workspace chat with scoped voice and native folder selection bridges. */
export class CompanionChatWindow {
  private window: BrowserWindow | null = null;
  private address = workspaceAddress();
  private error = '';
  private loading = false;
  private opening: Promise<void> | null = null;
  private readonly voice: CompanionVoiceSession;
  private readonly folders: CompanionFolderPicker;

  constructor(
    private readonly bundle: string,
    private readonly data: string,
    private readonly getColor: () => string = () => '#45a7ff',
    voiceChanged: {
      active(value: boolean): void;
      ready(value: boolean): void;
    } = {
      active() {},
      ready() {},
    },
  ) {
    this.voice = new CompanionVoiceSession(
      () => this.window,
      () => this.address,
      voiceChanged,
    );
    this.folders = new CompanionFolderPicker(
      () => this.window,
      () => this.address,
    );
    ipcMain.handle('dot:chat:status', (event) => {
      this.requireConnectionPage(event);
      return { address: this.address, error: this.error };
    });
    ipcMain.handle('dot:chat:connect', async (event, value: unknown) => {
      this.requireConnectionPage(event);
      if (typeof value !== 'string')
        throw new Error('Invalid workspace address');
      if (this.loading)
        return {
          error:
            'A connection is already in progress. Please try again in a moment.',
        };
      try {
        const address = workspaceAddress(value);
        await writeFile(
          path.join(this.data, 'chat-connection.json'),
          JSON.stringify({ address }),
          { mode: 0o600 },
        );
        this.address = address;
        // Reply before navigation destroys the invoking frame.
        setTimeout(() => void this.connect(), 0);
        return { error: '' };
      } catch (error) {
        return {
          error:
            error instanceof Error
              ? error.message
              : 'Could not save the workspace address.',
        };
      }
    });
  }

  get voiceReady(): boolean {
    return this.voice.ready;
  }

  async talk(bounds: Rect): Promise<void> {
    await this.open(bounds);
    this.voice.talk();
  }

  private requireConnectionPage(event: IpcMainInvokeEvent): void {
    if (
      !this.window ||
      this.window.isDestroyed() ||
      event.sender !== this.window.webContents ||
      event.senderFrame !== this.window.webContents.mainFrame ||
      event.senderFrame.url !== connectionPage
    )
      throw new Error('Invalid chat sender');
  }

  open(bounds: Rect): Promise<void> {
    if (this.opening) return this.opening;
    if (this.window && !this.window.isDestroyed()) {
      this.updateAppearance();
      this.window.setBounds(bounds);
      this.window.show();
      this.window.focus();
      return Promise.resolve();
    }
    this.opening = this.create(bounds).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async create(bounds: Rect): Promise<void> {
    try {
      const saved = JSON.parse(
        await readFile(path.join(this.data, 'chat-connection.json'), 'utf8'),
      ) as { address?: string };
      this.address = workspaceAddress(saved.address);
    } catch {
      /* First launch uses the standard local workspace. */
    }
    try {
      if (process.env.DOTS_WORKSPACE_URL)
        this.address = workspaceAddress(process.env.DOTS_WORKSPACE_URL);
    } catch {
      /* Invalid overrides can be corrected in the connection screen. */
    }
    const window = new BrowserWindow({
      ...bounds,
      title: 'Chat with Dot',
      backgroundColor: '#fafaf8',
      minWidth: Math.min(360, bounds.width),
      minHeight: Math.min(420, bounds.height),
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(this.bundle, 'chat-preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.window = window;
    this.voice.attach(window);
    this.folders.attach(window);
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    const external = (url: string) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    };
    window.webContents.setWindowOpenHandler(({ url }) => {
      external(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (
        url === connectionPage ||
        new URL(url).origin === new URL(this.address).origin
      )
        return;
      event.preventDefault();
      external(url);
    });
    window.webContents.on('will-redirect', (event, url) => {
      if (new URL(url).origin !== new URL(this.address).origin)
        event.preventDefault();
    });
    window.webContents.on('render-process-gone', () => {
      this.voice.reset();
      this.error =
        'The chat window stopped responding. Reconnect to continue your conversation.';
      void window.loadURL(connectionPage).catch(() => {});
    });
    window.webContents.on('unresponsive', () =>
      this.voice.stop('unresponsive'),
    );
    window.webContents.on(
      'did-start-navigation',
      (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) this.voice.stop('navigation');
      },
    );
    window.webContents.on('did-navigate', () => this.voice.reset());
    window.on('hide', () => this.voice.stop('hidden'));
    // No native background call controls exist yet, so minimize ends capture.
    window.on('minimize', () => this.voice.stop('minimized'));
    // Keep the conversation and in-flight response alive when the box is closed.
    window.on('close', (event) => {
      event.preventDefault();
      this.voice.stop('closed');
      window.hide();
    });
    await window.loadURL(connectionPage);
    await this.connect();
  }

  private async connect(): Promise<void> {
    const window = this.window;
    if (!window || window.isDestroyed() || this.loading) return;
    this.loading = true;
    const address = this.address;
    try {
      // A bounded readiness check avoids leaving a blank native window offline.
      const response = await fetch(new URL('api/workspace', address), {
        signal: AbortSignal.timeout(4000),
        redirect: 'error',
      });
      if (!response.ok && response.status !== 401)
        throw new Error('Workspace unavailable');
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new Error('Not a Dots workspace');
      const page = await fetch(address, {
        signal: AbortSignal.timeout(4000),
        redirect: 'error',
      });
      if (
        !page.ok ||
        !page.headers.get('content-type')?.includes('text/html') ||
        !/<div\s+id=["']root["']/.test(await page.text())
      )
        throw new Error('Workspace frontend unavailable');
      this.error = '';
      if (!window.isDestroyed()) {
        const url = new URL(address);
        url.searchParams.set('desktop', '1');
        url.searchParams.set('dotColor', this.getColor());
        await window.loadURL(url.href);
        this.updateAppearance();
      }
    } catch {
      this.error =
        'Your workspace is offline or its chat page is unavailable. Start My Own Dots in Command Center, or run npm run build followed by npm start in your checkout, then retry. For npm run dev, use http://127.0.0.1:5173.';
      if (!window.isDestroyed())
        await window.loadURL(connectionPage).catch(() => {});
    } finally {
      this.loading = false;
    }
  }

  async configure(bounds: Rect): Promise<void> {
    await this.open(bounds);
    this.error =
      'Connect to the workspace that holds your Dots and conversations.';
    await this.window?.loadURL(connectionPage);
  }

  hide(): void {
    this.voice.stop('hidden');
    if (this.window?.isVisible()) this.window.hide();
  }
  updateAppearance(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const current = window.webContents.getURL();
    if (!current) return;
    const url = new URL(current);
    if (
      url.origin !== new URL(this.address).origin ||
      url.searchParams.get('desktop') !== '1'
    )
      return;
    const color = this.getColor();
    if (url.searchParams.get('dotColor') === color) return;
    url.searchParams.set('dotColor', color);
    // Appearance-only data; the voice bridge grants no generic desktop access.
    // Updating the URL also preserves the chosen color on a normal reload.
    void window.webContents
      .executeJavaScript(
        `history.replaceState(history.state, '', ${JSON.stringify(url.href)}); window.dispatchEvent(new Event('dot:appearance'));`,
      )
      .catch(() => {});
  }
  destroy(): void {
    this.folders.destroy();
    this.voice.destroy();
    this.window?.destroy();
    this.window = null;
  }
}
