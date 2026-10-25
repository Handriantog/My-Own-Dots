import { logError } from '../../shared/error-log.js';
import { listenTaskProgress } from './task-progress.js';
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
import { codexCoordinator } from '../codex-runtime.js';
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
  NativeTurnReply,
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
/** Only task controls bypass the shared agent; ordinary intent is never classified locally. */
export function voiceTaskControl(text: string): 'stop' | 'status' | undefined {
  const control = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '');
  // The pinned recognizer sometimes hears "Cancel the" as "Canceled a".
  if (
    /^(?:please )?(?:stop|cancel|canceled|cancelled) (?:the |my |a )?(?:current )?(?:task|work)$/.test(
      control,
    )
  )
    return 'stop';
  if (
    /^(?:task status|what(?:'s| is) the (?:task )?status|are you (?:still )?(?:working|running))$/.test(
      control,
    )
  )
    return 'status';
  return undefined;
}
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
export function voiceJobReceipt(job: VoiceDelegation, sharedExecution = false) {
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
      .replace(/```(?:text|txt|plaintext)[ \t]*\n([\s\S]*?)```/gi, '$1')
      .replace(/```[\s\S]*?```/g, ' Code is in the task conversation. ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'link in chat')
      .replace(/[*_`#]/g, ''),
    280,
  ).trim();
  const spoken =
    result && !/^[{[]|<(?:think|analysis|tool_call)\b/i.test(result)
      ? `${sharedExecution ? '' : 'Your task finished. '}${excerpt}${result.length > 280 ? ' More details are in chat.' : ''}`
      : label;
  return {
    id: `voice-job:${job.id}:${job.leaseGeneration}:${job.status}`,
    text: `${sharedExecution && result ? result.slice(0, 12000) : `${label}${result ? `\n\n${result.slice(0, 12000)}` : ''}`}\n\n${link}`,
    spoken,
  };
}
export type VoiceTaskProgress = {
  id: string;
  job: VoiceDelegation;
  text: string;
  authorize: () => Promise<boolean>;
};
export class NativeVoiceRuntime {
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private delivering?: Promise<void>;
  private dispatches = new Set<Promise<void>>();
  private dispatchingDots = new Set<string>();
  private dispatchControllers = new Map<string, AbortController>();
  private scheduling = false;
  private inputDelivery?: Promise<void>;
  private inputController = new AbortController();
  private detachProgress?: () => void;
  private progressDelivery: Promise<void> = Promise.resolve();
  private readonly progressUpdates = new Set<
    (progress: VoiceTaskProgress) => void
  >();
  private readonly updates = new Set<
    (job: VoiceDelegation, retainUntilPlayed?: boolean) => void
  >();
  constructor(
    private platform: Platform,
    private runner: LocalAgentRunner,
    readonly coordinator: VoiceDelegationCoordinator,
  ) {}
  async start() {
    await this.coordinator.recover();
    this.detachProgress = listenTaskProgress(
      this.platform.workspace,
      (input, messageId) => {
        this.progressDelivery = this.progressDelivery
          .then(() => this.deliverProgress(input, messageId))
          .catch((error) =>
            logError('voice_progress_failed', error, {
              threadId: input.threadId,
              runId: input.runId,
            }),
          );
      },
    );
    this.timer = setInterval(() => {
      void this.deliverReceipts();
      void this.dispatchQueued();
      void this.deliverInputs();
    }, 1000);
    this.timer.unref?.();
  }
  listen(
    listener: (job: VoiceDelegation, retainUntilPlayed?: boolean) => void,
  ) {
    this.updates.add(listener);
    return () => {
      this.updates.delete(listener);
    };
  }
  listenProgress(listener: (progress: VoiceTaskProgress) => void) {
    this.progressUpdates.add(listener);
    return () => {
      this.progressUpdates.delete(listener);
    };
  }
  private async progressText(
    job: VoiceDelegation,
    runId: string,
    messageId: string,
  ) {
    const context = await this.coordinator.jobs.threadContext(
      job.workerThreadId,
      job.dotId,
    );
    if (!context.available) return;
    const snapshot = await this.platform.localConversations!.getSnapshot(
      job.workerThreadId,
    );
    if (snapshot.lastRun?.runId !== runId) return;
    let text = '',
      started = false,
      ended = false;
    for (const event of snapshot.lastRun.events) {
      if (!('messageId' in event) || event.messageId !== messageId) continue;
      if (
        event.type === EventType.TEXT_MESSAGE_START &&
        'role' in event &&
        event.role === 'assistant'
      )
        started = true;
      if (
        started &&
        !ended &&
        event.type === EventType.TEXT_MESSAGE_CONTENT &&
        'delta' in event
      )
        text += String(event.delta);
      if (started && event.type === EventType.TEXT_MESSAGE_END) ended = true;
    }
    if (!ended || !text.trim()) return;
    const projected = await this.platform.memory!.repository.modelMessages(
      job.workerThreadId,
      [{ id: messageId, role: 'assistant', content: text }],
    );
    return projected.some(
      (message) => message.id === messageId && message.content === text,
    )
      ? text
      : undefined;
  }
  private async deliverProgress(input: RunAgentInput, messageId: string) {
    if (
      this.closed ||
      !this.progressUpdates.size ||
      this.platform.config.agentEngine !== 'codex'
    )
      return;
    const job = await this.coordinator.jobs.forThread(input.threadId);
    if (
      !job ||
      job.runId !== input.runId ||
      !['running', 'approval', 'completed'].includes(job.status)
    )
      return;
    const suppression =
      await this.platform.workspace.memory.suppressionGeneration();
    const scope = JSON.stringify(await this.taskScope(job));
    const text = await this.progressText(job, input.runId, messageId);
    if (!text) return;
    const authorize = async () => {
      try {
        if (
          this.closed ||
          (await this.platform.workspace.memory.suppressionGeneration()) !==
            suppression
        )
          return false;
        const current = await this.coordinator.jobs.get(job.id);
        return (
          !!current &&
          current.runId === input.runId &&
          current.leaseGeneration === job.leaseGeneration &&
          ['running', 'approval', 'completed'].includes(current.status) &&
          (await this.progressText(current, input.runId, messageId)) === text &&
          JSON.stringify(await this.taskScope(job)) === scope
        );
      } catch {
        return false;
      }
    };
    const spoken = voiceJobReceipt(
      { ...job, status: 'completed', result: text },
      true,
    ).spoken;
    for (const listener of this.progressUpdates) {
      try {
        listener({
          id: `voice-progress:${job.id}:${job.leaseGeneration}:${messageId}`,
          job,
          text: spoken,
          authorize,
        });
      } catch {
        /* Saved prose remains in the task conversation. */
      }
    }
  }
  private async currentJob(
    dotId: string,
    threadId: string,
    includeOtherThreads = false,
  ) {
    const jobs = await this.coordinator.jobs.list();
    return (
      (this.platform.config.agentEngine === 'codex'
        ? jobs.find((job) => job.dotId === dotId && job.status === 'running')
        : undefined) ??
      jobs.findLast(
        (job) =>
          job.dotId === dotId &&
          job.parentThreadId === threadId &&
          job.status === 'approval',
      ) ??
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
  private async taskScope(job: VoiceDelegation) {
    // Codex snapshots the parent default at admission. Only its task binding
    // governs subsequent execution and speech, including permission recovery.
    return this.platform.workspace.folders.executionScope(
      job.dotId,
      this.platform.config.agentEngine === 'codex'
        ? job.workerThreadId
        : job.parentThreadId,
    );
  }
  /** Playback must remain authorized even while a reply is muted or synthesizing. */
  async receiptValidator(
    job: VoiceDelegation,
  ): Promise<() => Promise<boolean>> {
    const suppression =
      await this.platform.workspace.memory.suppressionGeneration();
    const scope = await this.taskScope(job);
    const expected = JSON.stringify({
      status: job.status,
      generation: job.leaseGeneration,
      result: job.result,
    });
    return async () => {
      try {
        if (
          this.closed ||
          (await this.platform.workspace.memory.suppressionGeneration()) !==
            suppression
        )
          return false;
        const current = await this.coordinator.jobs.get(job.id);
        if (!current) return false;
        const context = await this.coordinator.jobs.threadContext(
          current.workerThreadId,
          current.dotId,
        );
        if (!context.available) return false;
        const projected = await this.permittedReceipt(current, async () => {});
        if (
          JSON.stringify({
            status: projected.status,
            generation: projected.leaseGeneration,
            result: projected.result,
          }) !== expected
        )
          return false;
        return (
          JSON.stringify(await this.taskScope(job)) === JSON.stringify(scope)
        );
      } catch {
        return false;
      }
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
  async turn(turn: NativeTurn, admitted = false): Promise<NativeTurnReply> {
    if (this.closed) throw Error('Native voice is closed.');
    const { platform } = this;
    await platform.workspace.requireThread(turn.threadId, turn.dotId);
    if ((await platform.workspace.call(turn.callId)).threadId !== turn.threadId)
      throw Error('Native call scope mismatch.');
    const execution = platform.config.agentEngine === 'codex';
    const control = execution
      ? voiceTaskControl(turn.understanding.text)
      : undefined;
    const stopTask = control === 'stop';
    const status = control === 'status';
    const understanding: NativeUnderstanding =
      execution && turn.understanding.text.trim()
        ? status
          ? { text: turn.understanding.text, route: 'status' }
          : {
              text: turn.understanding.text,
              route: 'delegate',
              tool: {
                name: 'delegate_task',
                arguments: { request: turn.understanding.text },
              },
            }
        : turn.understanding;
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
    if (
      execution &&
      !admitted &&
      (control || (await this.runner.isRunning({ threadId: turn.threadId })))
    )
      return this.receiveInput(turn, control ?? 'request');
    let queueAccepted = true;
    let speech: NativeSpeech | undefined;
    let awaitingReply = false;
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
        if (stopTask) {
          await check();
          const active = codexCoordinator(platform.workspace).status(dot.id);
          const jobs = await this.coordinator.jobs.list({ active: true });
          const job =
            jobs.find(
              (job) => job.dotId === dot.id && job.status !== 'queued',
            ) ?? jobs.find((job) => job.dotId === dot.id);
          if (active.activeThreadId && active.activeRunId) {
            // Queue the stop without blocking local speech on the model process.
            void this.runner
              .stop({
                threadId: active.activeThreadId,
                runId: active.activeRunId,
              })
              .catch(() => {});
          } else if (job) await this.cancel(job.id);
          speech = await turn.native.speak(
            active.activeRunId || job
              ? 'Stop requested. Review recorded actions in chat.'
              : 'There is no active task to stop.',
            signal,
          );
        } else if (understanding.route === 'delegate') {
          await check();
          const prior = (
            await this.coordinator.jobs.list({ callId: turn.callId })
          ).find((job) => job.utteranceId === turn.messageId);
          const queued = await this.coordinator.jobs.enqueue(
            {
              id: prior?.id ?? randomUUID(),
              dotId: dot.id,
              callId: turn.callId,
              parentThreadId: turn.threadId,
              workerThreadId: prior?.workerThreadId ?? randomUUID(),
              utteranceId: turn.messageId,
              sourceMessageId: turn.messageId,
              sourceText: understanding.text,
              request: understanding.tool!.arguments.request,
            },
            execution,
          );
          queueAccepted = queued.kind !== 'busy';
          if (queued.kind === 'created') {
            if (execution) void this.dispatchQueued();
            else this.dispatch(queued.job);
          }
          reviewFolders = queued.job.status === 'approval';
          if (execution && queued.kind !== 'busy') {
            // Admission is durable, but it is not a conversational answer.
            awaitingReply = true;
            speech = { text: '', pcm: Buffer.alloc(0) };
          } else
            speech = await turn.native.speak(
              execution
                ? 'The request queue is full. Please wait for the current work.'
                : queued.kind === 'busy'
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
          const active = execution
            ? codexCoordinator(platform.workspace).status(dot.id)
            : undefined;
          const text = active?.activeRunId
            ? 'Your task is still running.'
            : !job
              ? 'There is no recent task in this conversation.'
              : job.status === 'running'
                ? 'Your task is still running.'
                : job.status === 'queued'
                  ? 'Your task is queued.'
                  : voiceJobReceipt(job, execution).spoken;
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
        return awaitingReply
          ? null
          : { id: assistantMessageId, text: speech.text };
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
    if (admitted && !queueAccepted)
      throw Error('Accepted voice input is waiting for queue capacity.');
    if (!speech) throw Error('Native response was not saved.');
    return {
      ...speech,
      assistantMessageId,
      ...(awaitingReply ? { awaitingReply: true } : {}),
      ...(reviewFolders ? { reviewFolders } : {}),
    };
  }
  private async receiveInput(
    turn: NativeTurn,
    kind: 'request' | 'status' | 'stop',
  ): Promise<NativeTurnReply> {
    turn.signal.throwIfAborted();
    const initial = await runtimePolicy(
      this.platform.store,
      this.platform.workspace,
    ).turnState(turn.dotId);
    if (!initial.dot || (initial.settings.paused && kind !== 'stop'))
      throw Error('Dot is unavailable.');
    const active = codexCoordinator(this.platform.workspace).status(turn.dotId);
    const parent = await this.platform.localConversations!.getSnapshot(
      turn.threadId,
    );
    const typedRunning = await this.runner.isRunning({
      threadId: turn.threadId,
    });
    const job = await this.currentJob(turn.dotId, turn.threadId, true);
    const pending = (await this.coordinator.jobs.pendingInputs()).find(
      (row) =>
        row.dotId === turn.dotId &&
        row.kind === 'request' &&
        row.status === 'received',
    );
    const running = !!active.activeRunId || typedRunning;
    const hasTask =
      running ||
      pending ||
      (job && ['queued', 'running', 'approval'].includes(job.status));
    const reply =
      kind === 'request'
        ? ''
        : kind === 'stop'
          ? hasTask
            ? 'Stop requested. Review recorded actions in chat.'
            : 'There is no active task to stop.'
          : job?.status === 'approval'
            ? 'Your task is waiting for approval.'
            : running || job?.status === 'running'
              ? 'Your task is still running.'
              : pending || job?.status === 'queued'
                ? 'Your task is queued.'
                : 'There is no active task. Previous results are in chat.';
    // The intent and acknowledgement must exist before a stop can affect work.
    const accepted = await this.coordinator.jobs.receiveInput({
      id: turn.messageId,
      dotId: turn.dotId,
      callId: turn.callId,
      parentThreadId: turn.threadId,
      caption: turn.understanding.text,
      kind,
      reply,
    });
    if (accepted.created && kind === 'stop') {
      if (active.activeThreadId && active.activeRunId)
        void this.runner
          .stop({ threadId: active.activeThreadId, runId: active.activeRunId })
          .catch(() => {});
      else if (typedRunning && parent.lastRun)
        void this.runner
          .stop({ threadId: turn.threadId, runId: parent.lastRun.runId })
          .catch(() => {});
      else if (job && ['queued', 'running', 'approval'].includes(job.status))
        void this.cancel(job.id).catch(() => {});
      else if (pending) {
        const converted = await this.coordinator.jobs.cancelInput(pending.id);
        if (converted?.status === 'running')
          void this.cancel(converted.id).catch(() => {});
      }
    }
    const speech =
      kind === 'request'
        ? { text: '', pcm: Buffer.alloc(0) }
        : await turn.native.speak(accepted.receipt.reply, turn.signal);
    return {
      ...speech,
      assistantMessageId: `voice-input:${turn.messageId}`,
      ...(kind === 'request' ? { awaitingReply: true } : {}),
      ...(job?.status === 'approval' ? { reviewFolders: true } : {}),
    };
  }
  private deliverInputs(): Promise<void> {
    if (this.closed || this.platform.config.agentEngine !== 'codex')
      return Promise.resolve();
    if (this.inputDelivery) return this.inputDelivery;
    const work = (async () => {
      for (const receipt of await this.coordinator.jobs.pendingInputs()) {
        if (this.closed) break;
        if (await this.runner.isRunning({ threadId: receipt.parentThreadId }))
          continue;
        const input = {
          threadId: receipt.parentThreadId,
          runId: randomUUID(),
          messages: [
            { id: receipt.id, role: 'user' as const, content: receipt.caption },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        };
        try {
          if (receipt.kind === 'request' && receipt.status === 'received') {
            // Mirror an accepted caption once the parent is free. This enqueues the
            // ordinary durable job; it does not bypass the shared execution engine.
            await this.turn(
              {
                callId: receipt.callId,
                dotId: receipt.dotId,
                threadId: receipt.parentThreadId,
                messageId: receipt.id,
                audio: Buffer.alloc(0),
                understanding: { text: receipt.caption, route: 'chat' },
                signal: this.inputController.signal,
                native: {
                  warm: async () => {},
                  close: async () => {},
                  interpret: async () => {
                    throw Error('Unexpected ASR replay');
                  },
                  respond: async () => {
                    throw Error('Unexpected local reply');
                  },
                  speak: async (text) => ({ text, pcm: Buffer.alloc(0) }),
                },
              },
              true,
            );
          } else {
            await this.run(
              new NativeConversationAgent(receipt.dotId, async () =>
                receipt.reply
                  ? {
                      id: `voice-input:${receipt.id}`,
                      text: receipt.reply,
                    }
                  : null,
              ),
              input,
              this.inputController.signal,
            );
          }
          await this.coordinator.jobs.deliverInput(receipt.id);
        } catch {
          /* A racing parent run or temporary storage failure leaves the receipt durable. */
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (this.inputDelivery === work) this.inputDelivery = undefined;
      });
    this.inputDelivery = work;
    return work;
  }
  private dispatch(job: VoiceDelegation) {
    if (this.closed) return;
    const execution = this.platform.config.agentEngine === 'codex';
    if (execution && this.dispatchingDots.has(job.dotId)) return;
    if (execution) this.dispatchingDots.add(job.dotId);
    const runId = randomUUID();
    const controller = new AbortController();
    this.dispatchControllers.set(job.id, controller);
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
      execution ? runId : undefined,
    );
    const run = () =>
      this.run(
        agent,
        {
          threadId: job.workerThreadId,
          runId,
          messages: [
            { id: `voice-task:${job.id}`, role: 'user', content: job.request },
          ],
          tools: delegatedApprovalTools,
          context: [],
          state: {},
          forwardedProps: {},
        },
        controller.signal,
      );
    const work = (
      execution
        ? codexCoordinator(this.platform.workspace).run(
            job.dotId,
            runId,
            controller.signal,
            run,
            job.workerThreadId,
          )
        : run()
    )
      .catch(() => {})
      .finally(async () => {
        this.dispatches.delete(work);
        this.dispatchControllers.delete(job.id);
        if (execution) {
          await this.deliverReceipts();
          this.dispatchingDots.delete(job.dotId);
          void this.dispatchQueued();
        }
      });
    this.dispatches.add(work);
  }
  private async dispatchQueued() {
    if (
      this.closed ||
      this.scheduling ||
      this.platform.config.agentEngine !== 'codex'
    )
      return;
    this.scheduling = true;
    try {
      const jobs = await this.coordinator.jobs.list();
      const occupied = new Set(
        jobs.filter((job) => job.status === 'running').map((job) => job.dotId),
      );
      for (const job of jobs) {
        if (this.closed) break;
        if (
          job.status === 'queued' &&
          !jobs.some(
            (prior) =>
              prior.id !== job.id &&
              prior.parentThreadId === job.parentThreadId &&
              !['queued', 'running'].includes(prior.status) &&
              !prior.receiptMessageId,
          ) &&
          !occupied.has(job.dotId) &&
          !this.dispatchingDots.has(job.dotId)
        ) {
          occupied.add(job.dotId);
          this.dispatch(job);
        }
      }
    } catch {
      /* Durable queued requests remain available after a transient read failure. */
    } finally {
      this.scheduling = false;
    }
  }
  async cancel(id: string) {
    const job = await this.coordinator.jobs.get(id);
    if (!job) throw Error('Voice task not found.');
    await this.platform.workspace.requireThread(job.parentThreadId, job.dotId);
    return await this.platform.maintenance.runWrite(
      new AbortController().signal,
      async () => {
        const current = await this.coordinator.jobs.cancel(id, true);
        if (current.status === 'cancelled')
          this.dispatchControllers.get(id)?.abort();
        await this.runner.stop({
          threadId: current.workerThreadId,
          // A waiting continuation has a new run ID which has not claimed the job yet.
          ...(current.status !== 'cancelled' && current.runId
            ? { runId: current.runId }
            : {}),
        });
        this.dispatchControllers.get(id)?.abort();
        // Active tasks settle from the persisted provider outcome. Only work
        // that never started, or an idle approval, can be cancelled directly.
        const settled = await this.coordinator.jobs.get(id);
        return settled && ['queued', 'approval'].includes(settled.status)
          ? this.coordinator.jobs.cancel(id, true)
          : settled;
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
                  return voiceJobReceipt(
                    delivered,
                    this.platform.config.agentEngine === 'codex',
                  );
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
            await this.progressDelivery;
            const context = await this.coordinator.jobs.threadContext(
              job.workerThreadId,
              job.dotId,
            );
            const retainUntilPlayed =
              delivered.status === 'completed' &&
              Boolean(delivered.result) &&
              context.available &&
              context.hasToolActivity;
            await this.coordinator.jobs.markDelivered(job.id, receiptId, {
              status: job.status,
              generation: job.leaseGeneration,
            });
            for (const listener of this.updates) {
              try {
                listener(delivered, retainUntilPlayed);
              } catch (error) {
                logError('voice_task_notification_failed', error, {
                  callId: job.callId,
                  requestId: job.id,
                });
              }
            }
          }
        },
        { background: true },
      )
      .catch((error) => logError('voice_receipt_failed', error))
      .finally(() => {
        if (this.delivering === work) this.delivering = undefined;
      });
    this.delivering = work;
    return work;
  }
  async close() {
    this.closed = true;
    this.inputController.abort();
    for (const controller of this.dispatchControllers.values())
      controller.abort();
    clearInterval(this.timer);
    this.updates.clear();
    this.detachProgress?.();
    this.progressUpdates.clear();
    await this.progressDelivery;
    await this.delivering;
    await this.inputDelivery;
  }
}
