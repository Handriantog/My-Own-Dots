import './local-defaults.js';
import { DesktopBrowserClient } from './desktop-browser.js';
import {
  readWorkspaceManifest,
  updateWorkspaceManifestSchema,
} from '../shared/workspace-manifest.js';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { LegacySnapshotSource } from './storage/legacy-snapshot.js';
import { UnifiedSnapshotSource } from './storage/unified-snapshot.js';
import { SnapshotOperations } from './storage/snapshot-routes.js';
import {
  claimWorkspaceDatabase,
  workspaceIdentity,
} from './workspace-identity.js';
import { LocalVoiceService, localVoiceConfig } from './local-voice/service.js';
import { webSearchProvider } from './parallel.js';
import { createShutdown } from './shutdown.js';
import { reportChannelFailure, safeFailure } from './slack-channel.js';
import { serve } from '@hono/node-server';
import { StorageClient } from './storage/storage-client.js';
import { sqliteStorageSchema } from './storage/sqlite-schema.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { resolveAppOrigins } from './app-origin.js';

import { Platform } from './platform.js';
import {
  agentRunTimeoutMsFromEnv,
  localAiConfigFromEnv,
  intelligenceApiKeyFromEnv,
  intelligenceWsUrlFromEnv,
  type PlatformConfig,
} from './platform-config.js';
const localAi = localAiConfigFromEnv(process.env);
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4310);
const ownerToken = process.env.OWNER_TOKEN;
if (
  !['127.0.0.1', '::1', 'localhost'].includes(host) &&
  (!ownerToken || ownerToken.length < 24)
)
  throw new Error(
    'External binding requires an OWNER_TOKEN of at least 24 characters.',
  );
const database = process.env.DATABASE_PATH ?? 'data/opendots.sqlite';
const manifest = await readWorkspaceManifest(
  dirname(resolve(process.env.DOTS_WORKSPACE_ENV || '.env')),
);
if (
  manifest &&
  (manifest.storage === 'sqlite'
    ? manifest.schema > sqliteStorageSchema
    : manifest.schema !== 1)
)
  throw new Error(
    'This workspace requires a compatible SQLite storage runtime',
  );
if (
  manifest &&
  process.env.OWNER_ID &&
  manifest.ownerId !== process.env.OWNER_ID
)
  throw new Error('Workspace manifest owner does not match its configuration');
claimWorkspaceDatabase(database);
const workspaceId = manifest?.id ?? workspaceIdentity(database);
const storage = await StorageClient.open({
  database,
  ownerId: manifest?.ownerId ?? process.env.OWNER_ID ?? 'opendots-owner',
  engine: manifest?.storage ?? 'legacy-postgres',
  machineId: process.env.DOTS_PORTABLE_MACHINE_ID,
  postgresUrl: localAi.localDatabaseUrl,
  pinnedTokenLimit: localAi.memoryPinnedTokenLimit,
});
const { store, workspace } = storage.repositories;
if (manifest?.storage === 'sqlite')
  await updateWorkspaceManifestSchema(
    dirname(resolve(process.env.DOTS_WORKSPACE_ENV || '.env')),
    workspace.ownerId,
  );
