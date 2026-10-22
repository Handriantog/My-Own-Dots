import {
  browserRequest,
  type BrowserReply,
} from '../../shared/desktop-browser.js';

/** Only the app-owned child process can reach this handler. */
export class DesktopBrowserOpener {
  private requests = new Map<
    string,
    { url: string; result: Promise<BrowserReply> }
  >();
  constructor(
    private open: (url: string) => Promise<void>,
    private active: () => boolean,
  ) {}
  async handle(value: unknown): Promise<BrowserReply | undefined> {
    const parsed = browserRequest.safeParse(value);
    if (!parsed.success) return;
    const { id, url, expiresAt } = parsed.data;
    const failed = (error: string): BrowserReply => ({
      type: 'dots:website-result',
      id,
      result: { url, status: 'failed', error },
    });
    const existing = this.requests.get(id);
    if (existing)
      return existing.url === url
        ? existing.result
        : failed('Browser request does not match its original website.');
    if (!this.active() || expiresAt <= Date.now())
      return failed('The desktop request expired.');
    // Retain all receipts for this backend lifetime instead of evicting and reopening old requests.
    if (this.requests.size >= 1000)
      return failed('Restart the desktop app before opening more websites.');
    const result = Promise.resolve().then(async (): Promise<BrowserReply> => {
      if (!this.active() || expiresAt <= Date.now())
        return failed('The desktop request expired.');
      try {
        await this.open(url);
        return {
          type: 'dots:website-result',
          id,
          result: { url, status: 'opened' },
        };
      } catch {
        return failed('The browser could not open this website.');
      }
    });
    this.requests.set(id, { url, result });
    return result;
  }
}
