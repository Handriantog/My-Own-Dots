import {
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import type { CompanionVoiceState } from '../shared/voice-contract.js';

type Sender = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>;

/** Permission and lifecycle boundary only; the workspace owns authenticated call scope. */
export class CompanionVoiceSession {
  private available = false;
  private callId: string | null = null;
  private stoppingId: string | null = null;
  private endedId: string | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private talkUntil = 0;
  private windowless = false;
  private starting = false;
  private requestTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly context = (event: IpcMainEvent) => {
    event.returnValue = this.trusted(event);
  };

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getAddress: () => string,
    private readonly changed: {
      active(value: boolean): void;
      ready(value: boolean): void;
      state?(value: CompanionVoiceState): void;
      error?(message: string): void;
    },
  ) {
    ipcMain.on('dot:voice:context', this.context);
    ipcMain.handle('dot:voice:ready', (event, value: unknown) => {
      this.requireTrusted(event);
      if (typeof value !== 'boolean')
        throw new Error('Invalid voice readiness');
      const wasAvailable = this.available;
      this.setReady(value);
      if (!value && wasAvailable) {
        if (this.windowless && this.engaged)
          this.changed.error?.(
            'Local voice is unavailable. Open Chat to check your voice setup.',
          );
        this.stop('unavailable');
      }
    });
    ipcMain.handle('dot:voice:activate', (event) => {
      this.requireTrusted(event);
      const window = this.getWindow()!;
      if (
        !this.talkUntil ||
        Date.now() > this.talkUntil ||
        !this.available ||
        (!this.windowless && (!window.isVisible() || !window.isFocused())) ||
        this.callId ||
        this.stoppingId
      )
        throw new Error(
          'Talk request expired or the chat window is not ready. Choose Talk again.',
        );
      this.talkUntil = 0;
      this.starting = true;
      this.deadline(130000);
      // Fixed code only, on the trusted workspace frame, for one native Talk.
      // This preserves its user gesture across asynchronous chat initialization.
      return window.webContents
        .executeJavaScript(
          "window.dispatchEvent(new Event('dot-voice-start'))",
          true,
        )
        .then(() => {});
    });
    ipcMain.handle('dot:voice:cancel-talk', (event) => {
      this.requireTrusted(event);
      if (this.talkUntil) this.stop('cancelled');
    });
    ipcMain.handle('dot:voice:cancel-start', (event) => {
      this.requireTrusted(event);
      if (this.starting) this.stop('cancelled');
    });
    ipcMain.handle('dot:voice:phase', (event, value: unknown) => {
      this.requireTrusted(event);
      const data = value as { callId?: unknown; phase?: unknown } | null;
      if (
        !data ||
        !this.callId ||
        data.callId !== this.callId ||
        !['listening', 'thinking', 'speaking', 'approval'].includes(
          String(data.phase),
        )
      )
        throw new Error('Invalid voice phase');
      this.changed.state?.(data.phase as CompanionVoiceState);
    });
    ipcMain.handle('dot:voice:error', (event, value: unknown) => {
      this.requireTrusted(event);
      if (typeof value !== 'string' || value.length > 500)
        throw new Error('Invalid voice error');
      if (this.windowless && this.engaged) this.changed.error?.(value);
      if (this.engaged) this.stop('error');
    });
    ipcMain.handle('dot:voice:begin', (event, value: unknown) => {
      this.requireTrusted(event);
      const callId = this.validId(value);
      const window = this.getWindow()!;
      if (
        !this.available ||
        (!(this.windowless && (this.starting || this.callId === callId)) &&
          (!window.isVisible() || !window.isFocused())) ||
        this.stoppingId
      )
        throw new Error('Open a ready chat window before starting a call');
      if (this.callId === callId) return;
      if (this.callId || this.endedId === callId)
        throw new Error('Invalid active call');
      this.callId = callId;
      this.talkUntil = 0;
      this.starting = false;
      this.clearDeadline();
      this.changed.active(true);
      this.changed.state?.('listening');
    });
    ipcMain.handle('dot:voice:end', (event, value: unknown) => {
      this.requireTrusted(event);
      const callId = this.validId(value);
      if (![this.callId, this.stoppingId, this.endedId].includes(callId))
        throw new Error('Invalid active call');
      if (this.callId === callId) {
        this.talkUntil = 0;
        this.callId = null;
        this.windowless = false;
        this.starting = false;
        this.clearDeadline();
        this.changed.active(false);
        this.changed.state?.(null);
      }
      if (this.stoppingId === callId) this.clearStop();
      this.endedId = callId;
    });
  }

  get ready(): boolean {
    return this.available;
  }

  get engaged(): boolean {
    return !!(
      this.talkUntil ||
      this.starting ||
      this.callId ||
      this.stoppingId
    );
  }

  get isWindowless(): boolean {
    return this.windowless;
  }

  talk(windowless = false): boolean {
    const window = this.getWindow();
    if (
      !window ||
      window.isDestroyed() ||
      !this.workspacePage(window.webContents.mainFrame.url)
    )
      return false;
    if (this.engaged) return false;
    this.windowless = windowless;
    this.talkUntil = Date.now() + 30000;
    this.deadline(30000);
    this.changed.state?.('connecting');
    if (windowless) window.webContents.send('dot:voice:talk', true);
    else window.webContents.send('dot:voice:talk');
    return true;
  }

  private deadline(ms: number): void {
    this.clearDeadline();
    this.requestTimer = setTimeout(() => {
      if (this.windowless)
        this.changed.error?.(
          'Talk took too long to connect. Check your workspace and local voice setup, then try again.',
        );
      this.stop('timeout');
    }, ms);
  }

  private clearDeadline(): void {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = null;
  }

  private setReady(value: boolean): void {
    if (this.available === value) return;
    this.available = value;
    this.changed.ready(value);
  }

  private validId(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value))
      throw new Error('Invalid call identity');
    return value;
  }

  private workspacePage(value: string): boolean {
    try {
      const url = new URL(value);
      return (
        url.origin === new URL(this.getAddress()).origin &&
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
      !!window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      this.workspacePage(event.senderFrame.url)
    );
  }

  private requireTrusted(event: Sender): void {
    if (!this.trusted(event)) throw new Error('Invalid voice sender');
  }

  attach(window: BrowserWindow): void {
    const allowed = (contents: unknown, isMainFrame: boolean, url?: string) =>
      !!this.callId &&
      !window.isDestroyed() &&
      contents === window.webContents &&
      isMainFrame &&
      (this.windowless || (window.isVisible() && window.isFocused())) &&
      this.workspacePage(window.webContents.mainFrame.url) &&
      !!url &&
      this.workspacePage(url);
    // Both handlers are required: a Chromium permission check can otherwise skip
    // the request handler. Deny camera, subframes, and every unrelated permission.
    window.webContents.session.setPermissionCheckHandler(
      (contents, permission, origin, details) =>
        permission === 'media' &&
        details.mediaType === 'audio' &&
        origin === new URL(this.getAddress()).origin &&
        allowed(contents, details.isMainFrame, details.requestingUrl),
    );
    window.webContents.session.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        const types = 'mediaTypes' in details ? details.mediaTypes : undefined;
        callback(
          permission === 'media' &&
            types?.length === 1 &&
            types[0] === 'audio' &&
            allowed(contents, details.isMainFrame, details.requestingUrl),
        );
      },
    );
  }

  /** Revoke before asking the renderer to release tracks and acknowledge via end. */
  stop(reason: string): void {
    this.talkUntil = 0;
    this.starting = false;
    this.windowless = false;
    this.clearDeadline();
    this.changed.state?.(null);
    const window = this.getWindow();
    if (window && !window.isDestroyed())
      window.webContents.send('dot:voice:stop', reason);
    if (!this.callId) return;
    this.stoppingId = this.callId;
    this.callId = null;
    this.changed.active(false);
    if (!window || window.isDestroyed()) {
      this.clearStop();
      return;
    }
    this.stopTimer = setTimeout(() => {
      this.endedId = this.stoppingId;
      this.clearStop();
      this.setReady(false);
      if (!window.isDestroyed()) window.webContents.reload();
    }, 1000);
  }

  /** Navigation destroys capture itself; do not reload a newly loaded page. */
  reset(): void {
    this.talkUntil = 0;
    this.starting = false;
    this.windowless = false;
    this.clearDeadline();
    this.changed.state?.(null);
    if (this.callId) this.changed.active(false);
    this.endedId = this.callId ?? this.stoppingId ?? this.endedId;
    this.callId = null;
    this.clearStop();
    this.setReady(false);
  }

  private clearStop(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.stoppingId = null;
  }

  destroy(): void {
    this.reset();
    ipcMain.removeListener('dot:voice:context', this.context);
    for (const name of [
      'ready',
      'activate',
      'cancel-talk',
      'cancel-start',
      'begin',
      'end',
      'phase',
      'error',
    ])
      ipcMain.removeHandler(`dot:voice:${name}`);
  }
}
