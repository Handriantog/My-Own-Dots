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
import { isWorkspacePage } from './workspace-protocol.js';
import { destinationFromUrl } from './workspace-navigation.js';
import type { WorkspaceDestination } from '../shared/workspace-contract.js';
import type { CompanionVoiceState } from '../shared/voice-contract.js';
import {
  accessoriesKey,
  accessoriesQuery,
  DEFAULT_ACCESSORIES,
  DEFAULT_ACCESSORIES_KEY,
  type Accessories,
} from '../shared/accessories.js';

const connectionPage = 'dots://app/chat.html';

/** Hosts workspace chat with scoped voice and native folder selection bridges. */
export class CompanionChatWindow {
  private window: BrowserWindow | null = null;
  private address = workspaceAddress();
  private error = '';
  private loading = false;
  private opening: Promise<void> | null = null;
  private request = 0;
  private requestSequence = 0;
  private readonly voice: CompanionVoiceSession;
  private readonly folders: CompanionFolderPicker;

  constructor(
    private readonly bundle: string,
    private readonly data: string,
    private readonly getColor: () => string = () => '#45a7ff',
    private readonly voiceChanged: {
      active(value: boolean): void;
      ready(value: boolean): void;
      state?(value: CompanionVoiceState): void;
      reviewFolders?(): void;
      error?(message: string): void;
      canStart?(): boolean;
    } = {
      active() {},
      ready() {},
    },
    private readonly workspace?: {
      ready(): Promise<void>;
      voicePlayback?(dotId: string, active: boolean): void;
      register(window: BrowserWindow, initializing?: boolean): () => void;
      recover(): Promise<void>;
      open(destination?: WorkspaceDestination): Promise<void>;
    },
    private readonly getAccessories: () => Accessories = () =>
      DEFAULT_ACCESSORIES,
  ) {
    if (workspace) this.address = 'dots://workspace/';
    this.voice = new CompanionVoiceSession(
      () => this.window,
      () => this.address,
      {
        ...voiceChanged,
        playback: (dotId, active) =>
          this.workspace?.voicePlayback?.(dotId, active),
        state: (value) => {
          if (!this.request || value !== null) voiceChanged.state?.(value);
        },
      },
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

  get voiceEngaged(): boolean {
    return !!this.request || this.voice.engaged;
  }
  get windowlessVoice(): boolean {
    return !!this.request || this.voice.isWindowless;
  }

  async toggleWindowless(bounds: Rect): Promise<void> {
    if (this.voiceEngaged) {
      this.stopVoice('shortcut');
      return;
    }
    const request = ++this.requestSequence;
    this.request = request;
    this.voiceChanged.state?.('connecting');
    try {
      await this.ensureWindow(bounds);
      if (this.request !== request) return;
      if (!this.voice.talk(true))
        throw new Error(
          this.error ||
            'Open Chat connection to connect your workspace, then try Talk again.',
        );
      this.request = 0;
      if (this.window?.isVisible()) this.window.hide();
    } catch (error) {
      if (this.request !== request) return;
      this.stopVoice('error');
      throw error;
    }
  }

  stopVoice(reason: string): void {
    this.request = 0;
    this.voice.stop(reason);
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

  async open(bounds: Rect): Promise<void> {
    await this.ensureWindow(bounds);
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    this.updateAppearance();
    window.setBounds(bounds);
    window.show();
    window.focus();
  }

  private ensureWindow(bounds: Rect): Promise<void> {
    if (this.opening) return this.opening;
    if (this.window && !this.window.isDestroyed()) {
      return Promise.resolve();
    }
    this.opening = this.create(bounds).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async create(bounds: Rect): Promise<void> {
    if (!this.workspace) {
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
    }
    const window = new BrowserWindow({
      ...bounds,
      show: false,
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
        backgroundThrottling: false,
      },
    });
    this.window = window;
    const initialized = this.workspace?.register(window, true);
    this.voice.attach(window);
    this.folders.attach(window);
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    const external = (url: string) => {
      const target = destinationFromUrl(url);
      if (this.workspace && target) {
        void this.workspace.open(target);
        return;
      }
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    };
    window.webContents.setWindowOpenHandler(({ url }) => {
      external(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (this.workspace && destinationFromUrl(url)) {
        event.preventDefault();
        external(url);
        return;
      }
      if (
        url === connectionPage ||
        (this.workspace
          ? isWorkspacePage(url) || url === 'dots://app/recovery.html'
          : new URL(url).origin === new URL(this.address).origin)
      )
        return;
      event.preventDefault();
      external(url);
    });
    window.webContents.on('will-redirect', (event, url) => {
      if (
        this.workspace
          ? !isWorkspacePage(url)
          : new URL(url).origin !== new URL(this.address).origin
      )
        event.preventDefault();
    });
    window.webContents.on('render-process-gone', () => {
      this.voice.reset();
      this.error =
        'The chat window stopped responding. Reconnect to continue your conversation.';
      void window
        .loadURL(this.workspace ? 'dots://app/recovery.html' : connectionPage)
        .catch(() => {});
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
    window.on('hide', () => {
      if (!this.voice.isWindowless) this.stopVoice('hidden');
    });
    // Explicitly minimizing or closing visible controls still ends the call.
    window.on('minimize', () => this.voice.stop('minimized'));
    // Keep the conversation and in-flight response alive when the box is closed.
    window.on('close', (event) => {
      event.preventDefault();
      this.voice.stop('closed');
      window.hide();
    });
    try {
      await window.loadURL(
        this.workspace ? 'dots://app/recovery.html' : connectionPage,
      );
      await this.connect();
    } finally {
      initialized?.();
    }
  }

  private async connect(): Promise<void> {
    const window = this.window;
    if (!window || window.isDestroyed() || this.loading) return;
    this.loading = true;
    const address = this.address;
    try {
      if (this.workspace) {
        await this.workspace.ready();
        if (!window.isDestroyed())
          await window.loadURL(
            `dots://workspace/?surface=companion&dotColor=${encodeURIComponent(this.getColor())}${accessoriesQuery(this.getAccessories())}`,
          );
        this.error = '';
        return;
      }
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
        const accessories = accessoriesKey(this.getAccessories());
        if (accessories !== DEFAULT_ACCESSORIES_KEY)
          url.searchParams.set('dotAccessories', accessories);
        else url.searchParams.delete('dotAccessories');
        await window.loadURL(url.href);
        this.updateAppearance();
      }
    } catch {
      this.error =
        'Your workspace is offline or its chat page is unavailable. Start My Own Dots in Command Center, or run npm run build followed by npm start in your checkout, then retry. For npm run dev, use http://127.0.0.1:5173.';
      if (!window.isDestroyed())
        await window
          .loadURL(this.workspace ? 'dots://app/recovery.html' : connectionPage)
          .catch(() => {});
    } finally {
      this.loading = false;
    }
  }

  async configure(bounds: Rect): Promise<void> {
    if (this.workspace) {
      await this.workspace.recover();
      return;
    }
    await this.open(bounds);
    this.error =
      'Connect to the workspace that holds your Dots and conversations.';
    await this.window?.loadURL(connectionPage);
  }

  hide(): void {
    this.stopVoice('hidden');
    if (this.window?.isVisible()) this.window.hide();
  }
  updateAppearance(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const current = window.webContents.getURL();
    if (!current) return;
    const url = new URL(current);
    if (
      this.workspace
        ? !isWorkspacePage(current)
        : url.origin !== new URL(this.address).origin ||
          url.searchParams.get('desktop') !== '1'
    )
      return;
    const color = this.getColor();
    const accessories = accessoriesKey(this.getAccessories());
    // Appearance-only data; the voice bridge grants no generic desktop access.
    // Updating the URL also preserves the chosen color on a normal reload.
    void window.webContents
      .executeJavaScript(
        `(() => {
          const url = new URL(location.href);
          if (url.protocol !== ${JSON.stringify(url.protocol)} ||
              url.host !== ${JSON.stringify(url.host)} ||
              url.pathname !== ${JSON.stringify(url.pathname)} ||
              url.username || url.password ||
              url.searchParams.get(${JSON.stringify(this.workspace ? 'surface' : 'desktop')}) !==
                ${JSON.stringify(url.searchParams.get(this.workspace ? 'surface' : 'desktop'))}) return;
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
  destroy(): void {
    this.request = 0;
    this.folders.destroy();
    this.voice.destroy();
    this.window?.destroy();
    this.window = null;
  }
}
