export const memoryDefaults = Object.freeze({
  // The default desktop tool catalog plus one Ability already occupies ~23 KB.
  // Keep room for conversation and tool results under the conservative byte estimate.
  inputTokenLimit: 64_000,
  pinnedTokenLimit: 2_000,
  compactThreshold: 0.75,
  compactIdleMs: 120_000,
  compactExchanges: 8,
  compactNewTokens: 4_000,
  dreamIntervalMs: 7_200_000,
  dreamIdleMs: 300_000,
  jobModelCalls: 3,
  jobTimeoutMs: 300_000,
  automaticJobsPerDay: 4,
  retries: 2,
  timeZone: 'UTC',
});
