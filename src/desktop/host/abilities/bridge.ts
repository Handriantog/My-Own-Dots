import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import {
  AbilityFailure,
  bindingSchema,
  bridgeLimit,
  failureCode,
  hostEventSchema,
  loopbackBackend,
  verifiedPackageSchema,
  type HostEvent,
  type HostInvocation,
} from '../../../shared/abilities/bridge.js';
import { canonicalJson } from '../../../shared/abilities/permissions.js';
import {
  parseOutcome,
  parseOwnerOutcome,
} from '../../../shared/abilities/protocol.js';
import type {
  Binding,
  InstallReview,
  InvocationContext,
  InvocationOutcome,
  VerifiedPackage,
} from '../../../shared/abilities/types.js';

export interface DesktopAbilityHandlers {
  install(review: InstallReview, signal: AbortSignal): Promise<VerifiedPackage>;
  invoke(
    value: HostInvocation,
    signal: AbortSignal,
  ): Promise<InvocationOutcome>;
  cancel?(invocationId: string): Promise<void>;
  revoke(bindingId: string, revision: number): Promise<void>;
  disconnect(bindingId: string): Promise<void>;
  eraseState(bindingId: string): Promise<void>;
  uninstall(digest: string): Promise<void>;
  quiesce?(): Promise<void>;
  resume?(): Promise<void>;
  stop(): Promise<void>;
}
export class DesktopAbilityBridge {
  readonly url: URL;
  private token?: string;
  private sessionId?: string;
  private sequence = 0;
  private received = 0;
  private lastSeen = 0;
  private controller = new AbortController();
  private posts: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private stopping?: Promise<void>;
  private opening?: Promise<void>;
  private attached = false;
  private readonly revoked = new Map<string, number>();
  private readonly running = new Map<
    string,
    { bindingId: string; controller: AbortController }
  >();
  constructor(
    private readonly configuration: {
      url: string;
      workspaceId: string;
      ownerToken?: string;
      previousSessionId?: string;
    },
    private readonly handlers: DesktopAbilityHandlers,
    private readonly onDisconnected?: (sessionId: string) => void,
  ) {
    this.url = loopbackBackend(configuration.url);
  }
  get session(): string | undefined {
    return this.connected ? this.sessionId : undefined;
  }
  get connected(): boolean {
    return this.attached && !this.controller.signal.aborted;
  }
  private async request(
    path: string,
    token: string,
    body?: unknown,
  ): Promise<IncomingMessage> {
    const encoded =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (encoded && encoded.length > bridgeLimit)
      throw new AbilityFailure('invalid_response');
    return new Promise((resolve, reject) => {
      const url = new URL(`/ability-host/v1/${path}`, this.url);
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method: encoded ? 'POST' : 'GET',
          agent: false,
          signal: this.controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            ...(encoded
              ? {
                  'content-type': 'application/json',
                  'content-length': encoded.length,
                }
              : {}),
          },
        },
        resolve,
      );
      request.on('error', reject);
      request.setTimeout(3000, () =>
        request.destroy(new AbilityFailure('host_unavailable')),
      );
      request.end(encoded);
    });
  }
  private async json(
    path: string,
    token: string,
    body: unknown,
  ): Promise<unknown> {
    const response = await this.request(path, token, body);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > bridgeLimit) {
        response.destroy();
        throw new AbilityFailure('invalid_response');
      }
      chunks.push(chunk);
    }
    if (response.statusCode !== 200)
      throw new AbilityFailure(
        response.statusCode === 401 ? 'host_unavailable' : 'permission_denied',
      );
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const sessionId = this.sessionId;
    const next = this.posts
      .catch(() => {})
      .then(async () => {
        if (!this.connected || !this.token || this.sessionId !== sessionId)
          throw new AbilityFailure('host_unavailable');
        return this.json(path, this.token, {
          ...body,
          sequence: ++this.sequence,
        });
      });
    this.posts = next;
    return next;
  }
  async start(): Promise<void> {
    if (this.connected) return;
    if (this.opening) return this.opening;
    this.opening = this.open();
    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }
  private async open(): Promise<void> {
    if (this.stopping) await this.stopping;
    this.stopping = undefined;
    this.controller = new AbortController();
    const generation = this.controller;
    this.posts = Promise.resolve();
    this.sequence = 0;
    this.received = 0;
    this.revoked.clear();
    try {
      if (
        !this.configuration.ownerToken ||
        this.configuration.ownerToken.length < 24
      )
        throw new AbilityFailure('setup_needed');
      const nonce = randomBytes(32).toString('hex');
      const pair = z
        .strictObject({
          sessionId: z.uuid(),
          token: z.string().regex(/^[a-f0-9]{64}$/),
          workspaceId: z.literal(this.configuration.workspaceId),
          nonce: z.literal(nonce),
        })
        .parse(
          await this.json('pair', this.configuration.ownerToken, {
            workspaceId: this.configuration.workspaceId,
            nonce,
            ...(this.configuration.previousSessionId
              ? { previousSessionId: this.configuration.previousSessionId }
              : {}),
          }),
        );
      this.token = pair.token;
      this.sessionId = pair.sessionId;
      const response = await this.request('events', pair.token);
      if (
        response.statusCode !== 200 ||
        !response.headers['content-type']?.startsWith('text/event-stream')
      ) {
        response.destroy();
        throw new AbilityFailure('host_unavailable');
      }
      await new Promise<void>((resolve, reject) => {
        let ready = false;
        void this.consume(response, generation, () => {
          if (!ready) {
            ready = true;
            resolve();
          }
        })
          .then(
            () => {
              if (!ready) reject(new AbilityFailure('host_unavailable'));
            },
            () => {
              reject(new AbilityFailure('host_unavailable'));
            },
          )
          .finally(() => {
            if (this.controller === generation) void this.stop();
          });
      });
      this.timer = setInterval(() => {
        if (this.controller !== generation) return;
        if (Date.now() - this.lastSeen >= 3000) {
          void this.stop();
          return;
        }
        void this.post('heartbeat', {}).catch(() => {
          if (this.controller === generation) return this.stop();
        });
      }, 1000);
      this.timer.unref?.();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  private async consume(
    response: IncomingMessage,
    generation: AbortController,
    ready: () => void,
  ): Promise<void> {
    let buffer = Buffer.alloc(0);
    for await (const chunk of response) {
      if (this.controller !== generation || generation.signal.aborted) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > bridgeLimit)
        throw new AbilityFailure('invalid_response');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.subarray(0, boundary).toString('utf8');
        buffer = buffer.subarray(boundary + 2);
        if (!frame.startsWith('data: ') || frame.slice(6).includes('\n'))
          throw new AbilityFailure('invalid_response');
        const event = hostEventSchema.parse(JSON.parse(frame.slice(6)));
        if (
          event.sessionId !== this.sessionId ||
          event.sequence !== this.received + 1
        )
          throw new AbilityFailure('host_unavailable');
        this.received = event.sequence;
        this.lastSeen = Date.now();
        this.attached = true;
        ready();
        if (event.command)
          void this.command(event).catch(() => {
            if (this.controller === generation) return this.stop();
          });
      }
    }
  }
  async authorize(context: InvocationContext): Promise<Binding> {
    const result = z
      .strictObject({ ok: z.literal(true), binding: bindingSchema })
      .parse(await this.post('check', { context }));
    if (
      !this.connected ||
      context.sessionId !== this.sessionId ||
      context.workspaceId !== this.configuration.workspaceId ||
      context.grantRevision <= (this.revoked.get(context.bindingId) ?? 0) ||
      !result.binding.enabled ||
      result.binding.restored ||
      result.binding.id !== context.bindingId ||
      result.binding.dotId !== context.dotId ||
      result.binding.digest !== context.digest ||
      result.binding.revision !== context.grantRevision
    )
      throw new AbilityFailure('permission_denied');
    return result.binding;
  }
  private async command(event: HostEvent): Promise<void> {
    const command = event.command!;
    if (command.type === 'cancel') {
      this.running.get(command.invocationId)?.controller.abort();
      if (!event.id) {
        await this.handlers.cancel?.(command.invocationId);
        return;
      }
    }
    if (!event.id) throw new AbilityFailure('invalid_response');
    const session = this.sessionId;
    let result: unknown = null;
    try {
      if (!this.connected) throw new AbilityFailure('host_unavailable');
      switch (command.type) {
        case 'cancel':
          await this.handlers.cancel?.(command.invocationId);
          break;
        case 'quiesce':
        case 'resume':
          if (!this.handlers[command.type])
            throw new AbilityFailure('host_unavailable');
          await this.handlers[command.type]!();
          break;
        case 'install':
          result = verifiedPackageSchema.parse(
            await this.handlers.install(command.review, this.controller.signal),
          );
          break;
        case 'invoke': {
          const context = command.request.context;
          if (this.running.has(context.invocationId))
            throw new AbilityFailure('permission_denied');
          const controller = new AbortController();
          this.running.set(context.invocationId, {
            bindingId: context.bindingId,
            controller,
          });
          try {
            const binding = await this.authorize(context);
            if (
              controller.signal.aborted ||
              canonicalJson(binding) !== canonicalJson(command.binding) ||
              command.package.digest !== binding.digest ||
              canonicalJson(command.package.manifest) !==
                canonicalJson(binding.manifest) ||
              canonicalJson(command.request.settings) !==
                canonicalJson(binding.settings)
            )
              throw new AbilityFailure('permission_denied');
            const tool = binding.manifest.tools.find(
              (tool) => tool.id === context.tool,
            );
            if (!tool) throw new AbilityFailure('permission_denied');
            const outcome = await this.handlers.invoke(
              command,
              controller.signal,
            );
            result =
              tool.visibility === 'owner-only'
                ? parseOwnerOutcome(outcome)
                : parseOutcome(outcome);
          } finally {
            this.running.delete(context.invocationId);
          }
          break;
        }
        case 'revoke':
          this.revoked.set(
            command.bindingId,
            Math.max(
              command.revision,
              this.revoked.get(command.bindingId) ?? 0,
            ),
          );
          for (const value of this.running.values())
            if (value.bindingId === command.bindingId) value.controller.abort();
          await this.handlers.revoke(command.bindingId, command.revision);
          break;
        case 'disconnect':
          await this.handlers.disconnect(command.bindingId);
          break;
        case 'eraseState':
          await this.handlers.eraseState(command.bindingId);
          break;
        case 'uninstall':
          await this.handlers.uninstall(command.digest);
          break;
      }
    } catch (error) {
      if (this.connected && session === this.sessionId)
        await this.post('ack', {
          id: event.id,
          ok: false,
          code: failureCode(error),
        });
      return;
    }
    if (this.connected && session === this.sessionId)
      await this.post('ack', { id: event.id, ok: true, result });
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const wasConnected = this.connected;
    const sessionId = this.sessionId;
    this.attached = false;
    clearInterval(this.timer);
    this.controller.abort();
    this.token = undefined;
    this.sessionId = undefined;
    for (const value of this.running.values()) value.controller.abort();
    this.stopping = this.handlers.stop();
    if (wasConnected && sessionId) this.onDisconnected?.(sessionId);
    return this.stopping;
  }
}
