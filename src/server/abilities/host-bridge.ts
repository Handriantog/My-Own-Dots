import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import {
  AbilityFailure,
  bridgeLimit,
  failureCode,
  invocationContextSchema,
  verifiedPackageSchema,
  type HostCommand,
  type HostEvent,
} from '../../shared/abilities/bridge.js';
import {
  parseOutcome,
  parseOwnerOutcome,
} from '../../shared/abilities/protocol.js';
import { validateValue } from '../../shared/abilities/manifest.js';
import type {
  Binding,
  InstallReview,
  InvocationContext,
  InvocationOutcome,
  InvocationRequest,
  VerifiedPackage,
} from '../../shared/abilities/types.js';

export type AuthorizedAbility = {
  binding: Binding;
  package: Omit<VerifiedPackage, 'root'>;
};
export interface AbilityHostPort {
  session(): { id: string; workspaceId: string } | undefined;
  install(review: InstallReview, signal: AbortSignal): Promise<VerifiedPackage>;
  invoke(
    request: InvocationRequest,
    signal: AbortSignal,
  ): Promise<InvocationOutcome>;
  revoke(bindingId: string, revision: number): Promise<void>;
  disconnect(bindingId: string): Promise<void>;
  eraseState(bindingId: string): Promise<void>;
  uninstall(digest: string): Promise<void>;
  quiesce?(): Promise<void>;
  resume?(): Promise<void>;
  stop(): Promise<void>;
}
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
};
type Session = {
  id: string;
  token: string;
  lastSeen: number;
  incoming: number;
  outgoing: number;
  connected: boolean;
  pending: Map<string, Pending>;
  writer?: (event: HostEvent) => Promise<void>;
  close?: () => void;
  sending: Promise<void>;
};
function sameToken(actual: string | undefined, expected: string): boolean {
  const a = Buffer.from(actual?.replace(/^Bearer /, '') ?? ''),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class AbilityHostBridge implements AbilityHostPort {
  private current?: Session;
  private authority: (
    context: InvocationContext,
  ) => Promise<AuthorizedAbility> = async () => {
    throw new AbilityFailure('permission_denied');
  };
  constructor(
    readonly workspaceId: string,
    private readonly now: () => number = Date.now,
  ) {}
  setAuthority(
    authority: (context: InvocationContext) => Promise<AuthorizedAbility>,
  ): void {
    this.authority = authority;
  }
  private end(session: Session): void {
    if (this.current === session) this.current = undefined;
    session.connected = false;
    for (const pending of session.pending.values()) {
      pending.cleanup();
      pending.reject(new AbilityFailure('host_unavailable'));
    }
    session.pending.clear();
    const close = session.close;
    session.close = undefined;
    session.writer = undefined;
    close?.();
  }
  private live(): Session | undefined {
    if (this.current && this.now() - this.current.lastSeen >= 3000)
      this.end(this.current);
    return this.current;
  }
  session(): { id: string; workspaceId: string } | undefined {
    const session = this.live();
    return session?.connected
      ? { id: session.id, workspaceId: this.workspaceId }
      : undefined;
  }
  private emit(
    session: Session,
    command?: HostCommand,
    id?: string,
  ): Promise<void> {
    if (this.live() !== session || !session.connected || !session.writer)
      return Promise.reject(new AbilityFailure('host_unavailable'));
    const event: HostEvent = {
      sessionId: session.id,
      sequence: ++session.outgoing,
      ...(command ? { command, id } : {}),
    };
    session.sending = session.sending.then(async () => {
      if (this.live() !== session) throw new AbilityFailure('host_unavailable');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          session.writer!(event),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new AbilityFailure('host_unavailable')),
              3000,
            );
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
    void session.sending.catch(() => this.end(session));
    return session.sending;
  }
  private call(
    command: HostCommand,
    signal?: AbortSignal,
    timeout = 65_000,
  ): Promise<unknown> {
    const session = this.live();
    if (!session?.connected)
      return Promise.reject(new AbilityFailure('host_unavailable'));
    if (session.pending.size >= 128)
      return Promise.reject(new AbilityFailure('busy'));
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const pending = session.pending.get(id);
        if (!pending) return;
        pending.cleanup();
        session.pending.delete(id);
        if (command.type === 'invoke')
          void this.emit(session, {
            type: 'cancel',
            invocationId: command.request.context.invocationId,
          }).catch(() => {});
        reject(new AbilityFailure(signal?.aborted ? 'cancelled' : 'timeout'));
      };
      const timer = setTimeout(cancel, timeout);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      };
      session.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', cancel, { once: true });
      void this.emit(session, command, id).catch(() => this.end(session));
    });
  }
  async install(
    review: InstallReview,
    signal: AbortSignal,
  ): Promise<VerifiedPackage> {
    return verifiedPackageSchema.parse(
      await this.call({ type: 'install', review }, signal, 300_000),
    );
  }
  async invoke(
    request: InvocationRequest,
    signal: AbortSignal,
  ): Promise<InvocationOutcome> {
    if (request.context.sessionId !== this.session()?.id)
      throw new AbilityFailure('host_unavailable');
    const authorized = await this.authority(request.context);
    if (request.context.sessionId !== this.session()?.id)
      throw new AbilityFailure('host_unavailable');
    const result = await this.call(
      { type: 'invoke', request, ...authorized },
      signal,
    );
    const tool = authorized.binding.manifest.tools.find(
      (tool) => tool.id === request.context.tool,
    )!;
    if (tool.visibility === 'owner-only') return parseOwnerOutcome(result);
    const outcome = parseOutcome(result);
    if ('visibility' in outcome) validateValue(tool.output, outcome.value);
    return outcome;
  }
  async revoke(bindingId: string, revision: number): Promise<void> {
    await this.call({ type: 'revoke', bindingId, revision }, undefined, 6000);
  }
  async disconnect(bindingId: string): Promise<void> {
    await this.call({ type: 'disconnect', bindingId });
  }
  async eraseState(bindingId: string): Promise<void> {
    await this.call({ type: 'eraseState', bindingId });
  }
  async uninstall(digest: string): Promise<void> {
    await this.call({ type: 'uninstall', digest });
  }
  async quiesce(): Promise<void> {
    await this.call({ type: 'quiesce' }, undefined, 6000);
  }
  async resume(): Promise<void> {
    await this.call({ type: 'resume' }, undefined, 6000);
  }
  async stop(): Promise<void> {
    if (this.current) this.end(this.current);
  }

  routes(ownerToken?: string): Hono {
    const app = new Hono();
    app.use('*', bodyLimit({ maxSize: bridgeLimit }));
    app.use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      if (
        c.req.header('origin') ||
        [...c.req.raw.headers.keys()].some((key) =>
          key.startsWith('sec-fetch-'),
        )
      )
        return c.json({ error: 'permission_denied' }, 403);
      const hostname = new URL(c.req.url).hostname;
      let peer: string | undefined;
      try {
        peer = getConnInfo(c).remote.address;
      } catch {
        /* Missing socket identity is not trusted. */
      }
      if (
        !['127.0.0.1', '[::1]'].includes(hostname) ||
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '')
      )
        return c.json({ error: 'permission_denied' }, 403);
      if (
        c.req.method !== 'GET' &&
        !c.req.header('content-type')?.startsWith('application/json')
      )
        return c.json({ error: 'invalid_response' }, 415);
      await next();
    });
    app.onError((error, c) => c.json({ error: failureCode(error) }, 400));
    app.post('/pair', async (c) => {
      if (
        !ownerToken ||
        ownerToken.length < 24 ||
        !sameToken(c.req.header('authorization'), ownerToken)
      )
        return c.json({ error: 'setup_needed' }, 401);
      const body = z
        .strictObject({
          workspaceId: z.string().min(1).max(256),
          nonce: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(await c.req.json());
      if (body.workspaceId !== this.workspaceId)
        return c.json({ error: 'permission_denied' }, 409);
      if (this.current) this.end(this.current);
      const session: Session = {
        id: randomUUID(),
        token: randomBytes(32).toString('hex'),
        lastSeen: this.now(),
        incoming: 0,
        outgoing: 0,
        connected: false,
        pending: new Map(),
        sending: Promise.resolve(),
      };
      this.current = session;
      return c.json({
        sessionId: session.id,
        token: session.token,
        workspaceId: this.workspaceId,
        nonce: body.nonce,
      });
    });
    app.use('*', async (c, next) => {
      const session = this.live();
      if (!session || !sameToken(c.req.header('authorization'), session.token))
        return c.json({ error: 'host_unavailable' }, 401);
      await next();
    });
    app.get('/events', (c) => {
      const session = this.live()!;
      if (session.connected || c.req.header('last-event-id'))
        return c.json({ error: 'host_unavailable' }, 409);
      return streamSSE(c, async (stream) => {
        let finish: () => void = () => {};
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        session.close = () => {
          stream.abort();
          finish();
        };
        session.writer = (event) =>
          stream.writeSSE({ data: JSON.stringify(event) });
        session.connected = true;
        const aborted = () => {
          this.end(session);
          finish();
        };
        stream.onAbort(aborted);
        c.req.raw.signal.addEventListener('abort', aborted, { once: true });
        const timer = setInterval(() => {
          void this.emit(session).catch(() => this.end(session));
        }, 1000);
        timer.unref?.();
        try {
          await this.emit(session);
          await done;
        } finally {
          clearInterval(timer);
          c.req.raw.signal.removeEventListener('abort', aborted);
          this.end(session);
        }
      });
    });
    const postBody = async (
      request: Request,
    ): Promise<{ session: Session; body: Record<string, unknown> }> => {
      const session = this.live();
      if (
        !session ||
        !sameToken(
          request.headers.get('authorization') ?? undefined,
          session.token,
        )
      )
        throw new AbilityFailure('host_unavailable');
      const body: unknown = await request.json();
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        (body as { sequence?: unknown }).sequence !== session.incoming + 1
      )
        throw new AbilityFailure('host_unavailable');
      session.incoming++;
      session.lastSeen = this.now();
      return { session, body: body as Record<string, unknown> };
    };
    app.post('/heartbeat', async (c) => {
      try {
        const { body } = await postBody(c.req.raw);
        z.strictObject({ sequence: z.number().int().positive() }).parse(body);
        return c.json({ ok: true });
      } catch {
        return c.json({ error: 'host_unavailable' }, 401);
      }
    });
    app.post('/check', async (c) => {
      const { session, body } = await postBody(c.req.raw);
      const input = z
        .strictObject({
          sequence: z.number().int().positive(),
          context: invocationContextSchema,
        })
        .parse(body);
      if (
        input.context.sessionId !== session.id ||
        input.context.workspaceId !== this.workspaceId
      )
        throw new AbilityFailure('permission_denied');
      const authorized = await this.authority(input.context);
      if (this.live() !== session) throw new AbilityFailure('host_unavailable');
      return c.json({ ok: true, binding: authorized.binding });
    });
    app.post('/ack', async (c) => {
      const { session, body } = await postBody(c.req.raw);
      const input = z
        .strictObject({
          sequence: z.number().int().positive(),
          id: z.uuid(),
          ok: z.boolean(),
          result: z.unknown().optional(),
          code: z.string().optional(),
        })
        .parse(body);
      const pending = session.pending.get(input.id);
      if (!pending) return c.json({ ok: true }); // a cancelled/expired result has no authority
      pending.cleanup();
      session.pending.delete(input.id);
      if (input.ok) pending.resolve(input.result);
      else pending.reject(new AbilityFailure('invalid_response'));
      return c.json({ ok: true });
    });
    return app;
  }
}
