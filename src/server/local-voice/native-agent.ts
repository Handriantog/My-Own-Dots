import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from '@ag-ui/client';
import { Observable } from 'rxjs';
import type { EvidenceGuard } from '../../shared/memory.js';

/** Internal agent only. Canonical writes still pass through LocalAgentRunner. */
export class NativeConversationAgent extends AbstractAgent {
  private controller?: AbortController;
  private recorder?: (guard: EvidenceGuard) => Promise<void>;
  constructor(
    dotId: string,
    private generate: (
      input: RunAgentInput,
      signal: AbortSignal,
      record: (guard: EvidenceGuard) => Promise<void>,
    ) => Promise<{ id: string; text: string }>,
    readonly evidenceGuard: (
      threadId: string,
    ) => Promise<EvidenceGuard> = async () => ({
      originDotId: dotId,
      spaceIds: [],
      pageIds: [],
    }),
  ) {
    super({ agentId: dotId });
  }
  setEvidenceRecorder(record?: (guard: EvidenceGuard) => Promise<void>) {
    this.recorder = record;
  }
  abortRun() {
    this.controller?.abort(new Error('Native conversation stopped.'));
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      this.controller = controller;
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      void this.generate(input, controller.signal, async (guard) => {
        if (!this.recorder)
          throw Error('Native evidence recording is unavailable.');
        await this.recorder(guard);
      })
        .then((answer) => {
          controller.signal.throwIfAborted();
          if (!input.messages.some((message) => message.id === answer.id)) {
            if (!answer.text.trim() || answer.text.length > 16000)
              throw Error('Native answer exceeds limits.');
            subscriber.next({
              type: EventType.TEXT_MESSAGE_START,
              messageId: answer.id,
              role: 'assistant',
            });
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: answer.id,
              delta: answer.text,
            });
            subscriber.next({
              type: EventType.TEXT_MESSAGE_END,
              messageId: answer.id,
            });
          }
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          });
          subscriber.complete();
        })
        .catch((error: unknown) => subscriber.error(error));
      return () => controller.abort();
    });
  }
}
