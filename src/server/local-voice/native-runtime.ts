import { randomUUID } from 'node:crypto';
import {
  EventType,
  type AbstractAgent,
  type RunAgentInput,
} from '@ag-ui/client';
import { lastValueFrom, toArray } from 'rxjs';
import type { Platform } from '../platform.js';
import type { LocalAgentRunner } from '../local-runner.js';
import { DotAgent } from '../dot-agent.js';
import { NativeConversationAgent } from './native-agent.js';
import {
  VoiceDelegationCoordinator,
  delegatedApprovalTools,
  delegatedOutcome,
} from './delegation.js';
import type {
  NativeHistoryMessage,
  NativeRoutingContext,
  NativeSpeech,
  NativeUnderstanding,
  NativeVoiceSession,
} from './native-contract.js';
import {
  expiredFolderApprovalMessage,
  type VoiceDelegation,
} from '../../shared/voice-delegation.js';
import { runtimePolicy } from '../storage/runtime-policy.js';
import { personalityInstruction } from '../../shared/voice-settings.js';
import type { EvidenceGuard } from '../../shared/memory.js';

export interface NativeTurn {
  callId: string;
  dotId: string;
  threadId: string;
  messageId: string;
  audio: Buffer;
  understanding: NativeUnderstanding;
  native: NativeVoiceSession;
  signal: AbortSignal;
}
const clean = (text: string, limit = 4000) =>
  text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replaceAll('<|', '< |')
    .replaceAll('|>', '| >')
    .slice(0, limit);
