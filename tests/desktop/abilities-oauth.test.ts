import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../fixtures/abilities/manifest.json';
import { parseManifest } from '../../src/shared/abilities/manifest.ts';
import type {
  Binding,
  InvocationContext,
} from '../../src/shared/abilities/types.ts';
import type { ProtectedStorage } from '../../src/desktop/host/backup-keys.ts';
import {
  AbilityCredentials,
  type AccountKey,
  type StoredAccount,
} from '../../src/desktop/host/abilities/credentials.ts';
import { AbilityOAuth } from '../../src/desktop/host/abilities/oauth.ts';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(join(root, entry.name))
          : [join(root, entry.name)],
      ),
    )
  ).flat();
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ability-oauth-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cipherKey = randomBytes(32);
  const storage: ProtectedStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', cipherKey, iv);
      const bytes = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString: (bytes) => {
      const cipher = createDecipheriv(
        'aes-256-gcm',
        cipherKey,
        bytes.subarray(0, 12),
      );
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString('utf8');
    },
  };
  const credentials = new AbilityCredentials({
    root: join(root, 'credentials'),
    storage,
    platform: 'darwin',
  });
  const binding: Binding = {
    id: randomUUID(),
    dotId: 'dot',
    digest: 'a'.repeat(64),
    manifest: parseManifest(manifest),
    grants: ['account', 'search'],
    settings: { clientId: 'personal-client' },
    revision: 1,
    enabled: true,
    restored: false,
    approvedAt: 100,
  };
  const context: InvocationContext = {
    workspaceId: 'workspace',
    sessionId: 'session',
    dotId: binding.dotId,
    bindingId: binding.id,
    digest: binding.digest,
    grantRevision: 1,
    invocationId: randomUUID(),
    tool: 'search',
    threadId: 'thread',
  };
  const state = {
    now: Date.now(),
    sessionId: 'session',
    active: true,
    urls: [] as URL[],
    exchanges: [] as URLSearchParams[],
    cleared: [] as string[],
    response: {
      access_token: 'ACCESS_TOKEN_SENTINEL',
      refresh_token: 'REFRESH_TOKEN_SENTINEL',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'read-items',
    } as Record<string, unknown>,
    onExchange: async () => {},
    opened: async (_url: URL) => {},
  };
  const oauth = new AbilityOAuth({
    workspaceId: 'workspace',
    credentials,
    now: () => state.now,
    session: () => (state.active ? state.sessionId : undefined),
    binding: async (id) => {
      if (id !== binding.id) throw new Error('Wrong binding');
      return structuredClone(binding);
    },
    authorize: async (current) => {
      if (
        !state.active ||
        current.sessionId !== state.sessionId ||
        current.grantRevision !== binding.revision ||
        !binding.enabled
      )
        throw new Error('No authority');
      return structuredClone(binding);
    },
    open: async (value) => {
      const url = new URL(value);
      state.urls.push(url);
      await state.opened(url);
    },
    clearResults: (id) => {
      state.cleared.push(id);
    },
    exchange: async (input) => {
      await input.authorize();
      expect(input.url).toBe('https://accounts.example.com/token');
      expect(input.method).toBe('POST');
      expect(input.headers['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
      const form = new URLSearchParams(input.body);
      expect(form.has('client_secret')).toBe(false);
      state.exchanges.push(form);
      await state.onExchange();
      return {
        status: 200,
        headers: { contentType: 'application/json' },
        body: JSON.stringify(state.response),
      };
    },
  });
  cleanup.push(() => oauth.stop());
  const callback = async (
    authorization = state.urls.at(-1)!,
    parameters: Record<string, string> = {},
    host?: string,
  ) => {
    const url = new URL(authorization.searchParams.get('redirect_uri')!);
    url.search = new URLSearchParams({
      code: 'fixture-code',
      state: authorization.searchParams.get('state')!,
      ...parameters,
    }).toString();
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(url, { headers: host ? { host } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
      req.on('error', reject);
      req.end();
    });
  };
  const connect = async () => {
    const pending = oauth.connect(binding.id, 'personal-client');
    await expect.poll(() => state.urls.length).toBeGreaterThan(0);
    const response = await callback();
    await pending;
    return response;
  };
  return {
    root,
    storage,
    credentials,
    binding,
    context,
    state,
    oauth,
    callback,
    connect,
  };
}
describe('host-only OAuth credentials', () => {
  it('encrypts atomic account records and binds reads to the exact account key', async () => {
    const f = await fixture();
    const key: AccountKey = {
      workspaceId: 'workspace',
      dotId: 'dot',
      bindingId: f.binding.id,
      source: 'example/abilities',
      abilityId: 'fixture',
      digest: f.binding.digest,
      accountId: 'account',
      clientId: 'personal-client',
      consentRevision: 100,
      handle: randomUUID(),
    };
    const account: StoredAccount = {
      accessToken: 'ACCESS_TOKEN_SENTINEL',
      refreshToken: 'REFRESH_TOKEN_SENTINEL',
      expiresAt: Date.now() + 60000,
      scopes: ['read-items'],
    };
    await f.credentials.write(key, account);
    expect(await f.credentials.read(key)).toEqual(account);
    expect(
      await f.credentials.read({ ...key, dotId: 'other-dot' }),
    ).toBeUndefined();
    expect(
      await f.credentials.read({ ...key, handle: randomUUID() }),
    ).toBeUndefined();
    const stored = await files(f.root);
    expect(stored).toHaveLength(1);
    expect(
      (await readFile(stored[0])).includes(Buffer.from('TOKEN_SENTINEL')),
    ).toBe(false);
    expect((await stat(stored[0])).mode & 0o777).toBe(0o600);
    await f.credentials.remove(key);
    expect(await f.credentials.read(key)).toBeUndefined();
    const replacement = { ...key, handle: randomUUID() };
    await f.credentials.write(replacement, account);
    await f.credentials.remove(key);
    expect(await f.credentials.read(replacement)).toEqual(account);
  });
  it('requires secure storage before opening the browser and never falls back to plaintext', async () => {
    const f = await fixture();
    f.storage.isEncryptionAvailable = () => false;
    await expect(
      f.oauth.connect(f.binding.id, 'personal-client'),
    ).rejects.toMatchObject({ code: 'setup_needed' });
    expect(f.state.urls).toEqual([]);
    expect(await files(f.root)).toEqual([]);
  });
});
describe('PKCE callback authority', () => {
  it('uses S256 and a dynamic literal-loopback callback; only generic status reaches UI', async () => {
    const f = await fixture();
    const visible: unknown[] = [];
    visible.push(await f.connect());
    visible.push(await f.oauth.presence(f.binding.id, 'account'));
    const url = f.state.urls[0],
      exchange = f.state.exchanges[0];
    expect(url.origin).toBe('https://accounts.example.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256')
        .update(exchange.get('code_verifier')!)
        .digest('base64url'),
    );
    expect(exchange.get('code_verifier')!.length).toBeGreaterThanOrEqual(43);
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    expect(callback.hostname).toBe('127.0.0.1');
    expect(callback.port).not.toBe('');
    expect(callback.pathname).toBe('/abilities/oauth/callback');
    expect(exchange.get('redirect_uri')).toBe(callback.href);
    expect(await f.oauth.authorize(f.context, 'search')).toBe(
      'ACCESS_TOKEN_SENTINEL',
    );
    expect(JSON.stringify(visible)).not.toContain('TOKEN_SENTINEL');
    expect((await f.oauth.presence(f.binding.id, 'account')).handle).toMatch(
      /^[a-f0-9-]{36}$/,
    );
    await expect(f.callback()).rejects.toThrow();
    expect(f.state.exchanges).toHaveLength(1);
  });
  it('rejects wrong states, paths and ports without consuming a valid callback', async () => {
    const f = await fixture();
    const pending = f.oauth.connect(f.binding.id, 'personal-client');
    await expect.poll(() => f.state.urls.length).toBe(1);
    expect((await f.callback(undefined, { state: 'wrong' })).status).toBe(400);
    expect((await f.callback(undefined, {}, '127.0.0.1:1')).status).toBe(400);
    const bad = new URL(f.state.urls[0]);
    const redirect = new URL(bad.searchParams.get('redirect_uri')!);
    redirect.pathname = '/wrong';
    bad.searchParams.set('redirect_uri', redirect.href);
    expect((await f.callback(bad)).status).toBe(404);
    expect(f.state.exchanges).toHaveLength(0);
    await f.callback();
    await pending;
    expect(f.state.exchanges).toHaveLength(1);
  });
  it('consumes a matching state before token exchange so a concurrent replay cannot exchange twice', async () => {
    const f = await fixture();
    let release: () => void = () => {};
    f.state.onExchange = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const pending = f.oauth.connect(f.binding.id, 'personal-client');
    await expect.poll(() => f.state.urls.length).toBe(1);
    const first = f.callback();
    await expect.poll(() => f.state.exchanges.length).toBe(1);
    const replay = await f.callback().catch(() => ({ status: 0, body: '' }));
    expect([0, 400, 409]).toContain(replay.status);
    release();
    await first;
    await pending;
    const tokenExchangesForState = f.state.exchanges.length;
    expect(tokenExchangesForState).toBe(1);
  });
  it.each(['dot', 'session', 'revision'])(
    'rejects a callback after its %s authority changes',
    async (changed) => {
      const f = await fixture();
      const pending = f.oauth.connect(f.binding.id, 'personal-client');
      const failure = pending.catch((error) => error);
      await expect.poll(() => f.state.urls.length).toBe(1);
      if (changed === 'dot') f.binding.dotId = 'different-dot';
      if (changed === 'session') f.state.sessionId = 'replacement-session';
      if (changed === 'revision') f.binding.revision++;
      await f.callback();
      expect(await failure).toMatchObject({ code: 'permission_denied' });
      expect(f.state.exchanges).toEqual([]);
    },
  );
  it('expires the state at 300000 milliseconds and closes the listener', async () => {
    const f = await fixture();
    const pending = f.oauth.connect(f.binding.id, 'personal-client');
    const failure = pending.catch((error) => error);
    await expect.poll(() => f.state.urls.length).toBe(1);
    f.state.now += 300000;
    await f.callback();
    expect(await failure).toMatchObject({ code: 'timeout' });
    expect(f.state.exchanges).toEqual([]);
    await expect(f.callback()).rejects.toThrow();
  });
  it('disconnect cancels browser sign-in and deletes accounts and private result handles', async () => {
    const f = await fixture();
    const pending = f.oauth.connect(f.binding.id, 'personal-client');
    const failure = pending.catch((error) => error);
    await expect.poll(() => f.state.urls.length).toBe(1);
    await f.oauth.disconnect(f.binding.id);
    expect(await failure).toMatchObject({ code: 'cancelled' });
    await expect(f.callback()).rejects.toThrow();
    expect(f.state.exchanges).toEqual([]);
    expect(f.state.cleared).toContain(f.binding.id);
  });
  it('uses the requested scopes when omitted, and refuses a different provider scope set', async () => {
    const f = await fixture();
    delete f.state.response.scope;
    await f.connect();
    expect(await f.oauth.authorize(f.context, 'search')).toBe(
      'ACCESS_TOKEN_SENTINEL',
    );
    await f.oauth.disconnect(f.binding.id);
    f.state.urls.length = 0;
    f.state.response.scope = 'unapproved-scope';
    const pending = f.oauth.connect(f.binding.id, 'personal-client');
    const failure = pending.catch((error) => error);
    await expect.poll(() => f.state.urls.length).toBe(1);
    await f.callback();
    expect(await failure).toMatchObject({ code: 'permission_denied' });
    expect(await f.oauth.presence(f.binding.id, 'account')).toEqual({
      connected: false,
    });
  });
  it('removes a newly written account if consent changes during the encrypted write', async () => {
    const f = await fixture();
    const write = f.credentials.write.bind(f.credentials);
    vi.spyOn(f.credentials, 'write').mockImplementation(
      async (key, account) => {
        await write(key, account);
        f.binding.revision++;
      },
    );
    const pending = f.oauth.connect(f.binding.id, 'personal-client');
    const failure = pending.catch((error) => error);
    await expect.poll(() => f.state.urls.length).toBe(1);
    expect((await f.callback()).status).toBe(400);
    expect(await failure).toMatchObject({ code: 'permission_denied' });
    expect(await f.oauth.presence(f.binding.id, 'account')).toEqual({
      connected: false,
    });
    expect(await files(f.root)).toEqual([]);
  });
  it('waits for an in-flight credential write to be cleaned up before disconnect completes', async () => {
    const f = await fixture();
    const write = f.credentials.write.bind(f.credentials);
    let release = () => {},
      writing = false,
      disconnected = false;
    vi.spyOn(f.credentials, 'write').mockImplementation(
      async (key, account) => {
        writing = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await write(key, account);
      },
    );
    const pending = f.oauth
      .connect(f.binding.id, 'personal-client')
      .catch((error) => error);
    await expect.poll(() => f.state.urls.length).toBe(1);
    const callback = f.callback().catch(() => undefined);
    await expect.poll(() => writing).toBe(true);
    const disconnecting = f.oauth.disconnect(f.binding.id).then(() => {
      disconnected = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const finishedEarly = disconnected;
    release();
    await disconnecting;
    await callback;
    expect(await pending).toMatchObject({ code: 'cancelled' });
    expect(finishedEarly).toBe(false);
    expect(await files(f.root)).toEqual([]);
  });
  it.each(['encryption', 'provider'])(
    'keeps %s failures out of callbacks, errors and logs',
    async (kind) => {
      const f = await fixture();
      const logs = ['log', 'warn', 'error'].map((method) =>
        vi.spyOn(console, method as 'log').mockImplementation(() => {}),
      );
      if (kind === 'provider')
        f.state.response.access_token = { raw: 'ACCESS_TOKEN_SENTINEL' };
      else
        f.storage.encryptString = () => {
          throw new Error('ACCESS_TOKEN_SENTINEL');
        };
      const pending = f.oauth.connect(f.binding.id, 'personal-client');
      const failure = pending.catch((error) => error);
      await expect.poll(() => f.state.urls.length).toBe(1);
      const callback = await f.callback(),
        error = await failure;
      expect(error).toMatchObject({
        code: kind === 'provider' ? 'invalid_response' : 'setup_needed',
      });
      expect(
        JSON.stringify([
          callback,
          error.message,
          logs.map((log) => log.mock.calls),
        ]),
      ).not.toContain('TOKEN_SENTINEL');
      expect(await files(f.root)).toEqual([]);
    },
  );
});
describe('refresh and revocation ordering', () => {
  it('cancels pending sign-in on disable while preserving an idle approved account', async () => {
    const f = await fixture();
    await f.connect();
    await f.oauth.cancelBinding(f.binding.id);
    expect((await f.oauth.presence(f.binding.id, 'account')).connected).toBe(
      true,
    );
    const pending = f.oauth
      .connect(f.binding.id, 'personal-client')
      .catch((error) => error);
    await expect.poll(() => f.state.urls.length).toBe(2);
    await f.oauth.cancelBinding(f.binding.id);
    expect(await pending).toMatchObject({ code: 'cancelled' });
    expect((await f.oauth.presence(f.binding.id, 'account')).connected).toBe(
      true,
    );
  });
  it('finishes an old refresh before opening a replacement account connection', async () => {
    const f = await fixture();
    await f.connect();
    f.state.now += 3600000;
    let release = () => {};
    f.state.onExchange = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const refreshing = f.oauth
      .authorize(f.context, 'search')
      .catch((error) => error);
    await expect.poll(() => f.state.exchanges.length).toBe(2);
    const connecting = f.oauth.connect(f.binding.id, 'personal-client');
    void connecting.catch(() => {});
    await expect.poll(() => f.state.urls.length).toBe(2);
    release();
    expect(await refreshing).toMatchObject({ code: 'cancelled' });
    f.state.onExchange = async () => {};
    f.state.response.access_token = 'REPLACEMENT_TOKEN';
    await f.callback();
    await connecting;
    expect(await f.oauth.authorize(f.context, 'search')).toBe(
      'REPLACEMENT_TOKEN',
    );
  });
  it('rejects refresh when its grant is revoked while the provider responds', async () => {
    const f = await fixture();
    await f.connect();
    f.state.now += 3600000;
    f.state.onExchange = async () => {
      f.binding.enabled = false;
      f.binding.revision++;
    };
    await expect(f.oauth.authorize(f.context, 'search')).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(await f.oauth.presence(f.binding.id, 'account')).toEqual({
      connected: false,
    });
    expect(await files(f.root)).toEqual([]);
  });
  it('refreshes once for simultaneous calls and preserves a rotated refresh token', async () => {
    const f = await fixture();
    await f.connect();
    f.state.now += 3600000;
    f.state.response = {
      access_token: 'ACCESS_TOKEN_ROTATED',
      refresh_token: 'REFRESH_TOKEN_ROTATED',
      token_type: 'Bearer',
      expires_in: 3600,
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => f.oauth.authorize(f.context, 'search')),
    );
    expect(results).toEqual(Array(5).fill('ACCESS_TOKEN_ROTATED'));
    const parallelRefreshRequests = f.state.exchanges.filter(
      (form) => form.get('grant_type') === 'refresh_token',
    ).length;
    expect(parallelRefreshRequests).toBe(1);
    expect(f.state.exchanges[1].get('refresh_token')).toBe(
      'REFRESH_TOKEN_SENTINEL',
    );
    f.state.now += 3600000;
    await f.oauth.authorize(f.context, 'search');
    expect(f.state.exchanges[2].get('refresh_token')).toBe(
      'REFRESH_TOKEN_ROTATED',
    );
  });
  it('does not reconnect an approved account merely because a binding was disabled and enabled', async () => {
    const f = await fixture();
    await f.connect();
    const before = await f.oauth.presence(f.binding.id, 'account');
    f.binding.revision += 2;
    f.context.grantRevision = f.binding.revision;
    expect(await f.oauth.authorize(f.context, 'search')).toBe(
      'ACCESS_TOKEN_SENTINEL',
    );
    expect(await f.oauth.presence(f.binding.id, 'account')).toEqual(before);
    expect(f.state.exchanges).toHaveLength(1);
  });
  it('prevents a refresh response racing disconnect from restoring deleted credentials', async () => {
    const f = await fixture();
    await f.connect();
    f.state.now += 3600000;
    let release: () => void = () => {};
    f.state.onExchange = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const pending = f.oauth
      .authorize(f.context, 'search')
      .catch((error) => error);
    await expect.poll(() => f.state.exchanges.length).toBe(2);
    await f.oauth.disconnect(f.binding.id);
    release();
    expect(await pending).toMatchObject({ code: 'cancelled' });
    expect(await f.oauth.presence(f.binding.id, 'account')).toEqual({
      connected: false,
    });
    expect(await files(f.root)).toEqual([]);
  });
  it('rejects a token saved for another approval, client ID or Dot', async () => {
    const f = await fixture();
    await f.connect();
    f.binding.approvedAt++;
    await expect(f.oauth.authorize(f.context, 'search')).rejects.toMatchObject({
      code: 'setup_needed',
    });
    f.binding.approvedAt--;
    f.binding.settings.clientId = 'another-client';
    await expect(f.oauth.authorize(f.context, 'search')).rejects.toMatchObject({
      code: 'setup_needed',
    });
    f.binding.settings.clientId = 'personal-client';
    f.binding.dotId = 'another-dot';
    await expect(f.oauth.authorize(f.context, 'search')).rejects.toMatchObject({
      code: 'permission_denied',
    });
  });
});

it('refreshes a still-unexpired token rejected by the provider, without rotating again for a stale rejection', async () => {
  const f = await fixture();
  await f.connect();
  const rejected = 'ACCESS_TOKEN_SENTINEL';
  f.state.response = {
    access_token: 'ACCESS_TOKEN_ROTATED',
    refresh_token: 'REFRESH_TOKEN_ROTATED',
    token_type: 'Bearer',
    expires_in: 3600,
  };
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.oauth.authorize(
        f.context,
        'search',
        new AbortController().signal,
        rejected,
      ),
    ),
  );
  expect(results).toEqual(Array(5).fill('ACCESS_TOKEN_ROTATED'));
  expect(
    f.state.exchanges.filter(
      (form) => form.get('grant_type') === 'refresh_token',
    ),
  ).toHaveLength(1);
  expect(
    await f.oauth.authorize(
      f.context,
      'search',
      new AbortController().signal,
      rejected,
    ),
  ).toBe('ACCESS_TOKEN_ROTATED');
  expect(f.state.exchanges).toHaveLength(2);
});
