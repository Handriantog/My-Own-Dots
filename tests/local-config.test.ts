import { expect, it } from 'vitest';
import {
  localAiConfigFromEnv,
  setupStatus,
} from '../src/server/platform-config.js';

it('requires explicit opt-in to Codex execution and rejects incompatible providers', () => {
  expect(localAiConfigFromEnv({}).agentEngine).toBe('legacy');
  expect(localAiConfigFromEnv({ DOTS_AGENT_ENGINE: 'codex' }).agentEngine).toBe(
    'codex',
  );
  expect(() =>
    localAiConfigFromEnv({
      DOTS_AGENT_ENGINE: 'codex',
      LLM_PROVIDER: 'claude',
    }),
  ).toThrow(/Codex|codex/);
  expect(() =>
    localAiConfigFromEnv({ DOTS_AGENT_ENGINE: 'codex', LLM_BACKEND: 'openai' }),
  ).toThrow(/subscription/);
  expect(() => localAiConfigFromEnv({ DOTS_AGENT_ENGINE: 'typo' })).toThrow(
    /DOTS_AGENT_ENGINE/,
  );
});

it('defaults to local storage and subscription inference with no hosted fallback', () => {
  expect(
    localAiConfigFromEnv({
      OPENAI_API_KEY: 'old',
      CPK_INTELLIGENCE_API_KEY: 'old',
    }),
  ).toMatchObject({
    conversationBackend: 'local',
    llmBackend: 'subscription',
    llmProvider: 'codex',
  });
});

it('rejects misspelled backends instead of connecting to a cloud provider', () => {
  expect(() => localAiConfigFromEnv({ LLM_BACKEND: 'subcription' })).toThrow(
    /LLM_BACKEND/,
  );
  expect(() => localAiConfigFromEnv({ CONVERSATION_BACKEND: 'cloud' })).toThrow(
    /CONVERSATION_BACKEND/,
  );
});

it('local subscription setup requires the database, not API credentials or a model override', () => {
  const config = {
    ...localAiConfigFromEnv({
      LOCAL_DATABASE_URL: 'postgres://localhost/dots',
    }),
    baseUrl: '',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  };
  expect(setupStatus(config)).toMatchObject({
    missing: [],
    model: true,
    conversationBackend: 'local',
    llmBackend: 'subscription',
  });
  expect(
    setupStatus({ ...config, localDatabaseUrl: undefined }).missing,
  ).toEqual(['LOCAL_DATABASE_URL']);
  expect(setupStatus({ ...config, slackChannel: 'managed' }).slack).toBe(
    'requires_intelligence',
  );
});

it('supports explicit hosted compatibility configuration', () => {
  const config = {
    ...localAiConfigFromEnv({
      CONVERSATION_BACKEND: 'intelligence',
      LLM_BACKEND: 'openai',
    }),
    baseUrl: '',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  };
  expect(setupStatus(config).missing).toEqual(
    expect.arrayContaining(['OPENAI_API_KEY', 'OPENAI_MODEL']),
  );
});
