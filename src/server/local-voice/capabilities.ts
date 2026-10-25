import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PlatformConfig } from '../platform-config.js';

const require = createRequire(import.meta.url);
const integrator = require('myown-llm-integrator/package.json') as {
  name: string;
  version: string;
};
const compatibleAdapter = JSON.parse(
  readFileSync(
    new URL('../../package.json', import.meta.resolve('@tanstack/ai-openai')),
    'utf8',
  ),
) as { name: string; version: string };

type ModelConfig = Pick<
  PlatformConfig,
  'llmBackend' | 'llmProvider' | 'subscriptionModel' | 'model' | 'agentEngine'
> & { baseUrl?: string };

/** Describes this application's current seams, not a live-provider benchmark. */
export function voiceModelCapabilities(config: ModelConfig) {
  const subscription = config.llmBackend === 'subscription';
  const execution = subscription && config.agentEngine === 'codex';
  let loopbackEndpoint = false;
  try {
    const url = new URL(config.baseUrl ?? 'https://api.openai.com/v1');
    loopbackEndpoint =
      ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    // Invalid deployment configuration is never evidence of local inference.
  }
  return {
    contractVersion: 1,
    provider: subscription
      ? (config.llmProvider ?? 'codex')
      : 'openai-compatible',
    model: subscription
      ? (config.subscriptionModel ?? null)
      : (config.model ?? null),
    adapter: subscription
      ? { name: 'dots-subscription', version: null, contractRevision: 1 }
      : { name: compatibleAdapter.name, version: compatibleAdapter.version },
    integrator: subscription
      ? { name: integrator.name, version: integrator.version }
      : null,
    execution: {
      backend: subscription ? 'subscription' : 'openai-compatible',
      location: execution
        ? 'local-codex-engine-remote-reasoning'
        : subscription
          ? 'provider-hosted'
          : 'unverified',
      loopbackEndpoint: subscription ? false : loopbackEndpoint,
      localParityVerified: false,
    },
    text: {
      adapter: execution
        ? 'codex-execution-events'
        : subscription
          ? 'buffered-complete-step'
          : 'provider-dependent-unverified',
      headless: 'buffered-final-turn',
      incrementalSpeech: false,
    },
    cancellation: {
      supported: true,
      mechanism: subscription
        ? 'abort-signal-and-process-group'
        : 'abort-signal',
      headless: 'scoped-stop-request',
      acknowledgement: execution ? 'confirmed-or-uncertain' : 'not-exposed',
      measuredLatencyMs: null,
    },
    tools: {
      decisionValidation: subscription
        ? 'complete-envelope'
        : 'provider-dependent',
      argumentValidation: 'application-executor',
      execution: 'existing-dot-runtime',
      headlessApprovalTools: execution,
    },
    timings: {
      available: subscription
        ? ['request-start', 'validated-step-text', 'completed-headless-turn']
        : ['request-start', 'completed-headless-turn'],
      providerFirstByte: 'not-exposed',
      physicalAudio: 'not-measured',
    },
    liveVerified: false,
  } as const;
}
