import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { voiceModelCapabilities } from '../src/server/local-voice/capabilities.js';

it('reports subscription buffering without claiming incremental speech or headless approval support', () => {
  const capabilities = voiceModelCapabilities({
    llmBackend: 'subscription',
    llmProvider: 'codex',
    subscriptionModel: 'chosen-model',
  });
  expect(capabilities).toMatchObject({
    provider: 'codex',
    model: 'chosen-model',
    integrator: { name: 'myown-llm-integrator', version: '0.3.0-rc.1' },
    execution: { backend: 'subscription', location: 'provider-hosted' },
    text: {
      adapter: 'buffered-complete-step',
      headless: 'buffered-final-turn',
      incrementalSpeech: false,
    },
    cancellation: { supported: true, acknowledgement: 'not-exposed' },
    tools: { headlessApprovalTools: false },
    liveVerified: false,
  });
});

it('does not mistake a loopback-compatible endpoint for verified local reasoning or streaming', () => {
  const capabilities = voiceModelCapabilities({
    llmBackend: 'openai',
    model: 'local-candidate',
    baseUrl: 'http://127.0.0.1:1234/v1',
  });
  expect(capabilities).toMatchObject({
    provider: 'openai-compatible',
    model: 'local-candidate',
    integrator: null,
    adapter: { name: '@tanstack/ai-openai', version: expect.any(String) },
    execution: {
      backend: 'openai-compatible',
      location: 'unverified',
      loopbackEndpoint: true,
      localParityVerified: false,
    },
    text: {
      adapter: 'provider-dependent-unverified',
      headless: 'buffered-final-turn',
      incrementalSpeech: false,
    },
  });
  expect(
    voiceModelCapabilities({
      llmBackend: 'openai',
      baseUrl: 'https://127.0.0.1.attacker.invalid/v1',
    }).execution.loopbackEndpoint,
  ).toBe(false);
});

it.skipIf(
  !existsSync('node_modules/myown-llm-integrator/python/.venv/bin/python'),
)(
  'probes the installed integrator with fragmented fixture output, validation failure and process cancellation',
  async () => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'scripts/check-voice-capabilities.mjs'],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(stdout);
    expect(stderr).toBe('');
    expect(report).toMatchObject({
      mode: 'fixture-only',
      integratorVersion: '0.3.0-rc.1',
      liveProviderInvoked: false,
      valid: {
        textBeforeSuffix: 0,
        textBeforeExit: 0,
        textEvents: 1,
        result:
          'Offline provider completed with 1 context messages. Saved note context: absent.',
      },
      invalid: { textEvents: 0, errorEvents: 1 },
      cancellation: { textEvents: 0, providerStopped: true },
      recovered: { textEvents: 1 },
    });
    expect(
      report.valid.timingsMs.firstFixtureFragmentObserved,
    ).toBeGreaterThanOrEqual(0);
    expect(report.valid.timingsMs.firstValidatedText).toBeGreaterThanOrEqual(
      report.valid.timingsMs.completeFixtureOutputObserved,
    );
    expect(report.limitations).toContain(
      'Fixture timings are not live-provider or audible latency.',
    );
  },
  35000,
);

it('identifies Codex execution and confirmed-or-uncertain cancellation separately from legacy inference', () => {
  expect(
    voiceModelCapabilities({
      llmBackend: 'subscription',
      llmProvider: 'codex',
      agentEngine: 'codex',
    }),
  ).toMatchObject({
    execution: { location: 'local-codex-engine-remote-reasoning' },
    text: { adapter: 'codex-execution-events' },
    cancellation: { acknowledgement: 'confirmed-or-uncertain' },
    tools: { headlessApprovalTools: true },
  });
});
