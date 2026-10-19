import type { MaintenanceGate } from './storage/maintenance.js';
import { memoryMetrics } from './memory-metrics.js';
import type { EvidenceGuard } from '../shared/memory.js';
import {
  AbstractAgent,
  EventType,
  transformChunks,
  verifyEvents,
  type BaseEvent,
  type RunAgentInput,
} from '@ag-ui/client';
import {
  AgentRunner,
  finalizeRunEvents,
  type AgentRunnerConnectRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type AgentRunnerIsRunningRequest,
} from '@copilotkit/runtime/v2';
import {
  Observable,
  ReplaySubject,
  concatMap,
  materialize,
  dematerialize,
  type Subscription,
} from 'rxjs';
import {
  mergeInputMessages,
  replayRun,
  type LocalConversationStore,
  type ThreadLease,
} from './local-conversations.js';

interface EvidenceAgent extends AbstractAgent {
  evidenceGuard?(threadId: string): EvidenceGuard;
  setEvidenceRecorder?(record?: (guard: EvidenceGuard) => Promise<void>): void;
  onPersistedEvent?(input: RunAgentInput, event: BaseEvent): void;
  onRunSettled?(input: RunAgentInput, failed: boolean): void;
  onRunRequested?(input: RunAgentInput): void;
}
interface ActiveRun {
  runId: string;
  agent: AbstractAgent;
  subject: ReplaySubject<BaseEvent>;
  events: BaseEvent[];
  stopRequested: boolean;
  activityController: AbortController;
  toolStarts: Map<string, number>;
  storageFailed: boolean;
  pendingWrite?: Promise<BaseEvent>;
  done: Promise<void>;
}
const isTerminal = (event: BaseEvent) =>
  event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;
const runError = (error: unknown): BaseEvent => ({
  type: EventType.RUN_ERROR,
  code: 'LOCAL_CONVERSATION_ERROR',
  message:
    error instanceof Error
      ? error.message
      : 'Local conversation storage or execution failed.',
});

/** SSE ownership lives here; all conversation authority and locks live in PostgreSQL. */
export class LocalAgentRunner extends AgentRunner {
  private active = new Map<string, ActiveRun>();
  private installed = new WeakMap<
    AbstractAgent,
    { active?: ActiveRun; lease?: ThreadLease }
  >();
  private closed = false;
  constructor(
    readonly store: LocalConversationStore,
    private activity?: {
      enterForeground(
        signal: AbortSignal,
        threadId?: string,
      ): Promise<() => void>;
    },
    private maintenance?: MaintenanceGate,
  ) {
    super();
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    (request.agent as EvidenceAgent).onRunRequested?.(request.input);
    const subject = new ReplaySubject<BaseEvent>();
    if (this.closed || this.active.has(request.threadId)) {
      subject.next(
        runError(
          new Error(
            this.closed
              ? 'Conversation runner is closed.'
              : 'Thread already running.',
          ),
        ),
      );
      subject.complete();
      return subject.asObservable();
    }
    const active: ActiveRun = {
      runId: request.input.runId,
      agent: request.agent,
      subject,
      events: [],
      stopRequested: false,
      activityController: new AbortController(),
      toolStarts: new Map(),
      storageFailed: false,
      done: Promise.resolve(),
    };
    this.active.set(request.threadId, active);
    active.done = (
      this.maintenance
        ? this.maintenance.runWrite(active.activityController.signal, () =>
            this.execute(request, active),
          )
        : this.execute(request, active)
    ).catch((error: unknown) => {
      this.active.delete(request.threadId);
      subject.next(runError(error));
      subject.complete();
    });
    return subject.asObservable();
  }

  private installPersistence(agent: AbstractAgent) {
    let binding = this.installed.get(agent);
    if (binding) return binding;
    binding = {};
    this.installed.set(agent, binding);
    const current = binding;
    agent.use((input, next) =>
      next.run(input).pipe(
        transformChunks(),
        verifyEvents(),
        // Queue provider completion/errors behind every already-received write.
        materialize(),
        concatMap((notification) => {
          if (notification.kind !== 'N') return Promise.resolve(notification);
          const event = notification.value;
          const { active, lease } = current;
          if (!active || !lease)
            throw new Error('Conversation persistence is unavailable.');
          const persisted =
            event.type === EventType.RUN_STARTED ? { ...event, input } : event;
          const write = async () => {
            try {
              lease.signal.throwIfAborted();
              if (!isTerminal(persisted)) await lease.appendEvent(persisted);
            } catch {
              active.storageFailed = true;
              agent.abortRun();
              throw new Error(
                'Conversation storage failed. This turn was stopped; unsaved output was not delivered.',
              );
            }
            if (
              persisted.type === EventType.TOOL_CALL_START &&
              'toolCallId' in persisted
            )
              active.toolStarts.set(
                String(persisted.toolCallId),
                performance.now(),
              );
            if (
              persisted.type === EventType.TOOL_CALL_RESULT &&
              'toolCallId' in persisted
            ) {
              const key = String(persisted.toolCallId),
                began = active.toolStarts.get(key);
              if (began !== undefined) {
                memoryMetrics.observe(
                  'tools',
                  performance.now() - began,
                  false,
                );
                active.toolStarts.delete(key);
              }
            }
            active.events.push(structuredClone(persisted));
            if (!isTerminal(persisted))
              (agent as EvidenceAgent).onPersistedEvent?.(input, persisted);
            if (!isTerminal(persisted)) active.subject.next(persisted);
            return persisted;
          };
          active.pendingWrite = write();
          return active.pendingWrite.then(() => notification);
        }),
        dematerialize(),
      ),
    );
    return binding;
  }

