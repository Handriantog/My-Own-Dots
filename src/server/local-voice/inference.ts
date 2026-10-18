import type { DecisionStreamRequest } from '../subscription-stream.js';
import { waitForVoiceOperation } from './live.js';
import {
  createAgentSession,
  createProviderSession,
  type AgentOptions,
  type AgentSession,
} from 'myown-llm-integrator';

/** One inference-only Python runtime for one call; history stays with DotAgent. */
export class VoiceInferenceSession {
  private readonly session: AgentSession;
  constructor(private readonly callId: string) {
    this.session = createAgentSession();
  }
  async warm(signal: AbortSignal): Promise<void> {
    await this.session.warm({ signal });
  }
  readonly run = async ({
    prompt,
    schema,
    provider,
    model,
    signal,
    timeoutMs,
  }: AgentOptions) => {
    const response = await this.session.runAgent({
      prompt,
      schema,
      provider,
      model,
      signal,
      timeoutMs,
    });
    signal?.throwIfAborted();
    // Timing metadata only: no transcript, prompt, answer, tool input or token.
    console.info('[voice-inference]', {
      callId: this.callId,
      ...response.timings,
    });
    return response;
  };
  close() {
    return this.session.close();
  }
}

/** Persistent subscription provider, scoped to this call; no audio API. */
export class VoiceProviderSession {
  private readonly session = createProviderSession();
  private readonly lifetime = new AbortController();
  private signal = this.lifetime.signal;
  private recovery?: Promise<void>;
  private busy = false;
  constructor(private readonly callId: string) {}
  async warm(signal: AbortSignal): Promise<void> {
    this.signal = AbortSignal.any([signal, this.lifetime.signal]);
    await this.session.warm({ signal: this.signal });
  }
  readonly runDecision = async (options: DecisionStreamRequest) => {
    this.signal.throwIfAborted();
    options.signal?.throwIfAborted();
    if (this.busy)
      throw Error('Inference session already has a call in progress.');
    this.busy = true;
    let submitted = false;
    try {
      const recovery = this.recovery;
      if (recovery) {
        try {
          await waitForVoiceOperation(
            recovery,
            AbortSignal.any([
              this.signal,
              ...(options.signal ? [options.signal] : []),
            ]),
          );
        } catch (error) {
          // Consume a reported warmup failure. A later explicit turn may start
          // again, but a cancelled waiter leaves the shared warmup untouched.
          if (
            !this.signal.aborted &&
            !options.signal?.aborted &&
            this.recovery === recovery
          )
            this.recovery = undefined;
          throw error;
        }
        if (this.recovery === recovery) this.recovery = undefined;
      }
      this.signal.throwIfAborted();
      options.signal?.throwIfAborted();
      submitted = true;
      const response = await this.session.runDecision(options);
      options.signal?.throwIfAborted();
      console.info('[voice-inference]', {
        callId: this.callId,
        ...response.timings,
      });
      return response;
    } catch (error) {
      // Integrator has already reaped the cancelled process group. Start only
      // local readiness work now, while the owner is speaking/being transcribed.
      // A cancelled waiter must not replace a still-warming runtime.
      if (submitted && options.signal?.aborted && !this.signal.aborted)
        this.recover();
      throw error;
    } finally {
      this.busy = false;
    }
  };
  private recover() {
    if (this.recovery || this.signal.aborted) return;
    const started = performance.now();
    this.recovery = this.session.warm({ signal: this.signal }).then(
      () => {
        console.info('[voice-inference-recovery]', {
          callId: this.callId,
          outcome: 'ready',
          warmupMs: performance.now() - started,
        });
      },
      (error: unknown) => {
        console.info('[voice-inference-recovery]', {
          callId: this.callId,
          outcome: this.signal.aborted ? 'cancelled' : 'failed',
          warmupMs: performance.now() - started,
        });
        throw error;
      },
    );
    // Keep a failed recovery visible to the next explicit request; never retry
    // in the background or leak an unhandled rejection while the call is idle.
    void this.recovery.catch(() => {});
  }
  close() {
    this.lifetime.abort(Error('Voice call ended.'));
    return this.session.close();
  }
}
