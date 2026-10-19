import { expect, it, vi } from 'vitest';
import { createWorkspaceProtocol } from '../../src/desktop/host/workspace-protocol.js';
const connection = {
  url: 'http://127.0.0.1:5999',
  ownerToken: 'private',
  owned: true,
};
it('proxies API bodies, streams and cancellation with credentials confined to loopback', async () => {
  const abort = new AbortController();
  const fetcher = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: hello\n\n'));
            c.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const serve = createWorkspaceProtocol('/bundle', () => connection, fetcher);
  const response = await serve(
    new Request('dots://workspace/api/chat?x=1', {
      method: 'POST',
      body: 'hello',
      headers: { origin: 'dots://workspace', authorization: 'untrusted' },
      signal: abort.signal,
    }),
  );
  expect(await response.text()).toBe('data: hello\n\n');
  const [url, init] = fetcher.mock.calls[0];
  if (!init) throw new Error('Missing proxy request');
  const headers = new Headers(init.headers);
  expect(String(url)).toBe('http://127.0.0.1:5999/api/chat?x=1');
  expect(init.redirect).toBe('manual');
  expect(headers.get('authorization')).toBe('Bearer private');
  expect(headers.get('origin')).toBeNull();
  expect(await new Response(init.body).text()).toBe('hello');
  abort.abort();
  expect(init.signal?.aborted).toBe(true);
});
it.each([
  'dots://evil/api/chat',
  'dots://workspace/%2e%2e%2fsecret',
  'dots://workspace/assets%5csecret',
  'dots://workspace/%252e%252e/secret',
])('rejects unsafe protocol target %s', async (url) => {
  const fetcher = vi.fn();
  const serve = createWorkspaceProtocol('/bundle', () => connection, fetcher);
  expect((await serve(new Request(url))).status).toBeGreaterThanOrEqual(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it('refuses remote configured targets and backend redirects', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil/' },
      }),
  );
  expect(
    (
      await createWorkspaceProtocol(
        '/bundle',
        () => ({ ...connection, url: 'https://evil' }),
        fetcher,
      )(new Request('dots://workspace/api/chat'))
    ).status,
  ).toBe(503);
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    (
      await createWorkspaceProtocol(
        '/bundle',
        () => connection,
        fetcher,
      )(new Request('dots://workspace/api/chat'))
    ).status,
  ).toBe(502);
});
it('delivers live SSE chunks before completion and propagates abort to the local socket', async () => {
  const { createServer } = await import('node:http');
  let closed!: () => void;
  const closeObserved = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer private');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    request.on('close', closed);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server');
  const abort = new AbortController();
  try {
    const serve = createWorkspaceProtocol('/bundle', () => ({
      ...connection,
      url: `http://127.0.0.1:${address.port}`,
    }));
    const response = await serve(
      new Request('dots://workspace/api/stream', { signal: abort.signal }),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      'data: first\n\n',
    );
    abort.abort();
    await expect(reader.read()).rejects.toThrow();
    await closeObserved;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it.each(['https://evil.example', 'dots://app', 'null'])(
  'refuses foreign incoming Origin %s before adding native credentials',
  async (origin) => {
    const fetcher = vi.fn(async () => new Response('ok'));
    const serve = createWorkspaceProtocol('/bundle', () => connection, fetcher);
    expect(
      (
        await serve(
          new Request('dots://workspace/api/state', { headers: { origin } }),
        )
      ).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it('uses authenticated native requests with a backend configured for an explicit browser APP_ORIGIN', async () => {
  const { createApp } = await import('../../src/server/app.js');
  const { Store } = await import('../../src/server/store.js');
  const { Runner } = await import('../../src/server/runner.js');
  const store = new Store(':memory:');
  const config = {
    mode: 'sample' as const,
    baseUrl: 'https://api.openai.com/v1',
  };
  try {
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      ownerToken: 'private',
      origin: 'https://browser.example',
    });
    const serve = createWorkspaceProtocol(
      '/bundle',
      () => connection,
      async (input, init) => app.fetch(new Request(input, init)),
    );
    const response = await serve(
      new Request('dots://workspace/api/state', {
        headers: {
          origin: 'dots://workspace',
          'sec-fetch-site': 'same-origin',
        },
      }),
    );
    expect(response.status).toBe(200);
  } finally {
    store.close();
  }
});
it('allows only the optional realtime origin advertised by the local backend, never remote scripts or credentials', async () => {
  const { workspaceRealtimeOrigin } =
    await import('../../src/desktop/host/workspace-protocol.js');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const renderer = await mkdtemp(path.join(tmpdir(), 'dots-protocol-'));
  const fetcher = vi.fn(
    async () =>
      new Response(null, {
        headers: {
          'content-security-policy':
            "default-src 'self'; connect-src 'self' wss://custom.example/realtime?private=value; script-src https://evil.example",
        },
      }),
  );
  try {
    const connectOrigin = await workspaceRealtimeOrigin(connection, fetcher);
    expect(connectOrigin).toBe('wss://custom.example');
    await mkdir(path.join(renderer, 'workspace'));
    await writeFile(
      path.join(renderer, 'workspace/index.html'),
      '<html>local</html>',
    );
    const response = await createWorkspaceProtocol(renderer, () => ({
      ...connection,
      connectOrigin,
    }))(new Request('dots://workspace/'));
    const csp = response.headers.get('content-security-policy');
    expect(csp).toContain("connect-src 'self' wss://custom.example");
    expect(csp).not.toContain('private=value');
    expect(csp).not.toContain('evil.example');
    expect(csp).not.toContain("'unsafe-eval'");
    const localOnly = await createWorkspaceProtocol(
      renderer,
      () => connection,
    )(new Request('dots://workspace/'));
    expect(localOnly.headers.get('content-security-policy')).toContain(
      "connect-src 'self';",
    );
    fetcher.mockClear();
    expect(
      await workspaceRealtimeOrigin(
        { ...connection, url: 'https://evil.example' },
        fetcher,
      ),
    ).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await rm(renderer, { recursive: true, force: true });
  }
});
it('reports a dropped backend transport while treating ordinary cancellation as expected', async () => {
  const failed = vi.fn();
  const broken = vi.fn(async () => {
    throw new Error('socket closed');
  });
  const serve = createWorkspaceProtocol(
    '/bundle',
    () => connection,
    broken,
    failed,
  );
  expect((await serve(new Request('dots://workspace/api/state'))).status).toBe(
    503,
  );
  expect(failed).toHaveBeenCalledOnce();
  failed.mockClear();
  const abort = new AbortController();
  abort.abort();
  await serve(
    new Request('dots://workspace/api/state', { signal: abort.signal }),
  );
  expect(failed).not.toHaveBeenCalled();
});
