import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceBackendConnection } from './workspace-backend.js';

export const workspaceCsp =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export interface WorkspaceProtocolConnection extends WorkspaceBackendConnection {
  connectOrigin?: string;
}
function realtimeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      ['ws:', 'wss:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hostname.includes('*')
    )
      return url.origin;
  } catch {
    /* Invalid CSP sources grant no access. */
  }
}
/** Read only an origin already advertised by the authenticated local backend. */
export async function workspaceRealtimeOrigin(
  connection: WorkspaceBackendConnection,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const url = new URL(connection.url);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    return;
  try {
    const response = await fetcher(new URL('/api/desktop/identity', url), {
      headers: connection.ownerToken
        ? { authorization: `Bearer ${connection.ownerToken}` }
        : {},
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
    });
    const policy = response.headers.get('content-security-policy') || '';
    await response.body?.cancel();
    const directive = policy
      .split(';')
      .find((value) => value.trim().startsWith('connect-src '));
    return directive
      ?.trim()
      .split(/\s+/)
      .slice(1)
      .map(realtimeOrigin)
      .find(Boolean);
  } catch {
    /* Legacy explicit services may not advertise an identity route. */
  }
}
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
};
export function isWorkspacePage(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'dots:' &&
      url.host === 'workspace' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      ['workspace', 'companion'].includes(url.searchParams.get('surface') || '')
    );
  } catch {
    return false;
  }
}
/** Preserves streaming bodies and cancellation; never follows credential-bearing redirects. */
export function createWorkspaceProtocol(
  renderer: string,
  connection: () => WorkspaceProtocolConnection | undefined,
  fetcher: typeof fetch = fetch,
  onFailure: () => void = () => {},
) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.protocol !== 'dots:' ||
      !['workspace', 'app'].includes(url.host) ||
      url.username ||
      url.password
    )
      return new Response('Forbidden', { status: 403 });
    let pathname: string;
    try {
      if (/%(?:2f|5c|25)/i.test(url.pathname) || url.pathname.includes('\\'))
        throw new Error();
      pathname = decodeURIComponent(url.pathname);
      if (
        pathname.split('/').some((part) => part === '..' || part === '.') ||
        pathname.includes('\0')
      )
        throw new Error();
    } catch {
      return new Response('Bad path', { status: 400 });
    }
    if (
      url.host === 'workspace' &&
      (pathname === '/api' || pathname.startsWith('/api/'))
    ) {
      const origin = request.headers.get('origin');
      if (
        (origin && origin !== 'dots://workspace') ||
        request.headers.get('sec-fetch-site') === 'cross-site'
      )
        return new Response('Untrusted workspace origin', { status: 403 });
      const backend = connection();
      if (!backend)
        return new Response('Workspace is connecting', { status: 503 });
      let target: URL;
      try {
        target = new URL(backend.url);
        if (
          target.protocol !== 'http:' ||
          !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
          target.username ||
          target.password ||
          target.pathname !== '/' ||
          target.search ||
          target.hash
        )
          throw new Error();
      } catch {
        return new Response('Invalid local workspace', { status: 503 });
      }
      const headers = new Headers(request.headers);
      for (const name of [
        'authorization',
        'cookie',
        'host',
        'origin',
        'referer',
        'sec-fetch-site',
        'connection',
        'content-length',
      ])
        headers.delete(name);
      if (backend.ownerToken)
        headers.set('authorization', `Bearer ${backend.ownerToken}`);
      // This is an authenticated native request. A configured browser APP_ORIGIN
      // need not match the backend listener; never synthesize a browser origin.
      target.pathname = pathname;
      target.search = url.search;
      try {
        const response = await fetcher(target, {
          method: request.method,
          headers,
          body: ['GET', 'HEAD'].includes(request.method)
            ? undefined
            : request.body,
          signal: request.signal,
          redirect: 'manual',
          duplex: 'half',
        } as RequestInit);
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          return new Response('Workspace redirect refused', { status: 502 });
        }
        const safe = new Headers(response.headers);
        safe.delete('set-cookie');
        safe.delete('access-control-allow-origin');
        safe.delete('content-encoding');
        safe.delete('content-length');
        const reader = response.body?.getReader();
        const body = reader
          ? new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const result = await reader.read();
                  if (result.done) controller.close();
                  else controller.enqueue(result.value);
                } catch (error) {
                  if (!request.signal.aborted) onFailure();
                  controller.error(error);
                }
              },
              cancel(reason) {
                return reader.cancel(reason);
              },
            })
          : null;
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: safe,
        });
      } catch {
        if (!request.signal.aborted) onFailure();
        return new Response('Workspace unavailable. Retry the connection.', {
          status: 503,
        });
      }
    }
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response('Method not allowed', { status: 405 });
    const root =
      url.host === 'workspace' ? path.join(renderer, 'workspace') : renderer;
    const file = path.resolve(
      root,
      `.${pathname === '/' ? '/index.html' : pathname}`,
    );
    if (!file.startsWith(root + path.sep))
      return new Response('Forbidden', { status: 403 });
    try {
      const bytes = await readFile(file);
      return new Response(request.method === 'HEAD' ? null : bytes, {
        headers: {
          'content-type':
            mime[path.extname(file)] || 'application/octet-stream',
          'content-security-policy':
            connection()?.connectOrigin &&
            realtimeOrigin(connection()!.connectOrigin!)
              ? workspaceCsp.replace(
                  "connect-src 'self'",
                  `connect-src 'self' ${realtimeOrigin(connection()!.connectOrigin!)}`,
                )
              : workspaceCsp,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  };
}