const config: PlatformConfig = {
  ...localAi,
  intelligenceKey: intelligenceApiKeyFromEnv(process.env),
  intelligenceApiUrl: process.env.INTELLIGENCE_API_URL || undefined,
  intelligenceWsUrl: intelligenceWsUrlFromEnv(process.env),
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL,
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  agentRunTimeoutMs: agentRunTimeoutMsFromEnv({
    ...process.env,
    AGENT_RUN_TIMEOUT_MS:
      process.env.AGENT_RUN_TIMEOUT_MS ||
      (localAi.llmBackend === 'subscription' ? '900000' : undefined),
  }),
  webSearchProvider: webSearchProvider(
    process.env.WEB_SEARCH_PROVIDER || 'disabled',
  ),
  parallelApiKey: process.env.PARALLEL_API_KEY,
  browserUrl: process.env.BROWSER_URL,
  browserSecret: process.env.BROWSER_SECRET,
  composioApiKey: process.env.COMPOSIO_API_KEY || undefined,
  computerSupervisorUrl: process.env.COMPUTER_SUPERVISOR_URL,
  computerSupervisorToken: process.env.COMPUTER_SUPERVISOR_TOKEN,
  computerToken: process.env.COMPUTER_TOKEN,
  computerNamespace: process.env.COMPUTER_NAMESPACE,
  voiceKey: process.env.VOICE_API_KEY,
  voiceModel: process.env.VOICE_MODEL,
  voiceName: process.env.VOICE_NAME ?? 'marin',
  slackChannel: process.env.SLACK_CHANNEL_NAME,
  slackTeam: process.env.SLACK_TEAM_ID,
  slackUsers: (process.env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  slackDotId: process.env.SLACK_DOT_ID || undefined,
  runtimeUrl: `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}/api/copilotkit`,
  ownerToken,
};
const desktopBrowser =
  process.env.DOTS_DESKTOP_BROWSER === '1' && process.send && process.connected
    ? new DesktopBrowserClient(process)
    : undefined;
const platform = await Platform.create(store, workspace, config, {
  storage,
  openWebsite: desktopBrowser?.open,
});
const configurationPath = resolve(process.env.DOTS_WORKSPACE_ENV || '.env');
const snapshotOptions = {
  sqlitePath: database,
  ownerId: workspace.ownerId,
  workspaceId,
  gate: platform.maintenance,
  configurationPath: existsSync(configurationPath)
    ? configurationPath
    : undefined,
};
const snapshots =
  ownerToken && config.conversationBackend === 'local'
    ? new SnapshotOperations(
        storage.engine === 'sqlite'
          ? new UnifiedSnapshotSource({ ...snapshotOptions, storage })
          : new LegacySnapshotSource({
              ...snapshotOptions,
              postgresUrl: config.localDatabaseUrl,
              owned: true,
              conversationBackend: config.conversationBackend,
            }),
        join(dirname(resolve(database)), '.storage-snapshots'),
      )
    : undefined;
const localVoice = new LocalVoiceService(
  platform,
  localVoiceConfig(process.env),
);
const researchConfig = {
  mode: 'live' as const,
  ...localAi,
  apiKey: config.apiKey,
  model: config.model,
  baseUrl: config.baseUrl,
  webSearchProvider: config.webSearchProvider,
  parallelApiKey: config.parallelApiKey,
  browserUrl: config.browserUrl,
  browserSecret: config.browserSecret,
};
const runner = new Runner(
  store,
  researchConfig,
  async (claim, _memories, signal, progress) => {
    const threadId = await workspace.taskThread(claim.id);
    if (!threadId)
      throw new Error(
        'This legacy task has no conversation. Create a new scheduled task from a conversation.',
      );
    progress('Running this task in its saved conversation.');
    const text = await platform.turn(threadId, claim.prompt, signal, {
      opendotsSource: 'scheduled_task',
    });
    return { text, sources: [], sample: false };
  },
  config.agentRunTimeoutMs,
  platform.maintenance,
);
const wsOrigin =
  config.conversationBackend === 'local'
    ? ''
    : new URL(
        config.intelligenceWsUrl ?? 'wss://realtime.intelligence.copilotkit.ai',
      ).origin;
const app = createApp({
  store,
  runner,
  config: researchConfig,
  ownerToken,
  origin: resolveAppOrigins(process.env.APP_ORIGIN, process.env.NODE_ENV),
  platform,
  localVoice,
  snapshots,
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${wsOrigin}; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  await next();
});
app.get('/api/desktop/identity', (c) =>
  c.json({
    service: 'my-own-dots',
    protocol: 1,
    workspaceId,
    capabilities: snapshots ? ['workspace-snapshot-v1'] : [],
    setup: platform.setup(),
  }),
);
app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`My Own Dots listening on http://${host}:${info.port}`);
  runner.start();
  void platform
    .start()
    .catch((error) =>
      reportChannelFailure(
        'Conversation services could not initialize; check setup and database status',
        [safeFailure(error)],
      ),
    );
});
const shutdown = createShutdown({
  stopRunner: async () => {
    platform.maintenance.close();
    await runner.stop();
  },
  stopPlatform: async () => {
    desktopBrowser?.close();
    await snapshots?.close();
    await localVoice.close();
    try {
      await platform.stop();
    } finally {
      await storage.close();
    }
  },
  closeServer: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  exit: (code) => process.exit(code),
  report: (operation, error) =>
    reportChannelFailure(operation, [safeFailure(error)]),
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
const storageFailed = () => {
  reportChannelFailure('Storage worker stopped; closing the backend', [
    safeFailure(storage.signal.reason),
  ]);
  void shutdown();
};
storage.signal.addEventListener('abort', storageFailed, { once: true });
if (storage.signal.aborted) storageFailed();
