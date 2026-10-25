import type { WebConfig } from './parallel.js';
import { memoryDefaults } from './memory-config.js';
import type { SetupStatus } from '../shared/types.js';

// `copilotkit project select` writes the CLI name and deletes the template name.
const INTELLIGENCE_API_KEY_ENV_NAMES = [
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
] as const;
export const INTELLIGENCE_KEY_MISSING_LABEL = `${INTELLIGENCE_API_KEY_ENV_NAMES[1]} (or ${INTELLIGENCE_API_KEY_ENV_NAMES[0]})`;
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 90_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface LocalAiConfig {
  agentEngine?: 'legacy' | 'codex';
  conversationBackend?: 'local' | 'intelligence';
  localDatabaseUrl?: string;
  storageEngine?: 'legacy-postgres' | 'sqlite';
  llmBackend?: 'subscription' | 'openai';
  llmProvider?: string;
  subscriptionModel?: string;
  memoryInputTokenLimit?: number;
  memoryPinnedTokenLimit?: number;
}

// Select backends explicitly. Old credentials must never trigger a cloud fallback.
export function localAiConfigFromEnv(
  env: Record<string, string | undefined>,
): LocalAiConfig {
  const conversationBackend = env.CONVERSATION_BACKEND?.trim() || 'local';
  const llmBackend = env.LLM_BACKEND?.trim() || 'subscription';
  if (!['local', 'intelligence'].includes(conversationBackend))
    throw new Error('CONVERSATION_BACKEND must be local or intelligence.');
  if (!['subscription', 'openai'].includes(llmBackend))
    throw new Error('LLM_BACKEND must be subscription or openai.');
  const agentEngine = env.DOTS_AGENT_ENGINE?.trim() || 'legacy';
  if (!['legacy', 'codex'].includes(agentEngine))
    throw new Error('DOTS_AGENT_ENGINE must be legacy or codex.');
  if (
    agentEngine === 'codex' &&
    (llmBackend !== 'subscription' ||
      (env.LLM_PROVIDER?.trim() || 'codex') !== 'codex')
  )
    throw new Error(
      'Codex execution requires the Codex subscription provider.',
    );
  return {
    agentEngine: agentEngine as 'legacy' | 'codex',
    conversationBackend: conversationBackend as 'local' | 'intelligence',
    llmBackend: llmBackend as 'subscription' | 'openai',
    localDatabaseUrl: env.LOCAL_DATABASE_URL?.trim() || undefined,
    llmProvider: env.LLM_PROVIDER?.trim() || 'codex',
    subscriptionModel: env.LLM_MODEL?.trim() || undefined,
    memoryInputTokenLimit: memoryLimit(
      env.MEMORY_INPUT_TOKEN_LIMIT,
      memoryDefaults.inputTokenLimit,
    ),
    memoryPinnedTokenLimit: memoryLimit(
      env.MEMORY_PINNED_TOKEN_LIMIT,
      memoryDefaults.pinnedTokenLimit,
    ),
  };
}

function memoryLimit(raw: string | undefined, fallback: number): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_000_000)
    throw new Error(
      'Memory token limits must be positive integers no greater than 2000000.',
    );
  return value;
}

export function modelConfigured(
  config: LocalAiConfig & { apiKey?: string; model?: string },
): boolean {
  return (
    config.llmBackend === 'subscription' || !!(config.apiKey && config.model)
  );
}

export function intelligenceApiKeyFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, INTELLIGENCE_API_KEY_ENV_NAMES);
}

export function intelligenceWsUrlFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, [
    'INTELLIGENCE_GATEWAY_WS_URL',
    'INTELLIGENCE_WS_URL',
  ]);
}

export function agentRunTimeoutMsFromEnv(
  env: Record<string, string | undefined>,
): number {
  const raw = env.AGENT_RUN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_AGENT_RUN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS)
    throw new Error(
      `AGENT_RUN_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMER_DELAY_MS}.`,
    );
  return value;
}

function firstNonEmptyEnvValue(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export interface PlatformConfig extends WebConfig, LocalAiConfig {
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  agentRunTimeoutMs?: number;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  composioApiKey?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
  ownerToken?: string;
  workspaceId?: string;
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const missing = [
    config.conversationBackend === 'local'
      ? config.storageEngine !== 'sqlite' &&
        !config.localDatabaseUrl &&
        'LOCAL_DATABASE_URL'
      : !config.intelligenceKey && INTELLIGENCE_KEY_MISSING_LABEL,
    config.llmBackend !== 'subscription' && !config.apiKey && 'OPENAI_API_KEY',
    config.llmBackend !== 'subscription' && !config.model && 'OPENAI_MODEL',
  ].filter((item): item is string => !!item);
  const declaredSlack = !!(
    config.slackChannel &&
    config.slackTeam &&
    config.slackUsers.length
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || config.slackUsers.length
      ? 'setup_required'
      : 'not_configured';
  return {
    conversationBackend: config.conversationBackend ?? 'intelligence',
    llmBackend: config.llmBackend ?? 'openai',
    llmProvider:
      config.llmBackend === 'subscription'
        ? (config.llmProvider ?? 'codex')
        : undefined,
    intelligence:
      config.conversationBackend === 'local'
        ? config.storageEngine === 'sqlite' || !!config.localDatabaseUrl
        : !!config.intelligenceKey,
    model: modelConfigured(config),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    composio: !!config.composioApiKey,
    slack:
      config.conversationBackend === 'local' ? 'requires_intelligence' : slack,
    missing,
  };
}
