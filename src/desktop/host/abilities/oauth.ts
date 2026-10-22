import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import {
  AbilityFailure,
  failureCode,
} from '../../../shared/abilities/bridge.js';
import {
  abilityLimits,
  assertBoundedJson,
} from '../../../shared/abilities/limits.js';
import {
  permissionSchema,
  type AbilityPermission,
} from '../../../shared/abilities/manifest.js';
import { canonicalJson } from '../../../shared/abilities/permissions.js';
import type {
  Binding,
  InvocationContext,
} from '../../../shared/abilities/types.js';
import {
  AbilityCredentials,
  accountTokenSchema,
  type AccountScope,
  type AccountKey,
  type StoredAccount,
} from './credentials.js';
import { requestAbilityHttps } from './http.js';

type OAuthPermission = Extract<AbilityPermission, { kind: 'oauth' }>;
type Attempt = {
  controller: AbortController;
  promise: Promise<void>;
  server?: Server;
};
type Refresh = {
  bindingId: string;
  controller: AbortController;
  promise: Promise<string>;
};
type Options = {
  workspaceId: string;
  credentials: AbilityCredentials;
  session(): string | undefined;
  binding(bindingId: string): Promise<Binding>;
  authorize(context: InvocationContext): Promise<Binding>;
  open(url: string): Promise<void>;
  clearResults(bindingId: string): void;
  now?: () => number;
  exchange?: typeof requestAbilityHttps;
};
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(
        signal.reason instanceof AbilityFailure
          ? signal.reason
          : new AbilityFailure('cancelled'),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
function sameState(actual: string, expected: string): boolean {
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
const tokenReply = z.object({
  access_token: accountTokenSchema,
  refresh_token: accountTokenSchema.optional(),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(31_536_000),
  scope: z.string().max(5100).optional(),
});

export class AbilityOAuth {
  private readonly connections = new Map<string, Attempt>();
  private readonly refreshes = new Map<string, Refresh>();
  private readonly epochs = new Map<string, number>();
  private stopped = false;
  constructor(private readonly options: Options) {}
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  private epoch(id: string): number {
    return this.epochs.get(id) ?? 0;
  }
  private session(): string {
    const session = this.options.session();
    if (!session || this.stopped) throw new AbilityFailure('host_unavailable');
    return session;
  }
  private permission(binding: Binding, accountId?: string): OAuthPermission {
    const accounts = binding.manifest.permissions.filter(
      (p): p is OAuthPermission =>
        p.kind === 'oauth' && binding.grants.includes(p.id),
    );
    const account = accountId
      ? accounts.find((p) => p.id === accountId)
      : accounts.length === 1
        ? accounts[0]
        : undefined;
    if (!account) throw new AbilityFailure('permission_denied');
    const parsed = permissionSchema.parse(account);
    if (parsed.kind !== 'oauth') throw new AbilityFailure('permission_denied');
    return parsed;
  }
  private scope(binding: Binding, permission: OAuthPermission): AccountScope {
    const clientId = binding.settings[permission.clientIdSetting];
    if (typeof clientId !== 'string' || !clientId || clientId.length > 256)
      throw new AbilityFailure('setup_needed');
    return {
      workspaceId: this.options.workspaceId,
      dotId: binding.dotId,
      bindingId: binding.id,
      source: `${binding.manifest.source.owner}/${binding.manifest.source.repository}`,
      abilityId: binding.manifest.id,
      digest: binding.digest,
      accountId: permission.id,
      clientId,
      consentRevision: binding.approvedAt,
    };
  }
  private async active(context: InvocationContext): Promise<Binding> {
    if (
      context.workspaceId !== this.options.workspaceId ||
      context.sessionId !== this.session()
    )
      throw new AbilityFailure('permission_denied');
    let binding: Binding;
    try {
      binding = await this.options.authorize(context);
    } catch {
      throw new AbilityFailure('permission_denied');
    }
    if (
      !binding.enabled ||
      binding.restored ||
      binding.id !== context.bindingId ||
      binding.dotId !== context.dotId ||
      binding.digest !== context.digest ||
      binding.revision !== context.grantRevision ||
      context.sessionId !== this.session()
    )
      throw new AbilityFailure('permission_denied');
    return binding;
  }
  private parseToken(
    body: string,
    scopes: string[],
    previous?: StoredAccount,
  ): StoredAccount {
    try {
      const value: unknown = JSON.parse(body);
      assertBoundedJson(value, 64 * 1024);
      const reply = tokenReply.parse(value);
      // RFC 6749 permits omission only when scope is unchanged. Never expand the
      // owner's grant based on a broader token returned by an existing account.
      const returned =
        reply.scope === undefined
          ? (previous?.scopes ?? scopes)
          : reply.scope.split(' ').filter(Boolean);
      if (
        canonicalJson([...new Set(returned)].sort()) !==
        canonicalJson([...new Set(scopes)].sort())
      )
        throw new AbilityFailure('permission_denied');
      const refreshToken = reply.refresh_token ?? previous?.refreshToken;
      return {
        accessToken: reply.access_token,
        ...(refreshToken ? { refreshToken } : {}),
        expiresAt: this.now() + reply.expires_in * 1000,
        scopes: [...scopes].sort(),
      };
    } catch (error) {
      throw error instanceof AbilityFailure
        ? error
        : new AbilityFailure('invalid_response');
    }
  }
  connect(
    bindingId: string,
    clientId: string,
    accountId?: string,
  ): Promise<void> {
    if (this.connections.has(bindingId))
      return Promise.reject(new AbilityFailure('busy'));
    const attempt: Attempt = {
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    const promise = this.connectAccount(
      bindingId,
      clientId,
      accountId,
      attempt,
    );
    attempt.promise = promise;
    this.connections.set(bindingId, attempt);
    return promise.finally(() => {
      if (this.connections.get(bindingId) === attempt)
        this.connections.delete(bindingId);
    });
  }
  private async connectAccount(
    bindingId: string,
    clientId: string,
    accountId: string | undefined,
    attempt: Attempt,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let server: Server | undefined;
    let callbackTask: Promise<void> | undefined;
    try {
      const session = this.session(),
        epoch = this.epoch(bindingId),
        signal = attempt.controller.signal;
      if (!this.options.credentials.available())
        throw new AbilityFailure('setup_needed');
      const refreshing = [...this.refreshes.values()].filter(
        (item) => item.bindingId === bindingId,
      );
      for (const item of refreshing)
        item.controller.abort(new AbilityFailure('cancelled'));
      await Promise.all(refreshing.map((item) => item.promise.catch(() => {})));
      const binding = await this.options.binding(bindingId);
      if (!binding.enabled || binding.restored || binding.id !== bindingId)
        throw new AbilityFailure('permission_denied');
      const permission = this.permission(binding, accountId),
        scope = this.scope(binding, permission);
      if (scope.clientId !== clientId)
        throw new AbilityFailure('permission_denied');
      const check = async () => {
        signal.throwIfAborted();
        if (this.session() !== session || this.epoch(bindingId) !== epoch)
          throw new AbilityFailure('permission_denied');
        const current = await this.options.binding(bindingId);
        if (
          this.session() !== session ||
          this.epoch(bindingId) !== epoch ||
          canonicalJson(current) !== canonicalJson(binding)
        )
          throw new AbilityFailure('permission_denied');
        signal.throwIfAborted();
      };
      const state = randomBytes(32).toString('base64url'),
        verifier = randomBytes(64).toString('base64url');
      const expiresAt = this.now() + abilityLimits.oauthStateMs;
      let claimed = false,
        redirect = '';
      let finish: (error?: unknown) => void = () => {};
      const done = new Promise<void>((resolve, reject) => {
        finish = (error) => (error ? reject(error) : resolve());
      });
      void done.catch(() => {});
      server = createServer(
        {
          maxHeaderSize: 8192,
          requestTimeout: 1000,
          headersTimeout: 1000,
          keepAliveTimeout: 1000,
        },
        (request, response) => {
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.setHeader('X-Content-Type-Options', 'nosniff');
          response.setHeader('Connection', 'close');
          const reply = (status: number, message: string) => {
            response.statusCode = status;
            response.end(message);
          };
          let url: URL;
          try {
            if (
              request.method !== 'GET' ||
              !request.url ||
              request.url.length > 8192
            ) {
              reply(400, 'Invalid callback.');
              return;
            }
            url = new URL(request.url, redirect);
            if (
              request.headers.host !== new URL(redirect).host ||
              !['127.0.0.1', '::ffff:127.0.0.1'].includes(
                request.socket.remoteAddress ?? '',
              )
            ) {
              reply(400, 'Invalid callback.');
              return;
            }
            if (url.pathname !== '/abilities/oauth/callback') {
              reply(404, 'Not found.');
              return;
            }
            if (claimed) {
              reply(409, 'This connection was already used.');
              return;
            }
            const states = url.searchParams.getAll('state');
            if (states.length !== 1 || !sameState(states[0], state)) {
              reply(400, 'Invalid callback.');
              return;
            }
            if (
              [...url.searchParams.keys()].some(
                (key) =>
                  !['state', 'code', 'error', 'error_description'].includes(
                    key,
                  ),
              ) ||
              url.searchParams.getAll('code').length > 1 ||
              url.searchParams.getAll('error').length > 1
            ) {
              reply(400, 'Invalid callback.');
              return;
            }
          } catch {
            reply(400, 'Invalid callback.');
            return;
          }
          claimed = true;
          server!.close();
          callbackTask = (async () => {
            let writtenKey: AccountKey | undefined;
            try {
              if (this.now() >= expiresAt) throw new AbilityFailure('timeout');
              await check();
              const code = url.searchParams.get('code');
              if (url.searchParams.has('error') || !code || code.length > 4096)
                throw new AbilityFailure('setup_needed');
              const token = await wait(
                (this.options.exchange ?? requestAbilityHttps)({
                  url: permission.tokenUrl,
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json',
                  },
                  body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: clientId,
                    code,
                    redirect_uri: redirect,
                    code_verifier: verifier,
                  }).toString(),
                  signal,
                  authorize: check,
                }),
                signal,
              );
              if (token.status !== 200)
                throw new AbilityFailure('provider_error');
              const account = this.parseToken(token.body, permission.scopes);
              await check();
              writtenKey = { ...scope, handle: randomUUID() };
              await this.options.credentials.write(writtenKey, account);
              await check();
              this.options.clearResults(bindingId);
              response.once('finish', () => finish());
              reply(200, 'Connected. You can return to Dot.');
            } catch (error) {
              if (writtenKey)
                await this.options.credentials
                  .remove(writtenKey)
                  .catch(() => {});
              const failure =
                error instanceof AbilityFailure
                  ? error
                  : new AbilityFailure('permission_denied');
              response.once('finish', () => finish(failure));
              reply(
                400,
                'Connection was not completed. Return to Dot and try again.',
              );
            }
          })();
        },
      );
      attempt.server = server;
      server.maxConnections = 16;
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new AbilityFailure('host_unavailable');
      redirect = `http://127.0.0.1:${address.port}/abilities/oauth/callback`;
      const abort = () => {
        server!.closeAllConnections();
        server!.close();
        finish(
          signal.reason instanceof AbilityFailure
            ? signal.reason
            : new AbilityFailure('cancelled'),
        );
      };
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(
        () => attempt.controller.abort(new AbilityFailure('timeout')),
        abilityLimits.oauthStateMs,
      );
      timer.unref?.();
      try {
        await check();
        const url = new URL(permission.authorizationUrl);
        for (const [key, value] of Object.entries({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirect,
          state,
          scope: permission.scopes.join(' '),
          code_challenge_method: 'S256',
          code_challenge: createHash('sha256')
            .update(verifier)
            .digest('base64url'),
        }))
          url.searchParams.set(key, value);
        await this.options.open(url.href);
        await done;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    } catch (error) {
      throw error instanceof AbilityFailure
        ? error
        : new AbilityFailure('permission_denied');
    } finally {
      clearTimeout(timer);
      server?.closeAllConnections();
      server?.close();
      await callbackTask;
    }
  }
  async presence(
    bindingId: string,
    accountId?: string,
  ): Promise<{ connected: boolean; handle?: string }> {
    if (!this.options.credentials.available() || this.stopped)
      return { connected: false };
    const binding = await this.options.binding(bindingId),
      permission = this.permission(binding, accountId);
    let scope: AccountScope;
    try {
      scope = this.scope(binding, permission);
    } catch {
      return { connected: false };
    }
    const record = await this.options.credentials.current(scope);
    return record
      ? { connected: true, handle: record.key.handle }
      : { connected: false };
  }
  async authorize(
    context: InvocationContext,
    ruleId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<string> {
    if (this.connections.has(context.bindingId))
      throw new AbilityFailure('busy');
    const binding = await this.active(context);
    const rule = binding.manifest.permissions.find((p) => p.id === ruleId);
    if (
      rule?.kind !== 'https' ||
      !rule.account ||
      !binding.grants.includes(rule.id)
    )
      throw new AbilityFailure('permission_denied');
    const permission = this.permission(binding, rule.account);
    if (permission.resourceOrigin !== rule.origin)
      throw new AbilityFailure('permission_denied');
    const scope = this.scope(binding, permission),
      record = await this.options.credentials.current(scope);
    if (!record) throw new AbilityFailure('setup_needed');
    signal.throwIfAborted();
    if (record.account.expiresAt > this.now() + 30_000) {
      await this.active(context);
      signal.throwIfAborted();
      return record.account.accessToken;
    }
    const key = canonicalJson(record.key),
      existing = this.refreshes.get(key);
    if (existing) return wait(existing.promise, signal);
    const controller = new AbortController();
    const promise = this.refresh(
      context,
      ruleId,
      permission,
      record.key,
      controller,
      signal,
    );
    const refresh: Refresh = { bindingId: binding.id, controller, promise };
    this.refreshes.set(key, refresh);
    void promise
      .finally(() => {
        if (this.refreshes.get(key) === refresh) this.refreshes.delete(key);
      })
      .catch(() => {});
    return wait(promise, signal);
  }
  private async refresh(
    context: InvocationContext,
    ruleId: string,
    permission: OAuthPermission,
    key: AccountKey,
    controller: AbortController,
    callerSignal: AbortSignal,
  ): Promise<string> {
    const signal = AbortSignal.any([controller.signal, callerSignal]),
      epoch = this.epoch(context.bindingId);
    const check = async () => {
      signal.throwIfAborted();
      const binding = await this.active(context),
        rule = binding.manifest.permissions.find((p) => p.id === ruleId);
      if (
        this.epoch(context.bindingId) !== epoch ||
        rule?.kind !== 'https' ||
        rule.account !== permission.id ||
        !binding.grants.includes(ruleId) ||
        canonicalJson(
          this.scope(binding, this.permission(binding, permission.id)),
        ) !== canonicalJson((({ handle: _handle, ...scope }) => scope)(key))
      )
        throw new AbilityFailure('permission_denied');
      signal.throwIfAborted();
    };
    try {
      await check();
      const current = await this.options.credentials.read(key);
      if (!current?.refreshToken) throw new AbilityFailure('setup_needed');
      if (current.expiresAt > this.now() + 30_000) return current.accessToken;
      const response = await wait(
        (this.options.exchange ?? requestAbilityHttps)({
          url: permission.tokenUrl,
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: key.clientId,
            refresh_token: current.refreshToken,
          }).toString(),
          signal,
          authorize: check,
        }),
        signal,
      );
      if (response.status !== 200) throw new AbilityFailure('provider_error');
      const account = this.parseToken(
        response.body,
        permission.scopes,
        current,
      );
      await check();
      await this.options.credentials.write(key, account);
      await check();
      return account.accessToken;
    } catch (error) {
      await this.options.credentials.remove(key);
      this.options.clearResults(context.bindingId);
      throw signal.aborted
        ? new AbilityFailure('cancelled')
        : new AbilityFailure(failureCode(error));
    }
  }
  async disconnect(bindingId: string): Promise<void> {
    this.epochs.set(bindingId, this.epoch(bindingId) + 1);
    this.connections
      .get(bindingId)
      ?.controller.abort(new AbilityFailure('cancelled'));
    for (const refresh of this.refreshes.values())
      if (refresh.bindingId === bindingId)
        refresh.controller.abort(new AbilityFailure('cancelled'));
    this.options.clearResults(bindingId);
    await this.options.credentials.clearBinding(
      this.options.workspaceId,
      bindingId,
    );
    await this.connections.get(bindingId)?.promise.catch(() => {});
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const attempt of this.connections.values())
      attempt.controller.abort(new AbilityFailure('cancelled'));
    for (const refresh of this.refreshes.values())
      refresh.controller.abort(new AbilityFailure('cancelled'));
    await Promise.all(
      [...this.connections.values()].map((attempt) =>
        attempt.promise.catch(() => {}),
      ),
    );
    await Promise.all(
      [...this.refreshes.values()].map((refresh) =>
        refresh.promise.catch(() => {}),
      ),
    );
  }
}
