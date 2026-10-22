import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopBrowserClient } from '../src/server/desktop-browser.js';
import { DesktopBrowserOpener } from '../src/desktop/host/browser-opener.js';
import type { BrowserRequest } from '../src/shared/desktop-browser.js';

afterEach(() => vi.useRealTimers());
const request = (
  url = 'https://example.com/',
  id = 'a'.repeat(64),
): BrowserRequest => ({
  type: 'dots:open-website',
  id,
  url,
  expiresAt: Date.now() + 10000,
});

it('does not hand unsafe URLs, expired requests or a stopped workspace to the OS', async () => {
  const opened: string[] = [];
  let active = true;
  const host = new DesktopBrowserOpener(
    async (url) => {
      opened.push(url);
    },
    () => active,
  );
  for (const url of [
    'file:///tmp/test',
    'javascript:alert(1)',
    'https://user:password@example.com',
    'https://example.com/\nfoo',
  ]) {
    expect(await host.handle(request(url))).toBeUndefined();
  }
  expect(
    (await host.handle({ ...request(), expiresAt: Date.now() - 1 }))?.result
      .status,
  ).toBe('failed');
  active = false;
  expect((await host.handle(request()))?.result.status).toBe('failed');
  expect(opened).toEqual([]);
});

it('coalesces simultaneous requests and preserves failure without reopening a browser', async () => {
  const opened: string[] = [];
  let finish!: () => void;
  const host = new DesktopBrowserOpener(
    async (url) => {
      opened.push(url);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      throw Error('OS launch failed');
    },
    () => true,
  );
  const first = host.handle(request());
  const second = host.handle(request());
  await Promise.resolve();
  finish();
  expect((await first)?.result.status).toBe('failed');
  expect(await second).toEqual(await first);
  expect(await host.handle(request())).toEqual(await first);
  expect(
    (await host.handle(request('https://example.org/')))?.result.status,
  ).toBe('failed');
  expect(opened).toEqual(['https://example.com/']);
});

function channel() {
  const events = new EventEmitter();
  const sent: BrowserRequest[] = [];
  return Object.assign(events, {
    connected: true,
    send(message: BrowserRequest, callback: (error: Error | null) => void) {
      sent.push(message);
      callback(null);
      return true;
    },
    sent,
  });
}

it('waits for a matching desktop acknowledgement before reporting opened', async () => {
  const pipe = channel();
  const client = new DesktopBrowserClient(pipe);
  try {
    let settled = false;
    const pending = client
      .open('https://example.com', 'a'.repeat(64), new AbortController().signal)
      .then((result) => {
        settled = true;
        return result;
      });
    pipe.emit('message', {
      type: 'dots:website-result',
      id: 'b'.repeat(64),
      result: { url: 'https://example.com/', status: 'opened' },
    });
    pipe.emit('message', {
      type: 'dots:website-result',
      id: 'a'.repeat(64),
      result: { url: 'https://example.org/', status: 'opened' },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    pipe.emit('message', {
      type: 'dots:website-result',
      id: 'a'.repeat(64),
      result: { url: 'https://example.com/', status: 'opened' },
    });
    expect(await pending).toEqual({
      url: 'https://example.com/',
      status: 'opened',
    });
    expect(pipe.sent).toEqual([
      expect.objectContaining({
        type: 'dots:open-website',
        url: 'https://example.com/',
        id: 'a'.repeat(64),
      }),
    ]);
  } finally {
    client.close();
  }
});

it('reports lost acknowledgements as unknown and never resends automatically', async () => {
  vi.useFakeTimers();
  const pipe = channel();
  const client = new DesktopBrowserClient(pipe);
  try {
    const pending = client.open(
      'https://example.com',
      'a'.repeat(64),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(10001);
    expect((await pending).status).toBe('unknown');
    expect(pipe.sent).toHaveLength(1);
  } finally {
    client.close();
  }
});

it('sends nothing after cancellation or without a desktop connection', async () => {
  const pipe = channel();
  const client = new DesktopBrowserClient(pipe);
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.open('https://example.com', 'a'.repeat(64), controller.signal),
    ).rejects.toThrow();
    pipe.connected = false;
    expect(
      (
        await client.open(
          'https://example.com',
          'a'.repeat(64),
          new AbortController().signal,
        )
      ).status,
    ).toBe('failed');
    expect(pipe.sent).toEqual([]);
  } finally {
    client.close();
  }
});

it('settles pending requests when the desktop disconnects and removes listeners', async () => {
  const pipe = channel();
  const client = new DesktopBrowserClient(pipe);
  const pending = client.open(
    'https://example.com',
    'a'.repeat(64),
    new AbortController().signal,
  );
  pipe.emit('disconnect');
  expect((await pending).status).toBe('unknown');
  expect(pipe.listenerCount('message')).toBe(0);
});

it('ignores a late send failure after timeout without losing a newer acknowledgement', async () => {
  vi.useFakeTimers();
  const pipe = channel();
  const callbacks: ((error: Error | null) => void)[] = [];
  pipe.send = (message, callback) => {
    pipe.sent.push(message);
    callbacks.push(callback);
    return true;
  };
  const client = new DesktopBrowserClient(pipe);
  try {
    const first = client.open(
      'https://example.com',
      'a'.repeat(64),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(10001);
    expect((await first).status).toBe('unknown');
    const second = client.open(
      'https://example.com',
      'a'.repeat(64),
      new AbortController().signal,
    );
    callbacks[0](Error('Late IPC failure'));
    pipe.emit('message', {
      type: 'dots:website-result',
      id: 'a'.repeat(64),
      result: { url: 'https://example.com/', status: 'opened' },
    });
    await vi.advanceTimersByTimeAsync(10001);
    expect((await second).status).toBe('opened');
  } finally {
    client.close();
  }
});
