import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { LookupAddress } from 'node:dns';
import type { RequestOptions } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../fixtures/abilities/manifest.json';
import { parseManifest } from '../../src/shared/abilities/manifest.ts';
import type {
  Binding,
  CapabilityRequest,
  InvocationContext,
} from '../../src/shared/abilities/types.ts';
import { AbilityFailure } from '../../src/shared/abilities/bridge.ts';
import {
  AbilityHttp,
  requestAbilityHttps,
  type AbilityHttpsTransport,
} from '../../src/desktop/host/abilities/http.ts';

afterEach(() => vi.useRealTimers());
function fixture() {
  const context: InvocationContext = {
    workspaceId: 'workspace',
    sessionId: 'session',
    dotId: 'dot',
    bindingId: randomUUID(),
    digest: 'a'.repeat(64),
    grantRevision: 1,
    invocationId: randomUUID(),
    tool: 'search',
    threadId: 'thread',
  };
  const binding: Binding = {
    id: context.bindingId,
    dotId: context.dotId,
    digest: context.digest,
    manifest: parseManifest(manifest),
    grants: ['account', 'search'],
    settings: { clientId: 'personal-client' },
    revision: 1,
    approvedAt: 1,
    enabled: true,
    restored: false,
  };
  const state = {
    revoked: false,
    token: 'HOST_ONLY_CREDENTIAL_SENTINEL',
    addresses: [{ address: '93.184.215.14', family: 4 }] as LookupAddress[],
    onLookup: () => {},
    onConnect: () => {},
    beforeWrite: () => {},
    status: 200,
    headers: {} as IncomingMessage['headers'],
    chunks: [Buffer.from('{"items":[]}')],
    stall: false,
    stalledDns: false,
    connections: [] as {
      address: string;
      hostname: string;
      servername?: string;
      verifiedTls: boolean;
    }[],
    writes: [] as {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    }[],
    aborted: false,
  };
  const transport: AbilityHttpsTransport = {
    lookup: async () => {
      state.onLookup();
      if (state.stalledDns) return new Promise(() => {});
      return structuredClone(state.addresses);
    },
    request: ((
      url: URL,
      options: RequestOptions,
      respond: (response: IncomingMessage) => void,
    ) => {
      const request = new EventEmitter() as ClientRequest;
      let destroyed = false;
      request.destroy = (error?: Error) => {
        destroyed = true;
        state.aborted = true;
        if (error) queueMicrotask(() => request.emit('error', error));
        return request;
      };
      request.end = ((body?: string | Buffer) => {
        if (destroyed) return request;
        state.beforeWrite();
        state.writes.push({
          url: url.href,
          method: options.method!,
          headers: options.headers as Record<string, string>,
          body: String(body ?? ''),
        });
        if (!state.stall)
          queueMicrotask(() => {
            const response = Readable.from(state.chunks) as IncomingMessage;
            response.statusCode = state.status;
            response.headers = state.headers;
            respond(response);
          });
        return request;
      }) as ClientRequest['end'];
      options.signal?.addEventListener(
        'abort',
        () =>
          request.destroy(
            new Error('private transport error with credential sentinel'),
          ),
        { once: true },
      );
      queueMicrotask(() => {
        if (destroyed) return;
        const lookup = options.lookup as (
          host: string,
          options: { all: boolean },
          callback: (error: unknown, addresses: LookupAddress[]) => void,
        ) => void;
        lookup(url.hostname, { all: true }, (error, addresses) => {
          if (error || destroyed) return;
          state.connections.push({
            address: addresses[0].address,
            hostname: url.hostname,
            servername: options.servername,
            verifiedTls: options.rejectUnauthorized === true,
          });
          state.onConnect();
          const socket = Object.assign(new EventEmitter(), {
            encrypted: true,
            connecting: true,
            authorized: false,
            remoteAddress: addresses[0].address,
          });
          request.emit('socket', socket);
          socket.connecting = false;
          socket.authorized = true;
          socket.emit('secureConnect');
        });
      });
      return request;
    }) as AbilityHttpsTransport['request'],
  };
  const http = new AbilityHttp({
    authorize: async () => {
      if (state.revoked) throw new AbilityFailure('permission_denied');
      return structuredClone(binding);
    },
    credential: async () => state.token,
    transport,
  });
  const request: Extract<CapabilityRequest, { kind: 'https' }> = {
    kind: 'https',
    ruleId: 'search',
    pathValues: { itemId: 'item-1' },
    query: { q: 'artist & song' },
  };
  const call = (
    value: unknown = request,
    signal = new AbortController().signal,
  ) => http.request(context, value as typeof request, signal);
  return { state, transport, context, binding, request, http, call };
}
describe('HTTPS permission enforcement', () => {
  it.each([
    { ruleId: 'unapproved' },
    { method: 'DELETE' },
    { headers: { Authorization: 'worker-token' } },
    { url: 'https://user:secret@api.example.com/v1/items' },
    { body: { extra: true } },
    { pathValues: { itemId: '../private' } },
    { pathValues: { itemId: '%2fprivate' } },
    { pathValues: { itemId: '%252fprivate' } },
    { pathValues: { itemId: 'item', extra: 'outside' } },
    { query: { q: 'ok', unknown: 'value' } },
    { query: { q: 23 } },
  ])(
    'rejects unauthorized fields or route values before opening a socket: %j',
    async (override) => {
      const f = fixture();
      expect(await f.call({ ...f.request, ...override })).toEqual({
        ok: false,
        code: 'permission_denied',
      });
      expect(f.state.connections).toEqual([]);
      const bytesSentToRejectedPeer = f.state.writes.reduce(
        (sum, write) => sum + write.body.length + write.url.length,
        0,
      );
      expect(bytesSentToRejectedPeer).toBe(0);
    },
  );
  it.each(['search', 'account'])(
    'requires the approved %s grant',
    async (permission) => {
      const f = fixture();
      f.binding.grants = f.binding.grants.filter((id) => id !== permission);
      expect(await f.call()).toEqual({ ok: false, code: 'permission_denied' });
      expect(f.state.connections).toEqual([]);
    },
  );
  it('validates the exact body schema and sends only the approved method and resource route', async () => {
    const f = fixture();
    const rule = f.binding.manifest.permissions.find((p) => p.id === 'search')!;
    if (rule.kind !== 'https') throw new Error('Missing fixture rule');
    rule.method = 'POST';
    rule.body = {
      type: 'object',
      properties: { name: { type: 'string', maxLength: 50 } },
      required: ['name'],
      additionalProperties: false,
    };
    expect(
      await f.call({
        ...f.request,
        body: { name: 'private playlist', public: true },
      }),
    ).toEqual({ ok: false, code: 'permission_denied' });
    expect(
      await f.call({ ...f.request, body: { name: 'private playlist' } }),
    ).toMatchObject({ ok: true, kind: 'https' });
    expect(f.state.writes).toHaveLength(1);
    expect(f.state.writes[0]).toMatchObject({
      method: 'POST',
      body: '{"name":"private playlist"}',
      url: 'https://api.example.com/v1/items/item-1?q=artist+%26+song',
    });
  });
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:93.184.215.14',
  ])('rejects a mixed DNS answer containing %s', async (address) => {
    const f = fixture();
    f.state.addresses.push({ address, family: address.includes(':') ? 6 : 4 });
    expect(await f.call()).toEqual({ ok: false, code: 'permission_denied' });
    expect(f.state.connections).toEqual([]);
    expect(f.state.writes).toEqual([]);
  });
  it('pins the validated destination against rebinding and verifies TLS for the original host', async () => {
    const f = fixture();
    f.state.onConnect = () => {
      f.state.addresses = [{ address: '127.0.0.1', family: 4 }];
    };
    const reply = await f.call();
    expect(reply).toMatchObject({ ok: true, kind: 'https', status: 200 });
    expect(f.state.connections).toEqual([
      {
        address: '93.184.215.14',
        hostname: 'api.example.com',
        servername: 'api.example.com',
        verifiedTls: true,
      },
    ]);
    expect(f.state.writes[0].headers.Authorization).toBe(
      'Bearer HOST_ONLY_CREDENTIAL_SENTINEL',
    );
    expect(f.state.writes[0].headers).not.toHaveProperty('Cookie');
    expect(JSON.stringify(reply)).not.toContain(f.state.token);
  });
  it('rechecks authority after DNS and sends no request when access was revoked', async () => {
    const f = fixture();
    f.state.onLookup = () => {
      f.state.revoked = true;
    };
    expect(await f.call()).toEqual({ ok: false, code: 'permission_denied' });
    expect(f.state.connections).toEqual([]);
    const bytesSentToRejectedPeer = f.state.writes.length;
    expect(bytesSentToRejectedPeer).toBe(0);
  });
  it('rechecks authority after connection and before writing credentials or body', async () => {
    const f = fixture();
    f.state.onConnect = () => {
      f.state.revoked = true;
    };
    expect(await f.call()).toEqual({ ok: false, code: 'permission_denied' });
    expect(f.state.connections).toHaveLength(1);
    expect(f.state.writes).toEqual([]);
  });
  it.each([301, 302, 307, 308])(
    'never follows provider redirect %s',
    async (status) => {
      const f = fixture();
      f.state.status = status;
      f.state.headers.location = 'https://127.0.0.1/private';
      expect(await f.call()).toEqual({ ok: false, code: 'provider_error' });
      expect(f.state.connections).toHaveLength(1);
    },
  );
  it('bounds a response without Content-Length while streaming', async () => {
    const f = fixture();
    f.state.chunks = [
      Buffer.alloc(512 * 1024),
      Buffer.alloc(512 * 1024),
      Buffer.from('overflow'),
    ];
    expect(await f.call()).toEqual({ ok: false, code: 'invalid_response' });
  });
  it('requests identity encoding and rejects a compressed response before decompression', async () => {
    const f = fixture();
    f.state.headers['content-encoding'] = 'gzip';
    f.state.chunks = [Buffer.from('compressed-bomb-fixture')];
    expect(await f.call()).toEqual({ ok: false, code: 'invalid_response' });
    expect(f.state.writes[0].headers['Accept-Encoding']).toBe('identity');
  });
  it('forwards only the bounded response headers and rejects an echoed credential', async () => {
    const f = fixture();
    f.state.headers = {
      'set-cookie': ['session=private'],
      authorization: 'unrelated-secret',
      'retry-after': '4',
      'content-type': 'application/json',
    };
    expect(await f.call()).toEqual({
      ok: true,
      kind: 'https',
      status: 200,
      headers: { retryAfter: '4', contentType: 'application/json' },
      body: '{"items":[]}',
    });
    f.state.chunks = [Buffer.from(JSON.stringify({ error: f.state.token }))];
    expect(await f.call()).toEqual({ ok: false, code: 'invalid_response' });
  });
  it('cancels a pending response without returning the underlying error or credential', async () => {
    const f = fixture(),
      controller = new AbortController();
    f.state.stall = true;
    const pending = f.call(f.request, controller.signal);
    await expect.poll(() => f.state.writes.length).toBe(1);
    controller.abort();
    const reply = await pending;
    expect(reply).toEqual({ ok: false, code: 'cancelled' });
    expect(f.state.aborted).toBe(true);
    expect(JSON.stringify(reply)).not.toContain('sentinel');
  });
  it('enforces thirty seconds even when DNS never completes', async () => {
    const f = fixture();
    f.state.stalledDns = true;
    vi.useFakeTimers();
    let settled = false;
    const pending = f.call().then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, code: 'timeout' });
    expect(f.state.connections).toEqual([]);
  });
  it('rejects userinfo at the shared host-only transport boundary', async () => {
    const f = fixture();
    await expect(
      requestAbilityHttps(
        {
          url: 'https://user:secret@api.example.com/token',
          method: 'POST',
          headers: {},
          signal: new AbortController().signal,
          authorize: async () => {},
        },
        f.transport,
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(f.state.connections).toEqual([]);
  });
});

