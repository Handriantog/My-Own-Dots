import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { isWorkspacePage } from './workspace-protocol.js';
import type { DesktopFolderBridge } from '../shared/folder-contract.js';

type Sender = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;

/** Native selection only; this never grants access or reads a selected folder. */
export class CompanionFolderPicker {
  private pending = false;
  private destroyed = false;
  private revision = 0;
  private detach: (() => void) | null = null;
  private readonly context = (event: IpcMainEvent) => {
    event.returnValue = this.trusted(event);
  };

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getAddress: () => string,
    private readonly channel = 'dot:folders',
    private readonly nativePage: (url: string) => boolean = isWorkspacePage,
  ) {
    ipcMain.on(`${this.channel}:context`, this.context);
    ipcMain.handle(`${this.channel}:choose`, (event, ...args: unknown[]) =>
      this.choose(event, args),
    );
  }

  get choosing(): boolean {
    return this.pending;
  }

  private workspacePage(value: string): boolean {
    try {
      const url = new URL(value);
      const configured = new URL(this.getAddress());
      if (configured.protocol === 'dots:') return this.nativePage(value);
      return (
        /^https?:$/.test(configured.protocol) &&
        ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname) &&
        !configured.username &&
        !configured.password &&
        !url.username &&
        !url.password &&
        url.origin === configured.origin &&
        url.pathname === '/' &&
        url.searchParams.get('desktop') === '1'
      );
    } catch {
      return false;
    }
  }

  private trusted(event: Sender): boolean {
    const window = this.getWindow();
    return (
      !this.destroyed &&
      !!window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      !!event.senderFrame &&
      this.workspacePage(event.senderFrame.url)
    );
  }

  private available(window: BrowserWindow, requireFocus = true): boolean {
    return (
      !window.isDestroyed() &&
      window.isVisible() &&
      (!requireFocus || window.isFocused()) &&
      !window.isMinimized()
    );
  }

  private async choose(
    event: IpcMainInvokeEvent,
    args: unknown[],
  ): ReturnType<DesktopFolderBridge['choose']> {
    if (args.length || !this.trusted(event))
      throw new Error('Invalid folder chooser request');
    const window = this.getWindow()!;
    if (!this.available(window))
      throw new Error('Open and focus the approval window to choose a folder');
    if (this.pending) throw new Error('A folder chooser is already open');

    const frame = window.webContents.mainFrame;
    const url = frame.url;
    const address = this.getAddress();
    const revision = this.revision;
    this.pending = true;
    try {
      const selection = await dialog
        .showOpenDialog(window, {
          properties: ['openDirectory'],
          title: 'Choose a folder for your Dot',
          buttonLabel: 'Choose folder',
        })
        .catch(() => {
          throw new Error(
            'Could not open the folder chooser. Please try again.',
          );
        });
      if (selection.canceled || !selection.filePaths[0]) return null;
      // Even navigation away and back or hide/show invalidates this selection.
      // No caller data can set a default path or change native dialog options.
      if (
        revision !== this.revision ||
        this.getWindow() !== window ||
        !this.trusted(event) ||
        // A native sheet can settle before macOS restores the parent's focus.
        // Focus is required to open it; the same visible frame still owns its result.
        !this.available(window, false) ||
        window.webContents.mainFrame !== frame ||
        frame.url !== url ||
        this.getAddress() !== address
      )
        throw new Error(
          'Folder selection was interrupted. Choose the folder again.',
        );
      return { path: selection.filePaths[0] };
    } finally {
      this.pending = false;
    }
  }

  attach(window: BrowserWindow): void {
    this.detach?.();
    this.revision++;
    const invalidate = () => {
      this.revision++;
    };
    const navigating = (
      _event: unknown,
      _url: string,
      _inPlace: boolean,
      mainFrame: boolean,
    ) => {
      if (mainFrame) invalidate();
    };
    const windowEvents = ['hide', 'minimize', 'close', 'closed'] as const;
    const contentEvents = [
      'did-navigate',
      'did-navigate-in-page',
      'render-process-gone',
      'destroyed',
    ] as const;
    const windowLifecycle: NodeJS.EventEmitter = window;
    const contentLifecycle: NodeJS.EventEmitter = window.webContents;
    for (const name of windowEvents) windowLifecycle.on(name, invalidate);
    for (const name of contentEvents) contentLifecycle.on(name, invalidate);
    contentLifecycle.on('did-start-navigation', navigating);
    this.detach = () => {
      for (const name of windowEvents)
        windowLifecycle.removeListener(name, invalidate);
      for (const name of contentEvents)
        contentLifecycle.removeListener(name, invalidate);
      contentLifecycle.removeListener('did-start-navigation', navigating);
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.revision++;
    this.detach?.();
    this.detach = null;
    ipcMain.removeListener(`${this.channel}:context`, this.context);
    ipcMain.removeHandler(`${this.channel}:choose`);
  }
}
