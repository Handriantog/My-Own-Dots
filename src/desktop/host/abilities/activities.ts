import { AbilityFailure } from '../../../shared/abilities/bridge.js';
import type { ActivityDriver } from '../../../shared/abilities/activity.js';
import type {
  Binding,
  CapabilityReply,
  CapabilityRequest,
  InvocationContext,
} from '../../../shared/abilities/types.js';
type Lease = {
  context: InvocationContext;
  activityId: string;
  driver: ActivityDriver;
  starting: Promise<void>;
  committed: boolean;
  retired: boolean;
  cleanup(): void;
  stopping?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
};
/** One desktop owner. Worker starts stay provisional until validated completion. */
export class AbilityActivities {
  private lease?: Lease;
  constructor(
    private readonly options: {
      driver(): ActivityDriver | undefined;
      authorize(context: InvocationContext): Promise<Binding>;
      renew(context: InvocationContext, signal: AbortSignal): Promise<Binding>;
    },
  ) {}
  async request(
    context: InvocationContext,
    request: Extract<CapabilityRequest, { kind: 'companion-activity' }>,
    signal: AbortSignal,
  ): Promise<CapabilityReply> {
    const binding = await this.options.authorize(context);
    signal.throwIfAborted();
    const rule = binding.manifest.permissions.find(
      (p) => p.id === request.ruleId && p.kind === 'companion-activity',
    );
    const definition = binding.manifest.activities?.find(
      (a) => a.id === request.command.activityId,
    );
    if (
      !context.interactive ||
      !rule ||
      rule.kind !== 'companion-activity' ||
      !binding.grants.includes(rule.id) ||
      !rule.activities.includes(request.command.activityId) ||
      !definition ||
      (definition.pointer && !rule.pointer) ||
      (definition.keepAwake &&
        rule.keepAwake !== definition.keepAwake &&
        rule.keepAwake !== 'display')
    )
      throw new AbilityFailure('permission_denied');
    let current = this.lease;
    if (
      current?.committed &&
      current.driver.status(current.context.bindingId) === 'inactive'
    ) {
      await this.retire(current);
      await this.options.authorize(context);
      signal.throwIfAborted();
      current = this.lease;
    }
    if (request.command.action === 'stop') {
      if (
        current?.context.bindingId === context.bindingId &&
        current.activityId === definition.id
      )
        await this.retire(current);
    } else if (request.command.action === 'start') {
      if (current) {
        if (
          current.retired ||
          current.context.bindingId !== context.bindingId ||
          current.activityId !== definition.id
        )
          throw new AbilityFailure('busy');
      } else {
        const driver = this.options.driver();
        if (!driver) throw new AbilityFailure('host_unavailable');
        const lease: Lease = {
          context,
          activityId: definition.id,
          driver,
          committed: false,
          retired: false,
          starting: Promise.resolve(),
          cleanup: () => signal.removeEventListener('abort', abort),
        };
        const abort = () => {
          void this.retire(lease).catch(() => {});
        };
        this.lease = lease;
        // Install ownership before invoking a possibly asynchronous driver.
        lease.starting = Promise.resolve().then(() =>
          driver.start(
            { bindingId: context.bindingId, dotId: context.dotId },
            definition,
          ),
        );
        signal.addEventListener('abort', abort, { once: true });
        try {
          await lease.starting;
          if (signal.aborted || lease.retired)
            throw new AbilityFailure('cancelled');
          await this.options.authorize(context);
          if (signal.aborted || lease.retired)
            throw new AbilityFailure('cancelled');
        } catch (error) {
          await this.retire(lease);
          throw error;
        }
      }
    }
    return {
      ok: true,
      kind: 'companion-activity',
      status:
        this.lease?.context.bindingId === context.bindingId &&
        this.lease.activityId === definition.id
          ? this.lease.driver.status(context.bindingId)
          : 'inactive',
    };
  }
  async finish(invocationId: string, success: boolean): Promise<void> {
    const lease = this.lease;
    if (!lease || lease.context.invocationId !== invocationId) return;
    if (!success || lease.retired) {
      await this.retire(lease);
      return;
    }
    lease.committed = true;
    lease.cleanup();
    let checking = false;
    lease.timer = setInterval(() => {
      if (checking || lease.retired) return;
      checking = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      timer.unref?.();
      const expired = new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => reject(new AbilityFailure('timeout')),
          { once: true },
        ),
      );
      void Promise.race([
        this.options.renew(lease.context, controller.signal),
        expired,
      ])
        .then(() => {
          if (lease.driver.status(lease.context.bindingId) === 'inactive')
            return this.retire(lease);
        })
        .catch(() => this.retire(lease))
        .catch(() => {})
        .finally(() => {
          clearTimeout(timer);
          checking = false;
        });
    }, 500);
    lease.timer.unref?.();
  }
  private retire(lease: Lease): Promise<void> {
    if (lease.stopping) return lease.stopping;
    lease.retired = true;
    lease.cleanup();
    clearInterval(lease.timer);
    // Stop immediately, then await activation and retire any late native setup.
    lease.stopping = (async () => {
      await lease.driver.stop(lease.context.bindingId);
      await lease.starting.catch(() => {});
      await lease.driver.stop(lease.context.bindingId);
      if (this.lease === lease) this.lease = undefined;
    })();
    return lease.stopping;
  }
  async cancel(invocationId: string): Promise<void> {
    if (this.lease?.context.invocationId === invocationId)
      await this.retire(this.lease);
  }
  async stop(bindingId?: string): Promise<void> {
    if (
      this.lease &&
      (!bindingId || this.lease.context.bindingId === bindingId)
    )
      await this.retire(this.lease);
  }
  async uninstall(digest: string): Promise<void> {
    if (this.lease?.context.digest === digest) await this.retire(this.lease);
  }
}
