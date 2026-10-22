import {
  AbilityFailure,
  invocationContextSchema,
} from '../../shared/abilities/bridge.js';
import { validateValue } from '../../shared/abilities/manifest.js';
import {
  canonicalJson,
  permissionDiff,
} from '../../shared/abilities/permissions.js';
import type {
  Binding,
  InstallReview,
  InvocationContext,
  InvocationOutcome,
  JsonValue,
} from '../../shared/abilities/types.js';
import { resolveGitHubRelease } from '../../shared/abilities/github.js';
import type { WorkspaceRepository } from '../storage/runtime-repositories.js';
import type { AbilityHostPort, AuthorizedAbility } from './host-bridge.js';

export type AbilityInvocation = {
  dotId: string;
  bindingId: string;
  threadId: string;
  tool: string;
  invocationId: string;
  arguments: Record<string, JsonValue>;
  selectionRef?: string;
  channel?: 'text' | 'voice';
};
export class AbilityService {
  private maintenance = false;
  private readonly reviews = new Map<
    string,
    { dotId: string; review: InstallReview }
  >();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly active = new Map<
    string,
    { context: InvocationContext; controller: AbortController }
  >();
  constructor(
    private readonly workspace: WorkspaceRepository,
    private readonly host: AbilityHostPort,
    private readonly options: {
      workspaceId: string;
      resolve?: typeof resolveGitHubRelease;
    },
  ) {}
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(action);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  private session() {
    if (this.maintenance) throw new AbilityFailure('busy');
    const session = this.host.session();
    if (!session || session.workspaceId !== this.options.workspaceId)
      throw new AbilityFailure('host_unavailable');
    return session;
  }
  private async binding(id: string): Promise<Binding> {
    const binding = await this.workspace.abilities.get(id);
    if (!binding) throw new AbilityFailure('permission_denied');
    return binding;
  }
  async review(dotId: string, url: string) {
    this.session();
    if (!(await this.workspace.dot(dotId)))
      throw new AbilityFailure('permission_denied');
    for (const [id, entry] of this.reviews)
      if (entry.review.expiresAt <= Date.now()) this.reviews.delete(id);
    if (this.reviews.size >= 128) throw new AbilityFailure('busy');
    const review = await (this.options.resolve ?? resolveGitHubRelease)(
      url,
      AbortSignal.timeout(30_000),
    );
    const previous = (await this.workspace.abilities.list(dotId)).find(
      (binding) =>
        binding.manifest.id === review.descriptor.manifest.id &&
        canonicalJson(binding.manifest.source) ===
          canonicalJson(review.descriptor.manifest.source),
    );
    this.reviews.set(review.id, { dotId, review });
    return {
      ...review,
      changes: previous
        ? permissionDiff(previous.manifest, review.descriptor.manifest)
        : [],
    };
  }
  private takeReview(dotId: string, reviewId: string): InstallReview {
    const entry = this.reviews.get(reviewId);
    if (!entry || entry.dotId !== dotId || entry.review.expiresAt <= Date.now())
      throw new AbilityFailure('permission_denied');
    this.reviews.delete(reviewId);
    return entry.review;
  }
  private requireNotices(review: InstallReview, accepted: string[]) {
    const notices = review.descriptor.manifest.notices ?? [];
    if (
      new Set(accepted).size !== accepted.length ||
      accepted.some((id) => !notices.some((notice) => notice.id === id)) ||
      notices.some((notice) => notice.required && !accepted.includes(notice.id))
    )
      throw new AbilityFailure('permission_denied');
  }
  async teach(
    dotId: string,
    reviewId: string,
    settings: Record<string, JsonValue> = {},
    acceptedNotices: string[] = [],
  ): Promise<Binding> {
    this.session();
    const review = this.takeReview(dotId, reviewId);
    this.requireNotices(review, acceptedNotices);
    validateValue(review.descriptor.manifest.settings, settings);
    return this.serial(`teach:${dotId}`, async () => {
      const previous = (await this.workspace.abilities.list(dotId)).find(
        (binding) =>
          binding.manifest.id === review.descriptor.manifest.id &&
          canonicalJson(binding.manifest.source) ===
            canonicalJson(review.descriptor.manifest.source),
      );
      if (previous) throw new AbilityFailure('permission_denied'); // updates use their explicit review path
      return this.serial(
        `package:${review.descriptor.asset.sha256}`,
        async () => {
          const pkg = await this.host.install(
            review,
            AbortSignal.timeout(300_000),
          );
          if (
            canonicalJson(pkg.descriptor) !== canonicalJson(review.descriptor)
          )
            throw new AbilityFailure('invalid_response');
          await this.workspace.abilities.recordPackage(pkg);
          return this.workspace.abilities.bind(
            dotId,
            pkg.digest,
            pkg.manifest.permissions.map((p) => p.id),
            settings,
          );
        },
      );
    });
  }
  async update(
    id: string,
    reviewId: string,
    settings?: Record<string, JsonValue>,
    acceptedNotices: string[] = [],
  ): Promise<Binding> {
    const original = await this.binding(id);
    const review = this.takeReview(original.dotId, reviewId);
    this.requireNotices(review, acceptedNotices);
    validateValue(
      review.descriptor.manifest.settings,
      settings ?? original.settings,
    );
    if (
      review.descriptor.manifest.id !== original.manifest.id ||
      canonicalJson(review.descriptor.manifest.source) !==
        canonicalJson(original.manifest.source)
    )
      throw new AbilityFailure('permission_denied');
    return this.serial(
      `package:${review.descriptor.asset.sha256}`,
      async () => {
        const pkg = await this.host.install(
          review,
          AbortSignal.timeout(300_000),
        );
        if (canonicalJson(pkg.descriptor) !== canonicalJson(review.descriptor))
          throw new AbilityFailure('invalid_response');
        return this.serial(`mutation:${id}`, async () => {
          const current = await this.binding(id);
          validateValue(pkg.manifest.settings, settings ?? current.settings);
          await this.revoke(current);
          return this.serial(id, async () => {
            await this.workspace.abilities.recordPackage(pkg);
            return this.workspace.abilities.bind(
              current.dotId,
              pkg.digest,
              pkg.manifest.permissions.map((p) => p.id),
              settings ?? current.settings,
            );
          });
        });
      },
    );
  }
  async enable(id: string): Promise<Binding> {
    return this.serial(`mutation:${id}`, async () =>
      this.serial(id, async () => {
        this.session();
        return this.workspace.abilities.enable(id);
      }),
    );
  }
  private async revoke(binding: Binding): Promise<Binding> {
    const next = await this.serial(binding.id, async () => {
      const next = await this.workspace.abilities.revoke(binding.id);
      for (const { context, controller } of this.active.values())
        if (context.bindingId === binding.id) controller.abort();
      return next;
    });
    // Persist revocation even if disconnected, but never acknowledge a stop we
    // cannot confirm. The desktop independently fails closed on its lease.
    await this.host.revoke(binding.id, binding.revision);
    return next;
  }
  async disable(id: string): Promise<Binding> {
    return this.serial(`mutation:${id}`, async () =>
      this.revoke(await this.binding(id)),
    );
  }
  async configure(
    id: string,
    settings: Record<string, JsonValue>,
  ): Promise<Binding> {
    return this.serial(`mutation:${id}`, async () => {
      const binding = await this.binding(id);
      validateValue(binding.manifest.settings, settings);
      await this.revoke(binding);
      return this.serial(id, async () => {
        const next = await this.workspace.abilities.configure(id, settings);
        return binding.enabled ? this.workspace.abilities.enable(id) : next;
      });
    });
  }
  async disconnect(id: string): Promise<void> {
    await this.serial(`mutation:${id}`, async () => {
      await this.revoke(await this.binding(id));
      await this.host.disconnect(id);
    });
  }
  async forget(id: string, eraseState: boolean): Promise<void> {
    await this.serial(`mutation:${id}`, async () => {
      await this.revoke(await this.binding(id));
      await this.host.disconnect(id);
      if (eraseState) await this.host.eraseState(id);
      await this.workspace.abilities.forget(id);
    });
  }
  async uninstall(digest: string): Promise<void> {
    await this.serial(`package:${digest}`, async () => {
      if (
        (await this.workspace.abilities.bindingsForDigest(digest)).length ||
        !(await this.workspace.abilities.package(digest))
      )
        throw new AbilityFailure('permission_denied');
      await this.host.uninstall(digest);
      await this.workspace.abilities.removePackage(digest);
    });
  }
  async get(id: string): Promise<Binding> {
    return this.binding(id);
  }
  async list(dotId: string) {
    return this.workspace.abilities.list(dotId);
  }
  async tools(dotId: string, channel: 'text' | 'voice' = 'text') {
    if (!this.host.session()) return [];
    await this.cleanup();
    return (await this.workspace.abilities.list(dotId))
      .filter((binding) => binding.enabled && !binding.restored)
      .flatMap((binding) =>
        binding.manifest.tools
          .filter((tool) => !tool.channels || tool.channels.includes(channel))
          .map((tool) => ({
            bindingId: binding.id,
            source: binding.manifest.source,
            abilityId: binding.manifest.id,
            tool,
          })),
      );
  }
  async authorize(context: InvocationContext): Promise<AuthorizedAbility> {
    return this.serial(context.bindingId, async () => {
      const active = this.active.get(context.invocationId);
      if (
        !active ||
        active.controller.signal.aborted ||
        canonicalJson(active.context) !== canonicalJson(context) ||
        context.workspaceId !== this.options.workspaceId ||
        context.sessionId !== this.session().id
      )
        throw new AbilityFailure('permission_denied');
      const binding = await this.binding(context.bindingId);
      const thread = await this.workspace.requireThread(context.threadId);
      if (
        !binding.enabled ||
        binding.restored ||
        binding.dotId !== context.dotId ||
        thread.dotId !== context.dotId ||
        binding.digest !== context.digest ||
        binding.revision !== context.grantRevision ||
        !binding.manifest.tools.some(
          (tool) =>
            tool.id === context.tool &&
            (!tool.channels ||
              tool.channels.includes(context.channel ?? 'text')),
        )
      )
        throw new AbilityFailure('permission_denied');
      const pkg = await this.workspace.abilities.package(binding.digest);
      if (!pkg) throw new AbilityFailure('permission_denied');
      return { binding, package: pkg };
    });
  }
  async invoke(
    input: AbilityInvocation,
    signal: AbortSignal,
  ): Promise<InvocationOutcome> {
    try {
      await this.cleanup();
      const admitted = await this.serial(input.bindingId, async () => {
        signal.throwIfAborted();
        const session = this.session(),
          binding = await this.binding(input.bindingId);
        if (
          !binding.enabled ||
          binding.restored ||
          binding.dotId !== input.dotId
        )
          throw new AbilityFailure('permission_denied');
        const tool = binding.manifest.tools.find(
          (tool) => tool.id === input.tool,
        );
        if (
          !tool ||
          (tool.channels && !tool.channels.includes(input.channel ?? 'text'))
        )
          throw new AbilityFailure('permission_denied');
        validateValue(tool.input, input.arguments);
        const context = invocationContextSchema.parse({
          workspaceId: this.options.workspaceId,
          sessionId: session.id,
          dotId: input.dotId,
          bindingId: binding.id,
          digest: binding.digest,
          grantRevision: binding.revision,
          invocationId: input.invocationId,
          tool: input.tool,
          threadId: input.threadId,
          ...(input.channel ? { channel: input.channel } : {}),
        });
        if (!(await this.workspace.abilities.claimInvocation(context)))
          throw new AbilityFailure('permission_denied');
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) controller.abort();
        this.active.set(context.invocationId, { context, controller });
        const pending = this.host
          .invoke(
            {
              context,
              arguments: input.arguments,
              settings: binding.settings,
              ...(input.selectionRef
                ? { selectionRef: input.selectionRef }
                : {}),
            },
            controller.signal,
          )
          .catch((): InvocationOutcome => ({ status: 'uncertain' }));
        return {
          pending,
          context,
          cleanup: () => signal.removeEventListener('abort', abort),
        };
      });
      try {
        let outcome = await admitted.pending;
        if (
          this.active.get(input.invocationId)?.controller.signal.aborted ||
          this.host.session()?.id !== admitted.context.sessionId
        )
          outcome = { status: 'uncertain' };
        await this.workspace.abilities.settleInvocation(
          input.invocationId,
          outcome,
        );
        return outcome;
      } finally {
        admitted.cleanup();
        this.active.delete(input.invocationId);
      }
    } catch (error) {
      return {
        status: 'error',
        code: signal.aborted
          ? 'cancelled'
          : error instanceof AbilityFailure
            ? error.code
            : 'permission_denied',
      };
    }
  }
  async cleanup(): Promise<void> {
    this.session();
    return this.serial('cleanup', async () => {
      for (const id of await this.workspace.abilities.pendingCleanup()) {
        this.session();
        await this.host.eraseState(id);
        await this.workspace.abilities.completeCleanup(id);
      }
    });
  }
  async quiesce(): Promise<() => Promise<void>> {
    if (this.maintenance) throw new AbilityFailure('busy');
    this.maintenance = true;
    for (const entry of this.active.values()) entry.controller.abort();
    let paused = false;
    try {
      if (this.host.session()) {
        if (!this.host.quiesce || !this.host.resume)
          throw new AbilityFailure('host_unavailable');
        await this.host.quiesce();
        paused = true;
      } else if ((await this.workspace.abilities.packages()).length)
        throw new AbilityFailure('host_unavailable');
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          if (paused) await this.host.resume!();
        } finally {
          this.maintenance = false;
        }
      };
    } catch (error) {
      this.maintenance = false;
      throw error;
    }
  }
  async stop(): Promise<void> {
    for (const entry of this.active.values()) entry.controller.abort();
    this.reviews.clear();
    await this.host.stop();
  }
}
