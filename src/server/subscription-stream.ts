import type { AgentOptions, AgentResult } from 'myown-llm-integrator';

export type DecisionStreamRequest = Pick<
  AgentOptions,
  'prompt' | 'model' | 'signal' | 'timeoutMs'
> & {
  toolNames: string[];
  onText?: (record: { sequence: number; text: string }) => void | Promise<void>;
};
export interface DecisionStreamBinding {
  runDecision(options: DecisionStreamRequest): Promise<AgentResult>;
  authorizeText(assistantId: string, sequence: number, text: string): void;
}

/** One pending record, with backpressure until the consumer requests the next. */
export async function* decisionRecords(
  run: DecisionStreamBinding['runDecision'],
  options: DecisionStreamRequest,
): AsyncGenerator<
  | { kind: 'text'; sequence: number; text: string }
  | { kind: 'result'; response: AgentResult }
> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let pending: { sequence: number; text: string; ack: () => void } | undefined;
  let wake: (() => void) | undefined;
  let finished = false;
  let failure: unknown;
  let response: AgentResult | undefined;
  let nextSequence = 0;
  const onAbort = () => wake?.();
  signal.addEventListener('abort', onAbort);
  void Promise.resolve()
    .then(() =>
      run({
        ...options,
        signal,
        onText: async (record) => {
          signal.throwIfAborted();
          if (
            pending ||
            record.sequence !== nextSequence ||
            nextSequence >= 256 ||
            typeof record.text !== 'string' ||
            !record.text ||
            record.text.length > 400
          )
            throw Error('Invalid provider text sequence');
          nextSequence++;
          await new Promise<void>((resolve) => {
            pending = { ...record, ack: resolve };
            wake?.();
          });
          signal.throwIfAborted();
        },
      }),
    )
    .then(
      (value) => {
        response = value;
      },
      (error) => {
        failure = error;
      },
    )
    .finally(() => {
      finished = true;
      wake?.();
    });
  try {
    while (true) {
      signal.throwIfAborted();
      if (failure) throw failure;
      if (pending) {
        const record = pending;
        yield { kind: 'text', sequence: record.sequence, text: record.text };
        pending = undefined;
        record.ack();
      } else if (finished) {
        if (!response) throw Error('Provider returned no result');
        yield { kind: 'result', response };
        return;
      } else {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    }
  } finally {
    controller.abort();
    pending?.ack();
    signal.removeEventListener('abort', onAbort);
  }
}