describe('confirmed authentication rejection', () => {
  it('refreshes host credentials once after 401 and repeats only that confirmed rejection', async () => {
    const f = fixture();
    f.state.beforeWrite = () => {
      f.state.status = f.state.writes.length === 0 ? 401 : 200;
    };
    const credential = vi.fn(
      async (_context, _rule, _signal, rejected?: string) =>
        rejected ? 'ROTATED_HOST_ONLY_TOKEN' : f.state.token,
    );
    const http = new AbilityHttp({
      authorize: async () => f.binding,
      credential,
      transport: f.transport,
    });
    const result = await http.request(
      f.context,
      f.request,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(credential).toHaveBeenCalledTimes(2);
    expect(credential.mock.calls[1][3]).toBe(f.state.token);
    expect(f.state.writes.map((write) => write.headers.Authorization)).toEqual([
      'Bearer ' + f.state.token,
      'Bearer ROTATED_HOST_ONLY_TOKEN',
    ]);
    expect(JSON.stringify(result)).not.toContain('HOST_ONLY');
  });
  it.each([401, 503])(
    'bounds repeated %s responses without retrying unknown mutation delivery',
    async (status) => {
      const f = fixture();
      f.state.status = status;
      const rule = f.binding.manifest.permissions.find(
        (item) => item.id === 'search',
      );
      if (rule?.kind === 'https') rule.method = 'POST';
      const credential = vi.fn(async () => f.state.token);
      const http = new AbilityHttp({
        authorize: async () => f.binding,
        credential,
        transport: f.transport,
      });
      expect(
        await http.request(f.context, f.request, new AbortController().signal),
      ).toMatchObject({ ok: true, status });
      expect(f.state.writes).toHaveLength(status === 401 ? 2 : 1);
    },
  );
  it('checks current authority before refreshing a rejected credential', async () => {
    const f = fixture();
    f.state.status = 401;
    f.state.beforeWrite = () => {
      f.state.revoked = true;
    };
    const credential = vi.fn(async () => f.state.token);
    const http = new AbilityHttp({
      authorize: async () => {
        if (f.state.revoked) throw new AbilityFailure('permission_denied');
        return f.binding;
      },
      credential,
      transport: f.transport,
    });
    expect(
      await http.request(f.context, f.request, new AbortController().signal),
    ).toEqual({ ok: false, code: 'permission_denied' });
    expect(credential).toHaveBeenCalledTimes(1);
  });
});
