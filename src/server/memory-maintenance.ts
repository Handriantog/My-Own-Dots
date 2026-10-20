import type {
  StoreRepository,
  WorkspaceRepository,
  EvidenceRepository,
  RecallRepository,
} from './storage/runtime-repositories.js';
import {
  WorkerContext,
  type RuntimeContext,
} from './storage/runtime-context.js';
import type {
  AsyncRepositories,
  AsyncRepository,
} from './storage/repository-contract.js';
import type { MemoryJobRepository } from './memory-jobs.js';
import { Pool } from 'pg';
import {
  runAgent,
  type AgentOptions,
  type AgentResult,
} from 'myown-llm-integrator';
import type { Message } from '@ag-ui/core';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import type { LocalAiConfig } from './platform-config.js';
import type { MemorySettingsPatch } from '../shared/memory.js';
import { ConversationMemory, evidenceHash } from './conversation-memory.js';
import { MemoryAccess } from './memory-access.js';
import { MemoryRecall } from './memory-recall.js';
import { ContextBuilder } from './context-builder.js';
import { ContextCompaction } from './context-compaction.js';
import { estimateTokens } from './context-budget.js';
import { MemoryInference } from './memory-inference.js';
import { InferenceScheduler } from './inference-scheduler.js';
import { MemoryJobs, type MemoryJob } from './memory-jobs.js';
import { DreamAnalysis } from './dream-analysis.js';
import { DreamPublication } from './dream-publication.js';
import type { MaintenanceGate } from './storage/maintenance.js';
export function learningDayKey(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join('-');
}
function pendingApproval(messages: Message[]): boolean {
  const answered = new Set(
    messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId),
  );
  return messages.some(
    (m) =>
      m.role === 'assistant' &&
      m.toolCalls?.some((call) => !answered.has(call.id)),
  );
}
interface Options {
  repositories?: AsyncRepositories;
  maintenance?: MaintenanceGate;
  pg?: Pool;
  clock?: () => number;
  invoke?: (options: AgentOptions) => Promise<AgentResult>;
}
export class MemoryMaintenance {
  private legacyPool?: Pool;
  get pg(): Pool {
    if (!this.legacyPool) throw new Error('Workspace uses SQLite');
    return this.legacyPool;
  }
  readonly scheduler = new InferenceScheduler();
  readonly repository: EvidenceRepository;
  readonly recall: RecallRepository;
  readonly context: RuntimeContext;
  readonly compaction: ContextCompaction;
  readonly jobs: MemoryJobRepository;
  readonly publication: DreamPublication | AsyncRepository<'publication'>;
  private clock: () => number;
  private invoke: (options: AgentOptions) => Promise<AgentResult>;
  private ownPool: boolean;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private worker?: Promise<void>;
  private active?: { job: MemoryJob; controller: AbortController };
  private closing = false;
  private readonly shutdown = new AbortController();
  private maintenance?: MaintenanceGate;
  private lastInteractiveAt: number;
  private lastError?: string;
  private scanCursor = 0;
  private boundaries = new Map<
    string,
    {
      key: string;
      blocked: boolean;
      bytes: number;
      exchanges: number;
      hash: string;
    }
  >();
  constructor(
    readonly store: StoreRepository,
    readonly workspace: WorkspaceRepository,
    readonly config: LocalAiConfig,
    options: Options = {},
  ) {
    this.maintenance = options.maintenance;
    this.clock = options.clock ?? Date.now;
    this.invoke = options.invoke ?? runAgent;
    this.lastInteractiveAt = this.clock();
    const inference = new MemoryInference(
      { provider: config.llmProvider, model: config.subscriptionModel },
      this.invoke,
      this.scheduler,
    );
    const limits = {
      inputTokenLimit: config.memoryInputTokenLimit,
      pinnedTokenLimit: config.memoryPinnedTokenLimit,
    };
    const repositories = options.repositories;
    this.ownPool = !repositories && !options.pg;
    if (repositories) {
      this.repository = Object.assign({}, repositories.evidence, {
        workspace,
        memoryEnabled: async () => (await store.settings()).memoryAllowed,
      });
      this.recall = Object.assign({}, repositories.recall, {
        memory: workspace.memory,
        episodes: this.repository,
        access: Object.assign({}, repositories.access, { store, workspace }),
      });
      this.compaction = new ContextCompaction(this.repository, inference);
      this.context = new WorkerContext(repositories, limits, this.compaction);
      this.publication = repositories.publication;
      this.jobs = repositories.jobs;
    } else {
      // Synchronous repositories are retained only for legacy adapter tests. Production supplies a worker port.
      if (!(store instanceof Store) || !(workspace instanceof WorkspaceStore))
        throw new Error('Worker repositories are required');
      this.legacyPool =
        options.pg ??
        new Pool({
          connectionString: config.localDatabaseUrl,
          max: 2,
          connectionTimeoutMillis: 5000,
          query_timeout: 10000,
        });
      if (this.ownPool)
        this.pg.on('error', () => {
          this.lastError = 'Memory storage connection unavailable';
        });
      this.repository = new ConversationMemory(
        this.pg,
        workspace.ownerId,
        workspace,
        () => store.settings().memoryAllowed,
      );
      const recall = new MemoryRecall(
        workspace.memory,
        this.repository,
        new MemoryAccess(workspace, store),
      );
      this.recall = recall;
      this.compaction = new ContextCompaction(this.repository, inference);
      this.context = new ContextBuilder(recall, limits, this.compaction);
      this.publication = new DreamPublication(recall);
      this.jobs = new MemoryJobs(this.pg, workspace.ownerId, this.clock, {
        publication: this.publication,
        check: () => {
          if (this.closing) throw new Error('Maintenance stopped');
        },
      });
      workspace.memory.importLegacy(store.memories());
      for (const dot of workspace.dots())
        workspace.memory.settings(dot.id, this.clock());
    }
  }
  static async create(
    store: StoreRepository,
    workspace: WorkspaceRepository,
    config: LocalAiConfig,
    options: Options = {},
  ) {
    const service = new MemoryMaintenance(store, workspace, config, options);
    if (options.repositories) {
      await workspace.memory.importLegacy(await store.memories());
      for (const dot of await workspace.dots())
        await workspace.memory.settings(dot.id, service.clock());
    }
    return service;
  }
  start(): void {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => {
      void this.tick(this.clock()).catch(() => {
        this.lastError =
          'Memory maintenance could not reach storage; evidence is retained.';
      });
    }, 1000);
    this.timer.unref();
  }
  pause(): void {
    this.closing = true;
    this.shutdown.abort(new Error('Memory maintenance stopped'));
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.active?.controller.abort(new Error('Maintenance stopped'));
  }
  async stop(): Promise<void> {
    this.pause();
    await this.ticking?.catch(() => {});
    await this.worker?.catch(() => {});
    await this.scheduler.close();
    if (this.ownPool) await this.pg.end();
  }
  async enterForeground(
    signal: AbortSignal,
    threadId?: string,
  ): Promise<() => void> {
    if (this.closing) throw new Error('Memory service is closing');
    if (threadId)
      await this.workspace.memory.settings(
        (await this.workspace.requireThread(threadId)).dotId,
        this.clock(),
      );
    this.lastInteractiveAt = this.clock();
    const release = await this.scheduler.enterForeground(signal);
    return () => {
      this.lastInteractiveAt = this.clock();
      release();
    };
  }
  async updateSettings(
    dotId: string,
    revision: number,
    patch: MemorySettingsPatch,
  ) {
    if (!(await this.workspace.dot(dotId))) throw new Error('Dot not found');
    const settings = await this.workspace.memory.updateSettings(
      dotId,
      revision,
      patch,
      this.clock(),
    );
    if (patch.learningEnabled === false) {
      await this.jobs.cancelQueued(dotId, 'dream');
      if (this.active?.job.dotId === dotId && this.active.job.kind === 'dream')
        this.active.controller.abort(new Error('Learning disabled'));
    }
    if (patch.autoDream === false)
      await this.jobs.cancelQueued(dotId, 'dream', true);
    if (patch.autoCompact === false)
      await this.jobs.cancelQueued(dotId, 'compact', true);
    return settings;
  }
  async permissionsChanged(dotId?: string): Promise<void> {
    for (const dot of (await this.workspace.dots()).filter(
      (dot) => !dotId || dot.id === dotId,
    )) {
      await this.jobs.cancelQueued(dot.id, 'dream');
      await this.jobs.cancelQueued(dot.id, 'compact');
    }
    if (this.active && (!dotId || this.active.job.dotId === dotId))
      this.active.controller.abort(
        new Error('Maintenance disabled by permission change'),
      );
  }
  private async ensureAllowed(dotId: string): Promise<void> {
    if (this.closing) throw new Error('Memory service is closing');
    if ((await this.store.settings()).paused)
      throw new Error('Workspace is paused');
    await this.recall.access.forDot(dotId);
  }
  private async ensureJobAllowed(job: MemoryJob): Promise<void> {
    if (this.closing || (await this.store.settings()).paused)
      throw new Error('Maintenance paused');
    const settings = await this.workspace.memory.settings(
      job.dotId,
      this.clock(),
    );
    if (job.kind === 'dream') await this.ensureAllowed(job.dotId);
    if (
      job.origin === 'automatic' &&
      (job.kind === 'compact'
        ? !settings.autoCompact
        : !settings.autoDream || !settings.learningEnabled)
    )
      throw new Error('Maintenance disabled');
  }
  private async blockedThreads(threads: string[]): Promise<Set<string>> {
    return new Set(await this.repository.blockedThreads(threads));
  }
  private async jobBlocked(job: MemoryJob): Promise<boolean> {
    if (job.origin !== 'automatic') return false;
    const threads = job.threadId
      ? [job.threadId]
      : await this.repository.sourceThreads(job.sourceIds);
    return (await this.blockedThreads(threads)).size > 0;
  }
  private async indexPending(dotId?: string): Promise<void> {
    const threads = (await this.workspace.conversations())
      .filter((t) => !dotId || t.dotId === dotId)
      .map((t) => t.id);
    const cursorKey = 'index:' + (dotId ?? 'all');
    const runs = await this.repository.pendingRuns(
      threads,
      await this.workspace.memory.scanCursor(cursorKey),
    );
    for (const run of runs) await this.repository.indexRun(run);
    await this.workspace.memory.saveScanCursor(
      cursorKey,
      runs.length === 5 ? runs.at(-1)! : '',
    );
  }
  async requestCompact(
    threadId: string,
    origin: 'manual' | 'automatic' = 'manual',
    idleMs = 0,
    boundaryHash?: string,
  ): Promise<MemoryJob> {
    if (this.closing || (await this.store.settings()).paused)
      throw new Error('Maintenance is paused');
    const binding = await this.workspace.requireThread(threadId);
    const hash =
      boundaryHash ??
      evidenceHash(await this.repository.threadMessages(threadId));
    const settings = await this.workspace.memory.settings(
      binding.dotId,
      this.clock(),
    );
    const key = 'compact:' + threadId + ':' + hash;
    return (
      (await this.jobs.find(key)) ??
      (await this.jobs.enqueue({
        kind: 'compact',
        dotId: binding.dotId,
        threadId,
        sourceIds: [hash],
        origin,
        logicalKey: key,
        callLimit: settings.jobModelCalls,
        timeoutMs: settings.jobTimeoutMs,
        retryLimit: settings.retries,
        idleMs,
      }))
    );
  }
  async requestDream(
    dotId: string,
    selectedThreadIds?: string[],
  ): Promise<MemoryJob> {
    await this.ensureAllowed(dotId);
    return (await this.enqueueDream(dotId, 'manual', selectedThreadIds))!;
  }
  private async enqueueDream(
    dotId: string,
    origin: 'manual' | 'automatic',
    selected?: string[],
  ): Promise<MemoryJob | undefined> {
    await this.ensureAllowed(dotId);
    const settings = await this.workspace.memory.settings(dotId, this.clock());
    if (selected)
      for (const id of selected) await this.workspace.requireThread(id, dotId);
    await this.indexPending(dotId);
    const since = selected ? 0 : (settings.enabledAt ?? settings.createdAt);
    const threads =
      selected ??
      (await this.workspace.conversations())
        .filter((t) => t.dotId === dotId)
        .map((t) => t.id);
    const cursorKey = 'dream:' + dotId;
    const blocked =
      origin === 'automatic'
        ? await this.blockedThreads(threads)
        : new Set<string>();
    const rows = await this.repository.pendingSources({
      dotId,
      since,
      threadIds: threads,
      cursor: await this.workspace.memory.scanCursor(cursorKey),
    });
    const sourceIds: string[] = [];
    let bytes = 0;
    for (const row of rows) {
      const source = await this.repository.sourceById(row);
      if (
        !source ||
        blocked.has(source.source.threadId) ||
        !(await this.recall.access.canRead(
          await this.recall.access.forDot(dotId),
          source,
        ))
      ) {
        await this.workspace.memory.saveScanCursor(cursorKey, row);
        continue;
      }
      const size = estimateTokens(
        JSON.stringify({ id: source.id, text: source.text, role: source.role }),
      );
      if (size > 10000) {
        await this.workspace.memory.saveScanCursor(cursorKey, row);
        continue;
      }
      if (sourceIds.length >= 20 || bytes + size > 10000) break;
      await this.workspace.memory.saveScanCursor(cursorKey, row);
      sourceIds.push(source.id);
      bytes += size;
    }
    if (
      rows.length < 40 &&
      (!rows.length ||
        (await this.workspace.memory.scanCursor(cursorKey)) === rows.at(-1)!)
    )
      await this.workspace.memory.saveScanCursor(cursorKey, '');
    if (!sourceIds.length && origin === 'automatic') return;
    const key = 'dream:' + dotId + ':' + evidenceHash(sourceIds);
    const existing = await this.jobs.find(key);
    if (existing) return existing;
    const job = await this.jobs.enqueue({
      kind: 'dream',
      dotId,
      sourceIds,
      origin,
      logicalKey: key,
      publicationPolicy: settings.learningEnabled
        ? settings.publicationPolicy
        : 'review_all',
      callLimit: settings.jobModelCalls,
      timeoutMs: settings.jobTimeoutMs,
      retryLimit: settings.retries,
      idleMs: origin === 'automatic' ? settings.dreamIdleMs : 0,
    });
    if (
      origin === 'automatic' &&
      !(await this.jobs.admitAutomatic(
        job.id,
        learningDayKey(this.clock(), settings.timeZone),
        settings.automaticJobsPerDay,
      ))
    )
      return;
    return job;
  }
  tick(now = this.clock()): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const work = this.maintenance
      ? this.maintenance.runWrite(
          this.shutdown.signal,
          () => this.advance(now),
          { background: true },
        )
      : this.advance(now);
    this.ticking = work
      .catch((error) => {
        if (!this.closing) throw error;
      })
      .finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }
  private async advance(now: number): Promise<void> {
    if (this.active) {
      const job = this.active.job,
        settings = await this.workspace.memory.settings(job.dotId, now),
        dot = await this.workspace.dot(job.dotId);
      if (
        (await this.store.settings()).paused ||
        !dot ||
        (job.kind === 'compact' &&
          job.origin === 'automatic' &&
          !settings.autoCompact) ||
        (job.kind === 'dream' &&
          (!(await this.store.settings()).memoryAllowed ||
            !dot.memoryAllowed ||
            (job.origin === 'automatic' &&
              (!settings.learningEnabled || !settings.autoDream))))
      )
        this.active.controller.abort(new Error('Maintenance disabled'));
    }
    // Reconcile committed SQLite receipts before call-budget sweeps or another inference.
    for (const dot of await this.workspace.dots())
      for (const job of await this.jobs.list(dot.id))
        if (
          job.kind === 'dream' &&
          job.state !== 'succeeded' &&
          (await this.workspace.memory.history.receipt(job.id))
        )
          await this.jobs.reconcileReceipt(job.id);
    if (
      (await this.store.settings()).paused ||
      this.scheduler.busy ||
      this.worker
    )
      return;
    await this.indexPending();
    let queuedDream = false;
    const threads = await this.workspace.conversations();
    const scan = new Set(
      Array.from(
        { length: Math.min(25, threads.length) },
        (_, i) => threads[(this.scanCursor + i) % threads.length].id,
      ),
    );
    this.scanCursor = threads.length
      ? (this.scanCursor + 25) % threads.length
      : 0;
    for (const dot of await this.workspace.dots()) {
      const settings = await this.workspace.memory.settings(dot.id, now);
      if (!dot.memoryAllowed || !(await this.store.settings()).memoryAllowed)
        await this.jobs.cancelQueued(dot.id, 'dream');
      if (settings.autoCompact) {
        for (const thread of (await this.workspace.conversations()).filter(
          (t) => t.dotId === dot.id && scan.has(t.id),
        )) {
          const row = await this.repository.compactSnapshot(thread.id);
          if (!row || row.lastStatus === 'running') continue;
          const key = JSON.stringify([
            row,
            await this.workspace.memory.suppressionGeneration(),
            dot.spaceIds,
            dot.memoryAllowed,
          ]);
          let boundary = this.boundaries.get(thread.id);
          if (boundary?.key !== key) {
            const messages = await this.repository.threadMessages(thread.id);
            const checkpoint = await this.repository.latestCheckpoint(
              thread.id,
              messages,
            );
            const exchanges = await this.repository.completedExchanges(
              thread.id,
              checkpoint?.createdAt ?? 0,
            );
            boundary = {
              key,
              blocked:
                row.lastStatus === 'finished' && pendingApproval(messages),
              bytes: estimateTokens(
                JSON.stringify(
                  messages.slice(checkpoint?.sourceMessageIds.length ?? 0),
                ),
              ),
              exchanges: exchanges,
              hash: evidenceHash(messages),
            };
            this.boundaries.delete(thread.id);
            this.boundaries.set(thread.id, boundary);
            if (this.boundaries.size > 256)
              this.boundaries.delete(this.boundaries.keys().next().value!);
          }
          if (boundary.blocked) continue;
          const tokens = this.context.inputTokens(thread.id) ?? boundary.bytes;
          const threshold =
            tokens >=
            this.context.limits.inputTokenLimit * settings.compactThreshold;
          const idle =
            now - this.lastInteractiveAt >= settings.compactIdleMs &&
            (boundary.exchanges >= settings.compactExchanges ||
              boundary.bytes >= settings.compactNewTokens);
          if (threshold || idle)
            await this.requestCompact(
              thread.id,
              'automatic',
              threshold ? 0 : settings.compactIdleMs,
              boundary.hash,
            );
        }
      }
      if (
        !queuedDream &&
        settings.learningEnabled &&
        settings.autoDream &&
        dot.memoryAllowed &&
        (await this.store.settings()).memoryAllowed &&
        now - this.lastInteractiveAt >= settings.dreamIdleMs
      ) {
        const last =
          (await this.jobs.lastAutomatic(dot.id)) ??
          settings.enabledAt ??
          settings.createdAt;
        if (now - last >= settings.dreamIntervalMs)
          queuedDream = !!(await this.enqueueDream(dot.id, 'automatic'));
      }
    }
    const job = await this.jobs.claim(now, this.lastInteractiveAt);
    if (job)
      this.worker = (
        this.maintenance
          ? this.maintenance.runWrite(
              new AbortController().signal,
              () => this.execute(job),
              { background: true },
            )
          : this.execute(job)
      )
        .catch(() => {
          this.lastError =
            'Memory maintenance could not save its outcome; evidence is retained.';
        })
        .finally(() => {
          this.worker = undefined;
        });
  }
  private async execute(job: MemoryJob): Promise<void> {
    const controller = new AbortController();
    this.active = { job, controller };
    const renewals = new Set<Promise<unknown>>();
    const renewal = setInterval(() => {
      const pending = this.jobs
        .renew(job.id, job.leaseToken!)
        .catch(() => controller.abort(new Error('Maintenance lease lost')))
        .finally(() => renewals.delete(pending));
      renewals.add(pending);
    }, 20000);
    renewal.unref();
    const timeout = setTimeout(
      () => controller.abort(new Error('Maintenance time budget exhausted')),
      Math.max(1, (job.timeoutMs ?? 300000) - job.elapsedMs),
    );
    timeout.unref();
    const tracked = async (options: AgentOptions): Promise<AgentResult> => {
      await this.ensureJobAllowed(job);
      if (await this.jobBlocked(job)) throw new Error('Waiting for approval');
      await this.jobs.recordUsage(job.id, job.leaseToken!, { modelCalls: 1 });
      const began = this.clock();
      try {
        return await this.invoke(options);
      } finally {
        await this.jobs.recordUsage(job.id, job.leaseToken!, {
          elapsedMs: Math.max(0, Math.ceil(this.clock() - began)),
        });
      }
    };
    const inference = new MemoryInference(
      {
        provider: this.config.llmProvider,
        model: this.config.subscriptionModel,
      },
      tracked,
      this.scheduler,
    );
    try {
      await this.ensureJobAllowed(job);
      if (await this.jobBlocked(job)) {
        await this.jobs.defer(job.id, job.leaseToken!);
        return;
      }
      if (job.kind === 'compact') {
        await new ContextCompaction(
          this.repository,
          inference,
          async (checkpoint, hash) => {
            await this.ensureJobAllowed(job);
            if (await this.jobBlocked(job))
              throw new Error('Waiting for approval');
            return this.repository.saveCheckpoint(checkpoint, hash, {
              id: job.id,
              token: job.leaseToken!,
              now: this.clock(),
            });
          },
        ).compact(
          job.threadId!,
          controller.signal,
          job.origin === 'manual' ? 'manual' : 'compact',
        );
        await this.jobs.settle(job.id, job.leaseToken!, { state: 'succeeded' });
      } else {
        await this.ensureAllowed(job.dotId);
        const receipt = await this.workspace.memory.history.receipt(job.id);
        const proposal = receipt
          ? { changes: [], evidence: [] }
          : await new DreamAnalysis(this.recall, inference).analyze(
              job,
              controller.signal,
            );
        controller.signal.throwIfAborted();
        await this.ensureJobAllowed(job);
        if (await this.jobBlocked(job)) throw new Error('Waiting for approval');
        await this.jobs.publishDream(
          {
            jobId: job.id,
            lease: job.leaseToken!,
            generation: job.attempts,
            proposal,
            policy: job.publicationPolicy ?? 'review_all',
            dotId: job.dotId,
          },
          controller.signal,
        );
      }
      this.lastError = undefined;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Maintenance failed';
      this.lastError = message.slice(0, 500);
      const current = await this.jobs.get(job.id).catch(() => undefined);
      if (
        current?.state === 'running' &&
        current.leaseToken === job.leaseToken
      ) {
        if (message === 'Waiting for approval') {
          await this.jobs.defer(job.id, job.leaseToken!);
          return;
        }
        const disabled =
          this.closing || /disabled|paused|stopped/i.test(message);
        const retry =
          !disabled &&
          current.attempts <= (current.retryLimit ?? 2) &&
          current.modelCalls < (current.callLimit ?? 3) &&
          current.elapsedMs < (current.timeoutMs ?? 300000) &&
          !/evidence|revision|capacity|budget|invalid|schema/i.test(message);
        await this.jobs
          .settle(job.id, job.leaseToken!, {
            state: disabled ? 'cancelled' : retry ? 'queued' : 'failed',
            dueAt: this.clock() + (current.attempts === 1 ? 30000 : 120000),
            error: message,
          })
          .catch(() => {});
      }
    } finally {
      clearInterval(renewal);
      clearTimeout(timeout);
      await Promise.allSettled(renewals);
      this.active = undefined;
    }
  }
  async status(dotId: string) {
    if (!(await this.workspace.dot(dotId))) throw new Error('Dot not found');
    return {
      settings: await this.workspace.memory.settings(dotId, this.clock()),
      jobs: await this.jobs.list(dotId),
      coverage: await this.repository.coverage(dotId),
      busy: this.scheduler.busy,
      activeJobId: this.active?.job.id ?? null,
      error: this.lastError ?? null,
    };
  }
}