function recentHistory(
  messages: { id: string; role: string; content?: unknown }[],
  excludeId?: string,
  budget = 8000,
): NativeHistoryMessage[] {
  let remaining = budget;
  const history: NativeHistoryMessage[] = [];
  for (const message of messages
    .filter(
      (m) =>
        m.id !== excludeId &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string',
    )
    .slice(-8)
    .reverse()) {
    const text = clean(String(message.content), Math.min(remaining, 2000));
    if (!text.trim()) continue;
    history.unshift({ role: message.role as 'user' | 'assistant', text });
    remaining -= text.length;
  }
  return history;
}
export function voiceJobReceipt(job: VoiceDelegation) {
  const link = `[Open task conversation](#/chat/${encodeURIComponent(job.dotId)}/${encodeURIComponent(job.workerThreadId)})`;
  const label =
    job.status === 'approval'
      ? 'Your task is waiting for approval.'
      : job.status === 'completed'
        ? 'Your task has finished.'
        : job.status === 'cancelled'
          ? 'Your task was stopped.'
          : job.status === 'interrupted'
            ? job.error === expiredFolderApprovalMessage
              ? expiredFolderApprovalMessage
              : 'Your task was interrupted. Review completed actions before asking to retry.'
            : 'Your task failed. Review its conversation for details.';
  const result =
    job.status === 'completed' && job.result?.trim() ? job.result.trim() : '';
  const excerpt = clean(
    result
      .replace(/```[\s\S]*?```/g, ' Code is in the task conversation. ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'link in chat')
      .replace(/[*_`#]/g, ''),
    280,
  ).trim();
  const spoken =
    result && !/^[{[]|<(?:think|analysis|tool_call)\b/i.test(result)
      ? `Your task finished. ${excerpt}${result.length > 280 ? ' More details are in chat.' : ''}`
      : label;
  return {
    id: `voice-job:${job.id}:${job.leaseGeneration}:${job.status}`,
    text: `${label}${result ? `\n\n${result.slice(0, 12000)}` : ''}\n\n${link}`,
    spoken,
  };
}
export class NativeVoiceRuntime {
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private delivering?: Promise<void>;
  private dispatches = new Set<Promise<void>>();
  private readonly updates = new Set<(job: VoiceDelegation) => void>();
  constructor(
    private platform: Platform,
    private runner: LocalAgentRunner,
    readonly coordinator: VoiceDelegationCoordinator,
  ) {}
  async start() {
    await this.coordinator.recover();
    this.timer = setInterval(() => {
      void this.deliverReceipts();
    }, 1000);
    this.timer.unref?.();
  }
  listen(listener: (job: VoiceDelegation) => void) {
    this.updates.add(listener);
    return () => {
      this.updates.delete(listener);
    };
  }
  private async currentJob(
    dotId: string,
    threadId: string,
    includeOtherThreads = false,
  ) {
    const jobs = await this.coordinator.jobs.list();
    return (
      jobs.findLast(
        (job) => job.dotId === dotId && job.parentThreadId === threadId,
      ) ??
      (includeOtherThreads
        ? jobs.find(
            (job) =>
              job.dotId === dotId &&
              ['queued', 'running', 'approval'].includes(job.status),
          )
        : undefined)
    );
  }
  private async permittedReceipt(
    job: VoiceDelegation,
    record: (guard: EvidenceGuard) => Promise<void>,
  ) {
    const context = await this.coordinator.jobs.threadContext(
      job.workerThreadId,
      job.dotId,
    );
    if (!context.available) return { ...job, result: null };
    await record(context.guard);
    if (job.status !== 'completed') return job;
    const snapshot = await this.platform.localConversations!.getSnapshot(
      job.workerThreadId,
    );
    if (snapshot.lastRun?.runId !== job.runId) return { ...job, result: null };
    // Re-project canonical messages after any forget/revocation before selecting
    // this run's answer. This also recovers old generic receipts without replaying work.
    const messages = await this.platform.memory!.repository.modelMessages(
      job.workerThreadId,
      snapshot.messages,
    );
    const outcome = delegatedOutcome({ ...snapshot, messages });
    return {
      ...job,
      result: outcome.status === 'completed' ? (outcome.result ?? null) : null,
    };
  }
  /** Routing receives only authorized canonical prose and host-owned lifecycle. */
  async context(scope: {
    callId: string;
    dotId: string;
    threadId: string;
  }): Promise<NativeRoutingContext> {
    if (this.closed) throw Error('Native voice is closed.');
    await this.platform.workspace.requireThread(scope.threadId, scope.dotId);
    if (
      (await this.platform.workspace.call(scope.callId)).threadId !==
      scope.threadId
    )
      throw Error('Native call scope mismatch.');
    const context = await this.coordinator.jobs.threadContext(
      scope.threadId,
      scope.dotId,
    );
    const job = await this.currentJob(scope.dotId, scope.threadId);
    return {
      history: context.available ? recentHistory(context.messages) : [],
      taskStatus: job?.status ?? 'none',
    };
  }
  private async run(
    agent: AbstractAgent,
    input: RunAgentInput,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const stop = () => {
      void this.runner.stop({ threadId: input.threadId, runId: input.runId });
    };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const events = await lastValueFrom(
        this.runner
          .run({ threadId: input.threadId, agent, input })
          .pipe(toArray()),
      );
      signal?.throwIfAborted();
      if (events.some((event) => event.type === EventType.RUN_ERROR))
        throw Error(
          'The conversation could not finish. Review the saved conversation.',
        );
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  }
  async turn(
    turn: NativeTurn,
  ): Promise<
    NativeSpeech & { assistantMessageId: string; reviewFolders?: boolean }
  > {
    if (this.closed) throw Error('Native voice is closed.');
    const { platform } = this;
    await platform.workspace.requireThread(turn.threadId, turn.dotId);
    if ((await platform.workspace.call(turn.callId)).threadId !== turn.threadId)
      throw Error('Native call scope mismatch.');
    const understanding = turn.understanding;
    if (
      !understanding.text.trim() ||
      understanding.text.length > 4000 ||
      understanding.route === 'ignore'
    )
      throw Error('Native caption is unavailable.');
    if (
      understanding.route === 'delegate' &&
      (understanding.tool?.name !== 'delegate_task' ||
        understanding.tool.arguments.request !== understanding.text)
    )
      throw Error('Delegation request must match its caption.');
    let speech: NativeSpeech | undefined;
    let reviewFolders = false;
    const assistantMessageId = randomUUID();
    const agent = new NativeConversationAgent(
      turn.dotId,
      async (input, runSignal, record) => {
        const signal = AbortSignal.any([runSignal, turn.signal]);
        signal.throwIfAborted();
        const policy = runtimePolicy(platform.store, platform.workspace);
        const initial = await policy.turnState(turn.dotId);
        const suppressionGeneration =
          await platform.workspace.memory.suppressionGeneration();
        if (initial.settings.paused || !initial.dot)
          throw Error('Dot is unavailable.');
        const dot = initial.dot;
        const page = await policy.pageContext({
          dotId: dot.id,
          threadId: turn.threadId,
        });
        const sourcePages = new Map<string, string[]>();
        if (page) {
          sourcePages.set(page.id, [page.spaceId]);
          await record({
            originDotId: dot.id,
            pageIds: [page.id],
            spaceIds: [page.spaceId],
          });
        }
        const check = async () => {
          signal.throwIfAborted();
          const current = await policy.turnState(dot.id, [...sourcePages]);
          if (
            !current.sourcesAvailable ||
            (await platform.workspace.memory.suppressionGeneration()) !==
              suppressionGeneration ||
            current.settings.paused ||
            JSON.stringify({ ...current, sourcesAvailable: true }) !==
              JSON.stringify({ ...initial, sourcesAvailable: true })
          )
            throw Error('Dot context changed. Please repeat your request.');
        };
        if (understanding.route === 'delegate') {
          await check();
          const queued = await this.coordinator.jobs.enqueue({
            id: randomUUID(),
            dotId: dot.id,
            callId: turn.callId,
            parentThreadId: turn.threadId,
            workerThreadId: randomUUID(),
            utteranceId: turn.messageId,
            sourceMessageId: turn.messageId,
            sourceText: understanding.text,
            request: understanding.tool!.arguments.request,
          });
          if (queued.kind === 'created') this.dispatch(queued.job);
          reviewFolders = queued.job.status === 'approval';
          speech = await turn.native.speak(
            queued.kind === 'busy'
              ? queued.job.status === 'approval'
                ? 'Your earlier task is waiting for approval.'
                : 'Your earlier task is still running.'
              : "I'll work on that. You can keep talking while your task is queued or running.",
            signal,
          );
        } else if (understanding.route === 'clock') {
          const now = new Date();
          const time = new Intl.DateTimeFormat('en', {
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'short',
          }).format(now);
          const date = new Intl.DateTimeFormat('en', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          }).format(now);
          await check();
          speech = await turn.native.speak(`It's ${time} on ${date}.`, signal);
        } else if (understanding.route === 'status') {
          let job = await this.currentJob(dot.id, turn.threadId);
          if (job?.status === 'completed') {
            job = await this.permittedReceipt(job, async (guard) => {
              for (const id of guard.pageIds)
                sourcePages.set(id, guard.spaceIds);
              await record(guard);
            });
          }
          reviewFolders = job?.status === 'approval';
          const text = !job
            ? 'There is no recent task in this conversation.'
            : job.status === 'running'
              ? 'Your task is still running.'
              : job.status === 'queued'
                ? 'Your task is queued.'
                : voiceJobReceipt(job).spoken;
          await check();
          speech = await turn.native.speak(text, signal);
        } else {
          const memories = await platform.memory!.context.essentials(dot.id);
          for (const memory of memories) {
            await record({
              originDotId: dot.id,
              pageIds: [],
              spaceIds: [],
              memoryItemIds: [memory.id],
            });
            for (const source of memory.sources) {
              for (const id of source.guard.pageIds)
                sourcePages.set(id, source.guard.spaceIds);
              await record({ ...source.guard, originDotId: dot.id });
            }
          }
          const context = await this.coordinator.jobs.threadContext(
            turn.threadId,
            dot.id,
          );
          if (context.available) {
            for (const id of context.guard.pageIds)
              sourcePages.set(id, context.guard.spaceIds);
            await record(context.guard);
          }
          const messages = context.available ? context.messages : [];
          const taskStatus =
            (await this.currentJob(dot.id, turn.threadId, true))?.status ??
            'none';
          const instructions = clean(
            `You are ${dot.name}. Current task status: ${taskStatus}. This reply does not queue or start work. Do not repeat earlier task receipts as new actions. If status is approval, work is waiting for the owner, not running. Dot instructions: ${dot.instructions}. ${personalityInstruction(await platform.workspace.voiceSettings(dot.id))} You are having a local voice conversation. Voice can use the same tools and request the same permissions as chat through the task agent. Never tell the user that voice cannot access tools or that they must type their task in chat. Never claim actions or approvals occurred without a host task receipt. Supporting preferences: ${JSON.stringify(memories.map((m) => ({ title: m.title, text: m.text })))}. Current page: ${page ? page.title : 'none'}.`,
            2400,
          );
          const recent = recentHistory(messages, turn.messageId, 5600);
          await check();
          speech = await turn.native.respond(
            turn.audio,
            { caption: understanding.text, instructions, history: recent },
            signal,
          );
        }
        await check();
        return { id: assistantMessageId, text: speech.text };
      },
    );
    await this.run(
      agent,
      {
        threadId: turn.threadId,
        runId: randomUUID(),
        messages: [
          { id: turn.messageId, role: 'user', content: understanding.text },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      turn.signal,
    );
    if (!speech) throw Error('Native response was not saved.');
    return {
      ...speech,
      assistantMessageId,
      ...(reviewFolders ? { reviewFolders } : {}),
    };
  }
  private dispatch(job: VoiceDelegation) {
    const agent = new DotAgent(
      this.platform.store,
      this.platform.workspace,
      this.platform.config,
      job.dotId,
      false,
      this.platform.setupTelemetry,
      this.platform.memory,
      this.coordinator.jobs,
      this.platform.openWebsite,
      this.platform.abilities,
    );
    const work = this.run(agent, {
      threadId: job.workerThreadId,
      runId: randomUUID(),
      messages: [
        { id: `voice-task:${job.id}`, role: 'user', content: job.request },
      ],
      tools: delegatedApprovalTools,
      context: [],
      state: {},
      forwardedProps: {},
    })
      .catch(() => {})
      .finally(() => {
        this.dispatches.delete(work);
      });
    this.dispatches.add(work);
  }
  async cancel(id: string) {
    const job = await this.coordinator.jobs.get(id);
    if (!job) throw Error('Voice task not found.');
    await this.platform.workspace.requireThread(job.parentThreadId, job.dotId);
    return await this.platform.maintenance.runWrite(
      new AbortController().signal,
      async () => {
        const cancelled = await this.coordinator.jobs.cancel(id);
        await this.runner.stop({
          threadId: job.workerThreadId,
          ...(job.runId ? { runId: job.runId } : {}),
        });
        return cancelled;
      },
    );
  }
  async list(threadId: string) {
    await this.platform.workspace.requireThread(threadId);
    return this.coordinator.jobs.list({ parentThreadId: threadId });
  }
  private deliverReceipts(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.delivering) return this.delivering;
    const work = this.platform.maintenance
      .runWrite(
        new AbortController().signal,
        async () => {
          await this.coordinator.reconcile();
          await this.coordinator.jobs.expireApprovals();
          for (const job of await this.coordinator.jobs.list()) {
            if (this.closed) break;
            if (
              job.deliveredAt ||
              job.status === 'queued' ||
              job.status === 'running'
            )
              continue;
            if (await this.runner.isRunning({ threadId: job.parentThreadId }))
              continue;
            let delivered = job;
            const receiptId = voiceJobReceipt(job).id;
            await this.run(
              new NativeConversationAgent(
                job.dotId,
                async (_input, _signal, record) => {
                  delivered = await this.permittedReceipt(job, record);
                  return voiceJobReceipt(delivered);
                },
              ),
              {
                threadId: job.parentThreadId,
                runId: randomUUID(),
                messages: [],
                tools: [],
                context: [],
                state: {},
                forwardedProps: {},
              },
            );
            await this.coordinator.jobs.markDelivered(job.id, receiptId, {
              status: job.status,
              generation: job.leaseGeneration,
            });
            for (const listener of this.updates) {
              try {
                listener(delivered);
              } catch {
                /* Replay remains available in chat. */
              }
            }
          }
        },
        { background: true },
      )
      .catch(() => {})
      .finally(() => {
        if (this.delivering === work) this.delivering = undefined;
      });
    this.delivering = work;
    return work;
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.updates.clear();
    await this.delivering;
  }
}
