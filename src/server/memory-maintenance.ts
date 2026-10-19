import { Pool } from 'pg';
import {
  runAgent,
  type AgentOptions,
  type AgentResult,
} from 'myown-llm-integrator';
import type { Message } from '@ag-ui/core';
import type { Store } from './store.js';
import type { WorkspaceStore } from './workspace.js';
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
  maintenance?: MaintenanceGate;
  pg?: Pool;
  clock?: () => number;
  invoke?: (options: AgentOptions) => Promise<AgentResult>;
}
export class MemoryMaintenance {
  readonly pg: Pool;
  readonly scheduler = new InferenceScheduler();
  readonly repository: ConversationMemory;
  readonly recall: MemoryRecall;
  readonly context: ContextBuilder;
  readonly compaction: ContextCompaction;
  readonly jobs: MemoryJobs;
  readonly publication: DreamPublication;
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
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: LocalAiConfig,
    options: Options = {},
  ) {
    this.maintenance = options.maintenance;
    this.clock = options.clock ?? Date.now;
    this.invoke = options.invoke ?? runAgent;
    this.lastInteractiveAt = this.clock();
    this.ownPool = !options.pg;
    this.pg =
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
    this.recall = new MemoryRecall(
      workspace.memory,
      this.repository,
      new MemoryAccess(workspace, store),
    );
    const inference = new MemoryInference(
      { provider: config.llmProvider, model: config.subscriptionModel },
      this.invoke,
      this.scheduler,
    );
    this.compaction = new ContextCompaction(this.repository, inference);
    this.context = new ContextBuilder(
      this.recall,
      {
        inputTokenLimit: config.memoryInputTokenLimit,
        pinnedTokenLimit: config.memoryPinnedTokenLimit,
      },
      this.compaction,
    );
    this.jobs = new MemoryJobs(this.pg, workspace.ownerId, this.clock);
    this.publication = new DreamPublication(this.recall);
    workspace.memory.importLegacy(store.memories());
    for (const dot of workspace.dots())
      workspace.memory.settings(dot.id, this.clock());
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
      this.workspace.memory.settings(
        this.workspace.requireThread(threadId).dotId,
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
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found');
    const settings = this.workspace.memory.updateSettings(
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
    for (const dot of this.workspace
      .dots()
      .filter((dot) => !dotId || dot.id === dotId)) {
      await this.jobs.cancelQueued(dot.id, 'dream');
      await this.jobs.cancelQueued(dot.id, 'compact');
    }
    if (this.active && (!dotId || this.active.job.dotId === dotId))
      this.active.controller.abort(
        new Error('Maintenance disabled by permission change'),
      );
  }
  private ensureAllowed(dotId: string): void {
    if (this.closing) throw new Error('Memory service is closing');
    if (this.store.settings().paused) throw new Error('Workspace is paused');
    this.recall.access.forDot(dotId);
  }
  private ensureJobAllowed(job: MemoryJob): void {
    if (this.closing || this.store.settings().paused)
      throw new Error('Maintenance paused');
    const settings = this.workspace.memory.settings(job.dotId, this.clock());
    if (job.kind === 'dream') this.ensureAllowed(job.dotId);
    if (
      job.origin === 'automatic' &&
      (job.kind === 'compact'
        ? !settings.autoCompact
        : !settings.autoDream || !settings.learningEnabled)
    )
      throw new Error('Maintenance disabled');
  }
  private async blockedThreads(threads: string[]): Promise<Set<string>> {
    const result = await this.pg.query<{ id: string }>(
      `SELECT t.id FROM local_ai_threads t JOIN local_ai_runs r ON r.owner_id=t.owner_id AND r.thread_id=t.id AND r.run_id=t.last_run_id
      WHERE t.owner_id=$1 AND t.id=ANY($2::text[]) AND r.status='finished'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.messages) m CROSS JOIN LATERAL jsonb_array_elements(coalesce(m->'toolCalls','[]'::jsonb)) c
        WHERE m->>'role'='assistant' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t.messages) answer WHERE answer->>'role'='tool' AND answer->>'toolCallId'=c->>'id'))`,
      [this.workspace.ownerId, threads],
    );
    return new Set(result.rows.map((row) => row.id));
  }
  private async jobBlocked(job: MemoryJob): Promise<boolean> {
    if (job.origin !== 'automatic') return false;
    const threads = job.threadId
      ? [job.threadId]
      : (
          await this.pg.query<{ thread_id: string }>(
            'SELECT DISTINCT thread_id FROM memory_episode_chunks WHERE owner_id=$1 AND source_id=ANY($2::text[])',
            [this.workspace.ownerId, job.sourceIds],
          )
        ).rows.map((row) => row.thread_id);
    return (await this.blockedThreads(threads)).size > 0;
  }
  private async indexPending(dotId?: string): Promise<void> {
    const threads = this.workspace
      .conversations()
      .filter((t) => !dotId || t.dotId === dotId)
      .map((t) => t.id);
    const cursorKey = 'index:' + (dotId ?? 'all');
    const rows = await this.pg.query<{ run_id: string }>(
      `SELECT r.run_id FROM local_ai_runs r WHERE r.owner_id=$1 AND r.thread_id=ANY($2::text[]) AND r.status<>'running' AND r.provenance_complete=true
      AND r.run_id>$3 AND NOT EXISTS(SELECT 1 FROM memory_index_runs i WHERE i.owner_id=r.owner_id AND i.thread_id=r.thread_id AND i.run_id=r.run_id) ORDER BY r.run_id LIMIT 5`,
      [
        this.workspace.ownerId,
        threads,
        this.workspace.memory.scanCursor(cursorKey),
      ],
    );
    for (const row of rows.rows) await this.repository.indexRun(row.run_id);
    this.workspace.memory.saveScanCursor(
      cursorKey,
      rows.rows.length === 5 ? rows.rows.at(-1)!.run_id : '',
    );
  }
  async requestCompact(
    threadId: string,
    origin: 'manual' | 'automatic' = 'manual',
    idleMs = 0,
    boundaryHash?: string,
  ): Promise<MemoryJob> {
    if (this.closing || this.store.settings().paused)
      throw new Error('Maintenance is paused');
    const binding = this.workspace.requireThread(threadId);
    const hash =
      boundaryHash ??
      evidenceHash(await this.repository.threadMessages(threadId));
    const settings = this.workspace.memory.settings(
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
    this.ensureAllowed(dotId);
    return (await this.enqueueDream(dotId, 'manual', selectedThreadIds))!;
  }
  private async enqueueDream(
    dotId: string,
    origin: 'manual' | 'automatic',
    selected?: string[],
  ): Promise<MemoryJob | undefined> {
    this.ensureAllowed(dotId);
    const settings = this.workspace.memory.settings(dotId, this.clock());
    if (selected)
      for (const id of selected) this.workspace.requireThread(id, dotId);
    await this.indexPending(dotId);
    const since = selected ? 0 : (settings.enabledAt ?? settings.createdAt);
    const threads =
      selected ??
      this.workspace
        .conversations()
        .filter((t) => t.dotId === dotId)
        .map((t) => t.id);
    const cursorKey = 'dream:' + dotId;
    const blocked =
      origin === 'automatic'
        ? await this.blockedThreads(threads)
        : new Set<string>();
    const rows = await this.pg.query<{ source_id: string }>(
      `SELECT c.source_id FROM memory_episode_chunks c JOIN memory_evidence e ON e.owner_id=c.owner_id AND e.thread_id=c.thread_id AND e.run_id=c.run_id
      LEFT JOIN memory_processed_sources p ON p.owner_id=c.owner_id AND p.source_id=c.source_id
      WHERE c.owner_id=$1 AND e.dot_id=$2 AND e.completed_at>=$3 AND c.thread_id=ANY($4::text[]) AND p.source_id IS NULL AND c.source_id>$5 ORDER BY c.source_id LIMIT 40`,
      [
        this.workspace.ownerId,
        dotId,
        since,
        threads,
        this.workspace.memory.scanCursor(cursorKey),
      ],
    );
    const sourceIds: string[] = [];
    let bytes = 0;
    for (const row of rows.rows) {
      const source = await this.repository.sourceById(row.source_id);
      if (
        !source ||
        blocked.has(source.source.threadId) ||
        !this.recall.access.canRead(this.recall.access.forDot(dotId), source)
      ) {
        this.workspace.memory.saveScanCursor(cursorKey, row.source_id);
        continue;
      }
      const size = estimateTokens(
        JSON.stringify({ id: source.id, text: source.text, role: source.role }),
      );
      if (size > 10000) {
        this.workspace.memory.saveScanCursor(cursorKey, row.source_id);
        continue;
      }
      if (sourceIds.length >= 20 || bytes + size > 10000) break;
      this.workspace.memory.saveScanCursor(cursorKey, row.source_id);
      sourceIds.push(source.id);
      bytes += size;
    }
    if (
      rows.rows.length < 40 &&
      (!rows.rows.length ||
        this.workspace.memory.scanCursor(cursorKey) ===
          rows.rows.at(-1)!.source_id)
    )
      this.workspace.memory.saveScanCursor(cursorKey, '');
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
        settings = this.workspace.memory.settings(job.dotId, now),
        dot = this.workspace.dot(job.dotId);
      if (
        this.store.settings().paused ||
        !dot ||
        (job.kind === 'compact' &&
          job.origin === 'automatic' &&
          !settings.autoCompact) ||
        (job.kind === 'dream' &&
          (!this.store.settings().memoryAllowed ||
            !dot.memoryAllowed ||
            (job.origin === 'automatic' &&
              (!settings.learningEnabled || !settings.autoDream))))
      )
        this.active.controller.abort(new Error('Maintenance disabled'));
    }
    // Reconcile committed SQLite receipts before call-budget sweeps or another inference.
    for (const dot of this.workspace.dots())
      for (const job of await this.jobs.list(dot.id))
        if (
          job.kind === 'dream' &&
          job.state !== 'succeeded' &&
          this.workspace.memory.history.receipt(job.id)
        )
          await this.jobs.acknowledge(job.id);
    if (this.store.settings().paused || this.scheduler.busy || this.worker)
      return;
    await this.indexPending();
    let queuedDream = false;
    const threads = this.workspace.conversations();
    const scan = new Set(
      Array.from(
        { length: Math.min(25, threads.length) },
        (_, i) => threads[(this.scanCursor + i) % threads.length].id,
      ),
    );
    this.scanCursor = threads.length
      ? (this.scanCursor + 25) % threads.length
      : 0;
    for (const dot of this.workspace.dots()) {
      const settings = this.workspace.memory.settings(dot.id, now);
      if (!dot.memoryAllowed || !this.store.settings().memoryAllowed)
        await this.jobs.cancelQueued(dot.id, 'dream');
      if (settings.autoCompact) {
        for (const thread of this.workspace
          .conversations()
          .filter((t) => t.dotId === dot.id && scan.has(t.id))) {
          const snapshot = await this.pg.query<{
            last_run_id: string;
            updated_at: Date;
            last_status: string;
            checkpoint_id: string | null;
          }>(
            `SELECT t.last_run_id,t.updated_at,r.status AS last_status,(SELECT id FROM memory_checkpoints c WHERE c.owner_id=t.owner_id AND c.thread_id=t.id ORDER BY covered_count DESC,created_at DESC LIMIT 1) AS checkpoint_id FROM local_ai_threads t LEFT JOIN local_ai_runs r ON r.owner_id=t.owner_id AND r.thread_id=t.id AND r.run_id=t.last_run_id WHERE t.owner_id=$1 AND t.id=$2`,
            [this.workspace.ownerId, thread.id],
          );
          const row = snapshot.rows[0];
          if (!row || row.last_status === 'running') continue;
          const key = JSON.stringify([
            row,
            this.workspace.memory.suppressionGeneration(),
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
            const exchanges = await this.pg.query(
              'SELECT count(*) AS n FROM memory_evidence WHERE owner_id=$1 AND thread_id=$2 AND workflow_complete=true AND completed_at>$3',
              [this.workspace.ownerId, thread.id, checkpoint?.createdAt ?? 0],
            );
            boundary = {
              key,
              blocked:
                row.last_status === 'finished' && pendingApproval(messages),
              bytes: estimateTokens(
                JSON.stringify(
                  messages.slice(checkpoint?.sourceMessageIds.length ?? 0),
                ),
              ),
              exchanges: Number(exchanges.rows[0].n),
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
        this.store.settings().memoryAllowed &&
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
      this.ensureJobAllowed(job);
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
      this.ensureJobAllowed(job);
      if (await this.jobBlocked(job)) {
        await this.jobs.defer(job.id, job.leaseToken!);
        return;
      }
      if (job.kind === 'compact') {
        await new ContextCompaction(
          this.repository,
          inference,
          async (checkpoint, hash) => {
            this.ensureJobAllowed(job);
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
        this.ensureAllowed(job.dotId);
        const receipt = this.workspace.memory.history.receipt(job.id);
        if (!receipt) {
          const proposal = await new DreamAnalysis(
            this.recall,
            inference,
          ).analyze(job, controller.signal);
          controller.signal.throwIfAborted();
          this.ensureJobAllowed(job);
          if (await this.jobBlocked(job))
            throw new Error('Waiting for approval');
          await this.publication.apply(
            job.id,
            proposal,
            job.publicationPolicy ?? 'review_all',
            job.dotId,
            (work) =>
              this.jobs.withLease(job.id, job.leaseToken!, () => {
                this.ensureJobAllowed(job);
                return work();
              }),
          );
        }
        await this.jobs.acknowledge(job.id);
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
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found');
    return {
      settings: this.workspace.memory.settings(dotId, this.clock()),
      jobs: await this.jobs.list(dotId),
      coverage: await this.repository.coverage(dotId),
      busy: this.scheduler.busy,
      activeJobId: this.active?.job.id ?? null,
      error: this.lastError ?? null,
    };
  }
}
