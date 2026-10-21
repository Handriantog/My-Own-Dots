import { MaintenanceGate } from './storage/maintenance.js';
import { MemoryMaintenance } from './memory-maintenance.js';
import { PostgresConversations } from './local-conversations.js';
import { LocalAgentRunner } from './local-runner.js';
import { localThreadResponse } from './local-thread-routes.js';
import { ComputerService } from './computer-service.js';
import { ConnectionService } from './connections.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import {
  CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
import { createSlackChannel } from './slack-channel.js';
export { slackIdentity } from './slack-channel.js';
import type {
  StoreRepository,
  WorkspaceRepository,
} from './storage/runtime-repositories.js';
import type { StorageClient } from './storage/storage-client.js';
import { SQLiteConversations } from './storage/sqlite-conversations.js';
import type { ConversationRepository } from './local-conversations.js';

import { DotAgent } from './dot-agent.js';
import { runThreadTurn } from './headless.js';
import {
  INTELLIGENCE_KEY_MISSING_LABEL,
  setupStatus,
  type PlatformConfig,
} from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { learningSelector } from './learning.js';
import { SetupTelemetry } from './setup-telemetry.js';
import { VoiceService } from './voice.js';
import { VoiceDelegationCoordinator } from './local-voice/delegation.js';
import { NativeVoiceRuntime } from './local-voice/native-runtime.js';
export class Platform {
  readonly maintenance = new MaintenanceGate();
  readonly voice = new VoiceService(this);
  private channelStartupFailed = false;
  setupTelemetry!: SetupTelemetry;
  pages!: PageService;
  computers!: ComputerService;
  connections!: ConnectionService;
  intelligence?: CopilotKitIntelligence;
  localConversations?: ConversationRepository;
  memory?: MemoryMaintenance;
  nativeVoice?: NativeVoiceRuntime;
  private delegations?: VoiceDelegationCoordinator;
  get voiceDelegations() {
    return this.delegations?.jobs;
  }
  private localRunner?: LocalAgentRunner;
  handler?: CopilotHonoApp;
  private constructor(
    readonly store: StoreRepository,
    readonly workspace: WorkspaceRepository,
    readonly config: PlatformConfig,
  ) {}
  static async create(
    store: StoreRepository,
    workspace: WorkspaceRepository,
    config: PlatformConfig,
    options: { storage?: StorageClient } = {},
  ): Promise<Platform> {
    const platform = new Platform(
      store,
      workspace,
      options.storage
        ? { ...config, storageEngine: options.storage.engine }
        : config,
    );
    await platform.initialize(options);
    return platform;
  }
  private async initialize(options: { storage?: StorageClient }) {
    const { store, workspace, config } = this;
    this.setupTelemetry = await SetupTelemetry.create(
      store,
      undefined,
      undefined,
      undefined,
      this.maintenance,
    );
    this.computers = new ComputerService(
      workspace,
      config,
      async () => (await store.settings()).paused,
    );
    this.connections = new ConnectionService(workspace.connections);
    this.pages = new PageService(
      workspace,
      () => {
        this.requireReady();
        return this.localConversations ?? this.intelligence!;
      },
      this.maintenance,
    );
    if (config.conversationBackend === 'local') {
      if (options.storage?.engine !== 'sqlite' && !config.localDatabaseUrl)
        return;
      this.localConversations =
        options.storage?.engine === 'sqlite'
          ? new SQLiteConversations(options.storage)
          : new PostgresConversations(
              config.localDatabaseUrl!,
              workspace.ownerId,
            );
      if (config.llmBackend === 'subscription')
        this.memory = await MemoryMaintenance.create(store, workspace, config, {
          maintenance: this.maintenance,
          repositories: options.storage?.repositories,
        });
      if (options.storage?.engine === 'sqlite')
        this.delegations = new VoiceDelegationCoordinator(
          options.storage.repositories.voiceDelegations,
          this.localConversations,
        );
      this.localRunner = new LocalAgentRunner(
        this.localConversations,
        this.memory,
        this.maintenance,
        this.delegations,
      );
      if (this.delegations && this.memory)
        this.nativeVoice = new NativeVoiceRuntime(
          this,
          this.localRunner,
          this.delegations,
        );
    } else {
      if (!config.intelligenceKey) return;
      this.intelligence = new CopilotKitIntelligence({
        apiKey: config.intelligenceKey,
        apiUrl: config.intelligenceApiUrl,
        wsUrl: config.intelligenceWsUrl,
        getLearningContainerId: learningSelector(
          workspace,
          config.slackDotId ?? (await workspace.dots())[0]?.id,
        ),
      });
    }
    const channels = [];
    if (
      this.intelligence &&
      config.slackChannel &&
      config.slackTeam &&
      config.slackUsers.length
    ) {
      const dotId = config.slackDotId ?? (await workspace.dots())[0].id;
      if (!(await workspace.dot(dotId)))
        throw new Error('SLACK_DOT_ID does not identify an existing Dot.');
      const slack = createSlackChannel({
        name: config.slackChannel,
        config,
        ownerId: workspace.ownerId,
        paused: async () => (await store.settings()).paused,
        agent: () =>
          new DotAgent(
            store,
            workspace,
            config,
            dotId,
            true,
            this.setupTelemetry,
          ),
      });
      channels.push(slack);
    }
    const common = {
      telemetryId: this.setupTelemetry.identity,
      telemetryProperties: this.setupTelemetry.metadata,
      agents: async () =>
        Object.fromEntries(
          (await workspace.dots()).map((dot) => [
            dot.id,
            new DotAgent(
              store,
              workspace,
              config,
              dot.id,
              false,
              this.setupTelemetry,
              this.memory,
              this.delegations?.jobs,
            ),
          ]),
        ),
    };
    const runtime = this.localRunner
      ? new CopilotRuntime({ ...common, runner: this.localRunner })
      : new CopilotRuntime({
          ...common,
          intelligence: this.intelligence!,
          channels,
          generateThreadNames: true,
          identifyUser: async () => ({
            id: workspace.ownerId,
            name: 'My Own Dots owner',
          }),
        });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }
  setup() {
    return setupStatus(
      this.config,
      this.handler?.channels?.status().overall ??
        (this.config.slackChannel ? 'setup_required' : 'not_configured'),
      this.channelStartupFailed,
    );
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(
        `Setup required: ${missing.join(', ')}. Configure the selected conversation and model backends.`,
      );
  }
  async start() {
    await this.maintenance.runWrite(
      new AbortController().signal,
      async () => {
        await this.localConversations?.initialize();
        await this.nativeVoice?.start();
      },
      { background: true },
    );
    this.memory?.start();
    this.setupTelemetry.start();
    if (this.handler?.channels) {
      try {
        await this.handler.channels.ready({ timeoutMs: 15000 });
        this.channelStartupFailed = false;
      } catch (error) {
        this.channelStartupFailed = true;
        await this.setupTelemetry.capture({
          kind: 'setup_failed',
          step: 'settings',
          error_class: 'channel_start_failed',
        });
        throw error;
      }
    }
  }
  async stop() {
    this.maintenance.close();
    this.memory?.pause();
    try {
      await Promise.all([
        this.voice.close(),
        this.nativeVoice?.close(),
        this.localRunner?.close(),
      ]);
    } finally {
      await this.memory?.stop();
      await this.setupTelemetry.stop();
      await this.handler?.channels?.stop();
      await this.maintenance.drain();
      await this.localConversations?.close();
    }
  }
  /** Cancel only a run whose latest input is the server-issued voice message. */
  async stopVoiceTurn(threadId: string, messageId: string): Promise<void> {
    await this.workspace.requireThread(threadId);
    const run = (await this.localConversations?.getSnapshot(threadId))?.lastRun;
    if (
      run?.status === 'running' &&
      run.input.messages.findLast((m) => m.role === 'user')?.id === messageId
    )
      await this.localRunner?.stop({ threadId, runId: run.runId });
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!(await this.workspace.dot(dotId))) throw new Error('Dot not found.');
    const id = randomUUID();
    try {
      await (this.localConversations ?? this.intelligence!).createThread({
        threadId: id,
        userId: this.workspace.ownerId,
        agentId: dotId,
        name: title,
      });
    } catch {
      throw new Error(
        this.localConversations
          ? 'Local conversation storage is unavailable. Start PostgreSQL with npm run conversations:up and check LOCAL_DATABASE_URL.'
          : 'Intelligence could not create this conversation. Check the runtime key and connection.',
      );
    }
    return await this.workspace.bindThread(id, dotId, title);
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    await this.workspace.requireThread(threadId);
    const history = await (
      this.localConversations ?? this.intelligence!
    ).getThreadMessages({
      threadId,
      userId: this.workspace.ownerId,
    });
    return history.messages
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }
  async handle(request: Request): Promise<Response> {
    if (!this.handler)
      return Response.json(
        {
          error: `Setup required: ${this.config.conversationBackend === 'local' ? 'LOCAL_DATABASE_URL' : INTELLIGENCE_KEY_MISSING_LABEL}.`,
        },
        { status: 503 },
      );
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      await validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    if (this.localConversations) {
      try {
        const response = await localThreadResponse(
          request,
          body,
          this.localConversations,
          this.workspace,
        );
        if (response) return response;
        const responseFromRuntime = await this.handler.fetch(request);
        if (
          new URL(request.url).pathname === '/api/copilotkit/info' &&
          responseFromRuntime.ok
        ) {
          const info = await responseFromRuntime.json();
          return Response.json({
            ...info,
            threadEndpoints: {
              list: true,
              inspect: true,
              mutations: false,
              realtimeMetadata: false,
            },
          });
        }
        return responseFromRuntime;
      } catch {
        return Response.json(
          {
            error:
              'Local conversation storage is unavailable. Check PostgreSQL and LOCAL_DATABASE_URL.',
          },
          { status: 503 },
        );
      }
    }
    return this.handler.fetch(request);
  }
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    const thread = await this.workspace.requireThread(threadId);
    return runThreadTurn(
      this.config.runtimeUrl,
      this.config.ownerToken
        ? { Authorization: `Bearer ${this.config.ownerToken}` }
        : {},
      thread.dotId,
      threadId,
      prompt,
      signal,
      metadata,
    );
  }
}
