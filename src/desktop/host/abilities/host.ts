import { createHash } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  AbilityFailure,
  failureCode,
  hostCommandSchema,
  type HostInvocation,
} from '../../../shared/abilities/bridge.js';
import {
  abilityLimits,
  assertBoundedJson,
} from '../../../shared/abilities/limits.js';
import { validateValue } from '../../../shared/abilities/manifest.js';
import { canonicalJson } from '../../../shared/abilities/permissions.js';
import {
  capabilitySchema,
  parseOutcome,
  workerResultSchema,
} from '../../../shared/abilities/protocol.js';
import type {
  Binding,
  CapabilityReply,
  CapabilityRequest,
  InstallReview,
  InvocationContext,
  InvocationOutcome,
  VerifiedPackage,
} from '../../../shared/abilities/types.js';
import type { ProtectedStorage } from '../backup-keys.js';
import type { DesktopAbilityHandlers } from './bridge.js';
import { AbilityCredentials } from './credentials.js';
import { AbilityHttp } from './http.js';
import { AbilityInstaller } from './installer.js';
import { AbilityOAuth } from './oauth.js';
import { DirectoryAnchor } from './package.js';
import { OwnerResultStore } from './results.js';
import {
  AbilitySupervisor,
  type AbilitySupervisorOptions,
} from './supervisor.js';