  private async execute(request: AgentRunnerRunRequest, active: ActiveRun) {
    const turnStarted = performance.now();
    let lease: ThreadLease | null = null;
    let begun = false;
    let releaseForeground: (() => void) | undefined;
    let failure: unknown;
    let binding: { active?: ActiveRun; lease?: ThreadLease } | undefined;
    const onStorageLost = () => {
      active.storageFailed = true;
      active.agent.abortRun();
      void active.agent.detachActiveRun();
    };
    let canonicalInput = request.input;
    try {
      if (request.threadId !== request.input.threadId)
        throw new Error('Conversation scope mismatch.');
      releaseForeground = await this.activity?.enterForeground(
        active.activityController.signal,
        request.threadId,
      );
      await this.store.getOrCreateThread({
        threadId: request.threadId,
        userId: this.store.ownerId,
        agentId: request.agent.agentId ?? 'default',
      });
      lease = await this.store.acquireThread(request.threadId);
      if (!lease) throw new Error('Thread already running in another process.');
      lease.signal.addEventListener('abort', onStorageLost, { once: true });
      let snapshot = await lease.read();
      if (snapshot.lastRun?.status === 'running') {
        const prior = snapshot.lastRun;
        const events = structuredClone(prior.events);
        for (const event of finalizeRunEvents(events, {
          interruptionMessage:
            'Server stopped during this run. Review completed effects before retrying.',
        }))
          await lease.appendEvent(event);
        const recovered = await replayRun(prior.input, events);
        await lease.finishRun(
          recovered.messages,
          recovered.state,
          'interrupted',
        );
        snapshot = await lease.read();
      }
      const messages = mergeInputMessages(
        snapshot.messages,
        request.persistedInputMessages ?? request.input.messages,
      );
      const input = { ...request.input, messages, state: snapshot.state };
      canonicalInput = input;
      const evidenceAgent = request.agent as EvidenceAgent;
      await lease.beginRun(
        input,
        evidenceAgent.evidenceGuard?.(request.threadId),
      );
      evidenceAgent.setEvidenceRecorder?.(async (guard) => {
        if (!lease?.addEvidenceGuard)
          throw new Error('Evidence storage is unavailable');
        await lease.addEvidenceGuard(guard);
      });
      begun = true;
      if (active.stopRequested) throw new Error('Run stopped by user.');
      request.agent.threadId = request.threadId;
      request.agent.setMessages(messages);
      request.agent.setState(snapshot.state);
      if (snapshot.lastRun)
        request.agent.pendingInterrupts = (
          await replayRun(snapshot.lastRun.input, snapshot.lastRun.events)
        ).pendingInterrupts;
      binding = this.installPersistence(request.agent);
      if (binding.active) throw new Error('Agent instance is already running.');
      binding.active = active;
      binding.lease = lease;
      let runFailure: unknown;
      try {
        await request.agent.runAgent(input);
      } catch (error) {
        runFailure = error;
      }
      // RxJS detach cancels delivery, not an already-started PostgreSQL query.
      // Retain the advisory lock until that durable write has settled.
      try {
        await active.pendingWrite;
      } catch (error) {
        runFailure ??= error;
      }
      if (active.storageFailed)
        throw new Error(
          'Conversation storage failed. This turn was stopped; unsaved output was not delivered.',
        );
      if (active.stopRequested && !active.events.length) {
        const start = {
          type: EventType.RUN_STARTED,
          threadId: request.threadId,
          runId: active.runId,
        };
        await lease.appendEvent(start);
        active.events.push(start);
        active.subject.next(start);
      }
      const appended = finalizeRunEvents([...active.events], {
        stopRequested: active.stopRequested,
        ...(runFailure
          ? {
              interruptionMessage:
                runFailure instanceof Error
                  ? runFailure.message
                  : 'Agent run failed.',
            }
          : {}),
      });
      for (const raw of appended) {
        const event =
          raw.type === EventType.RUN_FINISHED
            ? { ...raw, threadId: request.threadId, runId: active.runId }
            : raw;
        if (!isTerminal(event)) await lease.appendEvent(event);
        active.events.push(event);
        if (!isTerminal(event)) active.subject.next(event);
      }
      const final = await replayRun(input, active.events);
      const failed = active.events.some(
        (event) => event.type === EventType.RUN_ERROR,
      );
      await lease.finishRun(
        final.messages,
        final.state,
        active.stopRequested ? 'stopped' : failed ? 'failed' : 'finished',
        active.events.at(-1),
      );
    } catch (error) {
      failure = error;
      // Input/connection errors never start a provider. Storage failures leave
      // the saved prefix marked running, so restart recovery reports interruption.
      if (begun && !active.storageFailed && lease && active.stopRequested) {
        try {
          if (!active.events.length) {
            const start = {
              type: EventType.RUN_STARTED,
              threadId: request.threadId,
              runId: active.runId,
            };
            await lease.appendEvent(start);
            active.events.push(start);
            active.subject.next(start);
          }
          for (const raw of finalizeRunEvents([...active.events], {
            stopRequested: true,
          })) {
            const event =
              raw.type === EventType.RUN_FINISHED
                ? { ...raw, threadId: request.threadId, runId: active.runId }
                : raw;
            if (!isTerminal(event)) await lease.appendEvent(event);
            active.events.push(event);
            if (!isTerminal(event)) active.subject.next(event);
          }
          const snapshot = await lease.read();
          await lease.finishRun(
            snapshot.messages,
            snapshot.state,
            'stopped',
            active.events.at(-1),
          );
          failure = undefined;
        } catch {
          failure = new Error('Conversation storage failed while stopping.');
        }
      }
    } finally {
      (request.agent as EvidenceAgent).setEvidenceRecorder?.(undefined);
      if (binding?.active === active) {
        binding.active = undefined;
        binding.lease = undefined;
      }
      lease?.signal.removeEventListener('abort', onStorageLost);
      try {
        await lease?.release();
      } catch {
        failure ??= new Error(
          'Conversation storage connection could not be released.',
        );
      }
      releaseForeground?.();
      memoryMetrics.observe('turn', performance.now() - turnStarted, false);
      this.active.delete(request.threadId);
      try {
        (request.agent as EvidenceAgent).onRunSettled?.(
          canonicalInput,
          Boolean(
            failure ||
            active.storageFailed ||
            active.stopRequested ||
            active.events.some((event) => event.type === EventType.RUN_ERROR),
          ),
        );
      } catch {
        failure ??= new Error('Voice delivery cleanup failed.');
      }
      if (failure) active.subject.next(runError(failure));
      else if (active.events.length) active.subject.next(active.events.at(-1)!);
      active.subject.complete();
    }
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      let subscription: Subscription | undefined;
      const active = this.active.get(request.threadId);
      void (async () => {
        const snapshot = await this.store.getSnapshot(request.threadId);
        if (subscriber.closed) return;
        const replayId = `replay:${snapshot.lastRun?.runId ?? request.threadId}`;
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: request.threadId,
          runId: replayId,
        });
        if (active && snapshot.lastRun?.runId === active.runId) {
          // Replay from the active run's input; replaying its deltas over the
          // final snapshot would duplicate partially streamed text.
          subscriber.next({
            type: EventType.MESSAGES_SNAPSHOT,
            messages: snapshot.lastRun.input.messages,
          });
          subscriber.next({
            type: EventType.STATE_SNAPSHOT,
            snapshot: snapshot.lastRun.input.state,
          });
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: request.threadId,
            runId: replayId,
          });
          subscription = active.subject.subscribe(subscriber);
        } else {
          subscriber.next({
            type: EventType.MESSAGES_SNAPSHOT,
            messages: snapshot.messages,
          });
          subscriber.next({
            type: EventType.STATE_SNAPSHOT,
            snapshot: snapshot.state,
          });
          const terminal = snapshot.lastRun?.events.at(-1);
          if (terminal?.type === EventType.RUN_ERROR) subscriber.next(terminal);
          else
            subscriber.next({
              ...(terminal?.type === EventType.RUN_FINISHED ? terminal : {}),
              type: EventType.RUN_FINISHED,
              threadId: request.threadId,
              runId: replayId,
            });
          subscriber.complete();
        }
      })().catch((error: unknown) => {
        subscriber.next(runError(error));
        subscriber.complete();
      });
      return () => subscription?.unsubscribe();
    });
  }
  async isRunning(request: AgentRunnerIsRunningRequest) {
    return (
      this.active.has(request.threadId) ||
      (await this.store.isRunning(request.threadId))
    );
  }
  async stop(request: AgentRunnerStopRequest) {
    const active = this.active.get(request.threadId);
    if (
      !active ||
      active.stopRequested ||
      (request.runId !== undefined && request.runId !== active.runId)
    )
      return false;
    active.stopRequested = true;
    active.activityController.abort(new Error('Run stopped by user'));
    active.agent.abortRun();
    await active.agent.detachActiveRun();
    await active.done;
    return true;
  }
  async close() {
    this.closed = true;
    await Promise.all(
      [...this.active.keys()].map((threadId) => this.stop({ threadId })),
    );
  }
}
