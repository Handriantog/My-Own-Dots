import { expect, it } from 'vitest';
import {
  localAiConfigFromEnv,
  setupStatus,
} from '../src/server/platform-config.js';

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