type Options = {
  workspaceId: string;
  packageRoot: string;
  stateRoot: string;
  controlRoot: string;
  credentialRoot: string;
  launcher: string;
  runtimes: AbilitySupervisorOptions['runtimes'];
  storage: ProtectedStorage;
  session(): string | undefined;
  binding(id: string): Promise<Binding>;
  authorize(context: InvocationContext): Promise<Binding>;
  open(url: string): Promise<void>;
  http?: Pick<AbilityHttp, 'request'>;
  installer?: Pick<AbilityInstaller, 'prepare'>;
};
export class AbilityHost implements DesktopAbilityHandlers {
  readonly accounts: AbilityOAuth;
  private readonly results = new OwnerResultStore();
  private readonly supervisor: AbilitySupervisor;
  private readonly installer: Pick<AbilityInstaller, 'prepare'>;
  private readonly http: Pick<AbilityHttp, 'request'>;
  private readonly revoked = new Map<string, number>();
  private readonly active = new Map<
    string,
    { command: HostInvocation; controller: AbortController }
  >();
  private stopped = false;
  private maintenance = 0;
  private stopping?: Promise<void>;
  constructor(private readonly options: Options) {
    this.installer =
      options.installer ?? new AbilityInstaller(options.packageRoot);
    const credentials = new AbilityCredentials({
      root: options.credentialRoot,
      storage: options.storage,
      platform: process.platform,
    });
    this.accounts = new AbilityOAuth({
      workspaceId: options.workspaceId,
      credentials,
      session: options.session,
      binding: options.binding,
      authorize: (context) => this.authorize(context),
      open: options.open,
      clearResults: (id) => this.results.clearBinding(id),
    });
    this.http =
      options.http ??
      new AbilityHttp({
        authorize: (context) => this.authorize(context),
        credential: (context, rule, signal, rejectedToken) =>
          this.accounts.authorize(context, rule, signal, rejectedToken),
      });
    this.supervisor = new AbilitySupervisor({
      launcher: options.launcher,
      runtimes: options.runtimes,
      controlRoot: options.controlRoot,
      resolve: async (context) => {
        const binding = await this.authorize(context),
          command = this.active.get(context.invocationId)?.command;
        if (
          !command ||
          canonicalJson(binding) !== canonicalJson(command.binding)
        )
          throw new AbilityFailure('permission_denied');
        await this.directory(options.controlRoot);
        await this.directory(options.stateRoot);
        const stateRoot = this.statePath(context.bindingId);
        await this.directory(stateRoot);
        await this.directory(join(stateRoot, 'tmp'));
        return {
          binding,
          package: {
            ...command.package,
            root: join(options.packageRoot, 'packages', command.package.digest),
          },
          stateRoot,
        };
      },
      capability: (context, request, signal) =>
        this.capability(context, request, signal),
    });
  }
  private statePath(bindingId: string): string {
    z.uuid().parse(bindingId);
    return join(
      this.options.stateRoot,
      createHash('sha256')
        .update(canonicalJson([this.options.workspaceId, bindingId]))
        .digest('hex'),
    );
  }
  private async directory(path: string): Promise<void> {
    if ((await realpath(dirname(path))) !== dirname(path))
      throw new AbilityFailure('permission_denied');
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await DirectoryAnchor.capture(path);
  }
  private live(context: InvocationContext, binding: Binding): boolean {
    return (
      !this.stopped &&
      this.maintenance === 0 &&
      !!this.options.session() &&
      context.workspaceId === this.options.workspaceId &&
      context.sessionId === this.options.session() &&
      binding.enabled &&
      !binding.restored &&
      binding.id === context.bindingId &&
      binding.dotId === context.dotId &&
      binding.digest === context.digest &&
      binding.revision === context.grantRevision &&
      context.grantRevision > (this.revoked.get(binding.id) ?? 0) &&
      binding.manifest.tools.some(
        (tool) =>
          tool.id === context.tool &&
          (!tool.channels || tool.channels.includes(context.channel ?? 'text')),
      )
    );
  }
  private async authorize(context: InvocationContext): Promise<Binding> {
    const entry = this.active.get(context.invocationId);
    if (
      !entry ||
      entry.controller.signal.aborted ||
      canonicalJson(entry.command.request.context) !== canonicalJson(context)
    )
      throw new AbilityFailure('permission_denied');
    const binding = await this.options.authorize(context);
    if (!this.live(context, binding) || entry.controller.signal.aborted)
      throw new AbilityFailure('permission_denied');
    return binding;
  }
  private async capability(
    context: InvocationContext,
    input: CapabilityRequest,
    signal: AbortSignal,
  ): Promise<CapabilityReply> {
    try {
      assertBoundedJson(input, abilityLimits.frameBytes);
      const request = capabilitySchema.parse(input);
      const binding = await this.authorize(context);
      signal.throwIfAborted();
      if (request.kind === 'https')
        return await this.http.request(context, request, signal);
      if (request.kind === 'account') {
        if (
          !binding.manifest.permissions.some(
            (p) =>
              p.kind === 'oauth' &&
              p.id === request.accountId &&
              binding.grants.includes(p.id),
          )
        )
          throw new AbilityFailure('permission_denied');
        const presence = await this.accounts.presence(
          binding.id,
          request.accountId,
        );
        await this.authorize(context);
        signal.throwIfAborted();
        return { ok: true, kind: 'account', ...presence };
      }
      throw new AbilityFailure('permission_denied'); // Helpers are owned by the supervisor.
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    }
  }
  async install(
    review: InstallReview,
    signal: AbortSignal,
  ): Promise<VerifiedPackage> {
    if (this.stopped || !this.options.session())
      throw new AbilityFailure('host_unavailable');
    return this.installer.prepare(review, signal);
  }
  async invoke(
    input: HostInvocation,
    signal: AbortSignal,
  ): Promise<InvocationOutcome> {
    let id: string | undefined;
    let authorityTimer: ReturnType<typeof setInterval> | undefined;
    const controller = new AbortController(),
      abort = () => controller.abort();
    try {
      assertBoundedJson(input, 32 * 1024 * 1024);
      const command = hostCommandSchema.parse(input);
      if (command.type !== 'invoke')
        throw new AbilityFailure('permission_denied');
      const context = command.request.context;
      if (this.active.has(context.invocationId))
        throw new AbilityFailure('busy');
      id = context.invocationId;
      this.active.set(id, { command, controller });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const binding = await this.authorize(context);
      if (
        canonicalJson(binding) !== canonicalJson(command.binding) ||
        command.package.digest !== binding.digest ||
        canonicalJson(command.package.manifest) !==
          canonicalJson(binding.manifest) ||
        canonicalJson(command.package.descriptor.manifest) !==
          canonicalJson(binding.manifest) ||
        canonicalJson(command.request.settings) !==
          canonicalJson(binding.settings)
      )
        throw new AbilityFailure('permission_denied');
      const tool = binding.manifest.tools.find(
        (tool) => tool.id === context.tool,
      );
      if (!tool) throw new AbilityFailure('permission_denied');
      validateValue(tool.input, command.request.arguments);
      const selection = command.request.selectionRef
        ? this.results.take(context, command.request.selectionRef)
        : undefined;
      if (command.request.selectionRef && !selection)
        throw new AbilityFailure('permission_denied');
      let checking = false;
      authorityTimer = setInterval(() => {
        if (checking || controller.signal.aborted) return;
        checking = true;
        void this.authorize(context)
          .catch(abort)
          .finally(() => {
            checking = false;
          });
      }, 500);
      authorityTimer.unref?.();
      const raw = await this.supervisor.invoke(
        { ...command.request, ...(selection ? { selection } : {}) },
        controller.signal,
      );
      if (controller.signal.aborted) return { status: 'uncertain' };
      try {
        await this.authorize(context);
      } catch {
        return { status: 'uncertain' };
      }
      assertBoundedJson(raw, abilityLimits.frameBytes);
      const result = workerResultSchema.parse(raw);
      if (tool.visibility === 'model-visible' && result.status === 'success') {
        validateValue(tool.output, result.value);
        return parseOutcome({
          status: 'success',
          visibility: 'model-visible',
          value: result.value,
        });
      }
      // Construct a new envelope. No worker text, value, URL, identity or provider error is spread into it.
      const resultRef = result.owner
        ? this.results.put(context, result.owner)
        : undefined;
      if (result.status === 'selection_needed') {
        if (!resultRef) throw new AbilityFailure('invalid_response');
        return { status: 'selection_needed', resultRef };
      }
      return parseOutcome({
        status: result.status,
        ...(result.status === 'error' ? { code: result.code } : {}),
        ...(resultRef ? { resultRef } : {}),
      });
    } catch (error) {
      return controller.signal.aborted
        ? { status: 'uncertain' }
        : { status: 'error', code: failureCode(error) };
    } finally {
      if (authorityTimer) clearInterval(authorityTimer);
      signal.removeEventListener('abort', abort);
      if (id) this.active.delete(id);
    }
  }
  async recentResults(dotId: string, threadId: string): Promise<string[]> {
    const handles = this.results.recent(dotId, threadId),
      valid: string[] = [];
    for (const handle of handles)
      if (await this.readResult(dotId, handle)) valid.push(handle);
    return valid;
  }
  running(bindingId: string): boolean {
    const status = this.supervisor.status(bindingId);
    return status.active || status.queued > 0;
  }
  async readResult(dotId: string, handle: string) {
    const context = this.results.context(dotId, handle);
    if (!context) return;
    try {
      const binding = await this.options.binding(context.bindingId);
      if (!this.live(context, binding)) {
        this.results.clearBinding(context.bindingId);
        return;
      }
      return this.results.read(dotId, handle);
    } catch {
      this.results.clearBinding(context.bindingId);
      return;
    }
  }
  async select(dotId: string, handle: string, itemId: string): Promise<string> {
    if (!(await this.readResult(dotId, handle)))
      throw new AbilityFailure('permission_denied');
    return this.results.select(dotId, handle, itemId);
  }
  async revoke(bindingId: string, revision: number): Promise<void> {
    this.revoked.set(
      bindingId,
      Math.max(revision, this.revoked.get(bindingId) ?? 0),
    );
    for (const entry of this.active.values())
      if (entry.command.binding.id === bindingId) entry.controller.abort();
    this.results.clearBinding(bindingId);
    await Promise.all([
      this.supervisor.stopBinding(bindingId),
      this.accounts.cancelBinding(bindingId),
    ]);
  }
  async disconnect(bindingId: string): Promise<void> {
    for (const entry of this.active.values())
      if (entry.command.binding.id === bindingId) entry.controller.abort();
    this.results.clearBinding(bindingId);
    await Promise.all([
      this.supervisor.stopBinding(bindingId),
      this.accounts.disconnect(bindingId),
    ]);
  }
  async eraseState(bindingId: string): Promise<void> {
    await this.disconnect(bindingId);
    const root = await DirectoryAnchor.capture(this.options.stateRoot).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    if (!root) return;
    await root.check();
    await rm(this.statePath(bindingId), { recursive: true, force: true });
  }
  async uninstall(digest: string): Promise<void> {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(digest);
    if (
      [...this.active.values()].some(
        (entry) => entry.command.package.digest === digest,
      )
    )
      throw new AbilityFailure('busy');
    const root = await DirectoryAnchor.capture(
      join(this.options.packageRoot, 'packages'),
    );
    await root.check();
    await rm(join(root.path, digest), { recursive: true, force: true });
  }
  async quiesce(): Promise<void> {
    this.maintenance++;
    this.results.clear();
    const ids = new Set<string>();
    for (const entry of this.active.values()) {
      ids.add(entry.command.binding.id);
      entry.controller.abort();
    }
    await Promise.all([...ids].map((id) => this.supervisor.stopBinding(id)));
  }
  async resume(): Promise<void> {
    this.maintenance = Math.max(0, this.maintenance - 1);
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.results.clear();
    for (const entry of this.active.values()) entry.controller.abort();
    this.stopping = Promise.all([
      this.supervisor.stopAll(),
      this.accounts.stop(),
    ]).then(() => {});
    return this.stopping;
  }
}
