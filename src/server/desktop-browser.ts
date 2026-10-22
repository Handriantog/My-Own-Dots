import {
  browserReply,
  browserRequest,
  websiteUrl,
  type BrowserRequest,
  type BrowserResult,
  type OpenWebsite,
} from '../shared/desktop-browser.js';

interface BrowserChannel {
  connected?: boolean;
  send?: (
    message: BrowserRequest,
    callback: (error: Error | null) => void,
  ) => boolean;
  on(
    event: 'message' | 'disconnect',
    listener: (message?: unknown) => void,
  ): unknown;
  removeListener(
    event: 'message' | 'disconnect',
    listener: (message?: unknown) => void,
  ): unknown;
}

/** Private IPC to the Electron parent, never an HTTP or renderer capability. */
export class DesktopBrowserClient {
  private pending = new Map<
    string,
    { url: string; finish: (result: BrowserResult) => void }
  >();
  private closed = false;
  private receive = (value?: unknown) => {
    const reply = browserReply.safeParse(value);
    if (!reply.success) return;
    const pending = this.pending.get(reply.data.id);
    if (pending?.url === reply.data.result.url)
      pending.finish(reply.data.result);
  };
  constructor(private channel: BrowserChannel) {
    channel.on('message', this.receive);
    channel.on('disconnect', this.close);
  }
  open: OpenWebsite = async (value, id, signal) => {
    signal.throwIfAborted();
    const url = websiteUrl.parse(value);
    if (this.closed || !this.channel.connected || !this.channel.send)
      return {
        url,
        status: 'failed',
        error: 'Open this workspace in the Dots desktop app to open websites.',
      };
    if (this.pending.has(id))
      return {
        url,
        status: 'unknown',
        error:
          'This browser request is already pending. Do not retry automatically.',
      };
    const message = browserRequest.parse({
      type: 'dots:open-website',
      id,
      url,
      expiresAt: Date.now() + 10000,
    });
    return new Promise<BrowserResult>((resolve) => {
      const unknown = () =>
        finish({
          url,
          status: 'unknown',
          error:
            'The desktop did not confirm opening this website. Do not retry automatically.',
        });
      const timer = setTimeout(unknown, 10000);
      const finish = (result: BrowserResult) => {
        if (this.pending.get(id)?.finish !== finish) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', unknown);
        this.pending.delete(id);
        resolve(result);
      };
      this.pending.set(id, { url, finish });
      signal.addEventListener('abort', unknown, { once: true });
      try {
        this.channel.send!(message, (error) => {
          if (error) unknown();
        });
      } catch {
        unknown();
      }
    });
  };
  close = () => {
    this.closed = true;
    this.channel.removeListener('message', this.receive);
    this.channel.removeListener('disconnect', this.close);
    for (const { url, finish } of this.pending.values())
      finish({
        url,
        status: 'unknown',
        error:
          'The desktop connection ended before confirming the browser action.',
      });
  };
}
