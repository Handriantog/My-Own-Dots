import type {
  Binding,
  CapabilityReply,
  CapabilityRequest,
  InvocationContext,
} from '../../../shared/abilities/types.js';
import type { AppCommand } from '../../../shared/abilities/app-control.js';
import { validAppControlVisibility } from '../../../shared/abilities/manifest.js';
import {
  capabilitySchema,
  capabilityReplySchema,
} from '../../../shared/abilities/protocol.js';
import {
  AbilityFailure,
  failureCode,
} from '../../../shared/abilities/bridge.js';
export type AppControlTransport = (
  command: AppCommand,
  signal: AbortSignal,
) => Promise<CapabilityReply>;
type Options = {
  authorize(context: InvocationContext): Promise<Binding>;
  dispatch: AppControlTransport;
};
export class AbilityAppControl {
  private pending: Promise<unknown> = Promise.resolve();
  private queued = 0;
  constructor(private readonly options: Options) {}
  async request(
    context: InvocationContext,
    input: CapabilityRequest,
    signal: AbortSignal,
  ): Promise<CapabilityReply> {
    if (this.queued >= 8) return { ok: false, code: 'busy' };
    this.queued++;
    const operation = this.pending
      .catch(() => {})
      .then(async (): Promise<CapabilityReply> => {
        let dispatched = false;
        try {
          const request = capabilitySchema.parse(input);
          if (request.kind !== 'app-control')
            throw new AbilityFailure('permission_denied');
          if (signal.aborted) throw new AbilityFailure('cancelled');
          const binding = await this.options.authorize(context);
          const permission = binding.manifest.permissions.find(
            (p) => p.id === request.ruleId,
          );
          if (
            !binding.enabled ||
            !validAppControlVisibility(binding.manifest) ||
            binding.restored ||
            binding.id !== context.bindingId ||
            binding.dotId !== context.dotId ||
            binding.digest !== context.digest ||
            binding.revision !== context.grantRevision ||
            permission?.kind !== 'app-control' ||
            !binding.grants.includes(permission.id) ||
            !permission.actions.includes(request.command.action)
          )
            throw new AbilityFailure('permission_denied');
          if (signal.aborted) throw new AbilityFailure('cancelled');
          dispatched = true;
          const result = capabilityReplySchema.parse(
            await this.options.dispatch(request.command, signal),
          );
          if (signal.aborted)
            return { ok: true, kind: 'app-control', status: 'uncertain' };
          await this.options.authorize(context);
          if (signal.aborted)
            return { ok: true, kind: 'app-control', status: 'uncertain' };
          if (result.ok && result.kind !== 'app-control')
            throw new AbilityFailure('invalid_response');
          return result;
        } catch (error) {
          return dispatched
            ? { ok: true, kind: 'app-control', status: 'uncertain' }
            : { ok: false, code: failureCode(error) };
        }
      });
    this.pending = operation;
    try {
      return await operation;
    } finally {
      this.queued--;
    }
  }
}
