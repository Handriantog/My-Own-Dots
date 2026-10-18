import {
  decisionRecords,
  type DecisionStreamBinding,
} from './subscription-stream.js';
import { measured } from './memory-metrics.js';
import type { InferenceScheduler } from './inference-scheduler.js';
import type { AgentOptions, AgentResult } from 'myown-llm-integrator';
import type { VoiceTurnTiming } from './local-voice/timing.js';
import {
  serializeChatOptions,
  renderSubscriptionPrompt,
  subscriptionInstructions,
  type SubscriptionPayload,
  type ChatOptions,
} from './subscription-prompt.js';
import { randomUUID } from 'node:crypto';
import { EventType } from '@tanstack/ai';
import {
  BaseTextAdapter,
  type StructuredOutputOptions,
} from '@tanstack/ai/adapters';
import type {
  DefaultMessageMetadataByModality,
  StreamChunk,
  TokenUsage,
} from '@tanstack/ai';
import { runAgent } from 'myown-llm-integrator';

export interface SubscriptionConfig {
  provider?: string;
  model?: string;
  timeoutMs?: number;
  scheduler?: InferenceScheduler;
  /** Server-bound call session only; absent for the ordinary text path. */
  invoke?: (options: AgentOptions) => Promise<AgentResult>;
  stream?: DecisionStreamBinding;
  timing?: VoiceTurnTiming;
  prepare?: (
    payload: SubscriptionPayload,
    signal: AbortSignal,
  ) => Promise<SubscriptionPayload>;
}

type SubscriptionOptions = Record<string, never>;

function requestConfig(config: SubscriptionConfig) {
  return {
    provider: config.provider ?? 'codex',
    model: config.model,
    timeoutMs: config.timeoutMs,
  };
}

function abortSignal(options: ChatOptions) {
  // TanStack chat() forwards its controller through request.signal.
  return (
    options.abortController?.signal ?? options.request?.signal ?? undefined
  );
}

function decisionSchema(names: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'toolCalls'],
    properties: {
      text: { type: 'string' },
      toolCalls: {
        type: 'array',
        ...(names.length ? {} : { maxItems: 0 }),
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'argumentsJson'],
          properties: {
            name: { type: 'string', ...(names.length ? { enum: names } : {}) },
            argumentsJson: { type: 'string' },
          },
        },
      },
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseDecision(result: unknown, names: string[]) {
  if (
    !isObject(result) ||
    typeof result.text !== 'string' ||
    !Array.isArray(result.toolCalls)
  ) {
    throw new Error(
      'Subscription provider returned an invalid decision envelope.',
    );
  }
  // Validate the whole batch before emitting any call that could execute.
  const toolCalls = result.toolCalls.map((call: unknown) => {
    if (
      !isObject(call) ||
      typeof call.name !== 'string' ||
      !names.includes(call.name)
    ) {
      throw new Error(
        'Subscription provider requested an unknown application tool.',
      );
    }
    let input: unknown;
    try {
      input =
        typeof call.argumentsJson === 'string'
          ? JSON.parse(call.argumentsJson)
          : null;
    } catch {
      throw new Error(
        `Invalid JSON arguments for application tool ${call.name}.`,
      );
    }
    if (!isObject(input))
      throw new Error(
        `Arguments for application tool ${call.name} must be a JSON object.`,
      );
    // Full schema validation remains with TanStack and the application executor.
    return { name: call.name, argumentsJson: JSON.stringify(input), input };
  });
  return { text: result.text, toolCalls };
}

function tokenUsage(usage: Record<string, unknown>): TokenUsage | undefined {
  const promptTokens =
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens;
  const completionTokens =
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens;
  const validCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  // Unknown counts must not be reported as zero.
  if (!validCount(promptTokens) || !validCount(completionTokens))
    return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens: validCount(usage.total_tokens ?? usage.totalTokens)
      ? ((usage.total_tokens ?? usage.totalTokens) as number)
      : promptTokens + completionTokens,
    ...(validCount(usage.cached_input_tokens ?? usage.cachedInputTokens)
      ? {
          promptTokensDetails: {
            cachedTokens: (usage.cached_input_tokens ??
              usage.cachedInputTokens) as number,
          },
        }
      : {}),
  };
}

class SubscriptionTextAdapter extends BaseTextAdapter<
  string,
  SubscriptionOptions,
  readonly ['text'],
  DefaultMessageMetadataByModality,
  readonly []
> {
  readonly name = 'myown-llm-integrator';
  private readonly subscription: SubscriptionConfig;
  private readonly prepare?: SubscriptionConfig['prepare'];
  private readonly scheduler?: InferenceScheduler;
  private readonly stream?: DecisionStreamBinding;
  private readonly timing?: VoiceTurnTiming;
  private readonly invoke: (options: AgentOptions) => Promise<AgentResult>;

  constructor(config: SubscriptionConfig) {
    super({}, config.model ?? 'cli-default');
    this.subscription = requestConfig(config);
    this.prepare = config.prepare;
    this.scheduler = config.scheduler;
    this.invoke = config.invoke ?? runAgent;
    this.stream = config.stream;
    this.timing = config.timing;
  }

  private async timedProvider<T>(
    step: number,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ) {
    this.timing?.mark('provider_started', step);
    try {
      const response = await work();
      this.timing?.mark('provider_finished', step);
      this.timing?.providerResult(response, step);
      return response;
    } catch (error) {
      this.timing?.mark(
        signal?.aborted ? 'provider_cancelled' : 'provider_failed',
        step,
      );
      throw error;
    }
  }
  private request(options: AgentOptions, step?: number) {
    const invoke = (signal = options.signal) =>
      step === undefined
        ? this.invoke({ ...options, signal })
        : this.timedProvider(step, signal, () =>
            this.invoke({ ...options, signal }),
          );
    return this.scheduler
      ? this.scheduler.run(
          'foreground',
          options.signal ?? new AbortController().signal,
          (signal) => invoke(signal),
        )
      : measured('providerExecution', () => invoke());
  }
  async *chatStream(options: ChatOptions): AsyncIterable<StreamChunk> {
    const signal = abortSignal(options);
    const runId = options.runId ?? randomUUID();
    const threadId = options.threadId ?? randomUUID();
    const messageId = randomUUID();
    const step = this.timing?.nextStep() ?? 0;
    try {
      signal?.throwIfAborted();
      yield {
        type: EventType.RUN_STARTED,
        threadId,
        runId,
        ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
        timestamp: Date.now(),
      };
      const names = (options.tools ?? []).map((tool) => tool.name);
      options.logger?.request('subscription decision request', {
        provider: this.subscription.provider,
        model: this.model,
      });
      const schema = decisionSchema(names);
      let payload = {
        ...serializeChatOptions(options),
        responseSchema: schema,
      };
      this.timing?.mark('context_started', step);
      if (this.prepare)
        payload = (await this.prepare(
          payload,
          signal ?? new AbortController().signal,
        )) as typeof payload;
      this.timing?.mark('context_ready', step);
      this.timing?.mark('provider_queued', step);
      let response: AgentResult;
      let streamed = '';
      if (this.stream) {
        const binding = this.stream;
        let result: AgentResult | undefined;
        const run: DecisionStreamBinding['runDecision'] = (request) =>
          this.scheduler
            ? this.scheduler.run('foreground', request.signal!, (active) =>
                this.timedProvider(step, active, () =>
                  binding.runDecision({ ...request, signal: active }),
                ),
              )
            : measured('providerExecution', () =>
                this.timedProvider(step, request.signal, () =>
                  binding.runDecision(request),
                ),
              );
        for await (const record of decisionRecords(run, {
          model: this.subscription.model,
          timeoutMs: this.subscription.timeoutMs,
          signal,
          toolNames: names,
          prompt:
            'Complete this authoritative application conversation, following its system instructions. Use only the provider session decision-record protocol. Application actions must use availableTools and remain subject to host approval. Never claim an action succeeded without a tool result.\n\n' +
            JSON.stringify({
              systemPrompts: payload.systemPrompts,
              messages: payload.messages,
              availableTools: payload.availableTools,
            }),
        })) {
          if (record.kind === 'result') {
            result = record.response;
            continue;
          }
          signal?.throwIfAborted();
          if (!streamed)
            yield {
              type: EventType.TEXT_MESSAGE_START,
              messageId,
              role: 'assistant',
              timestamp: Date.now(),
            };
          binding.authorizeText(messageId, record.sequence, record.text);
          this.timing?.mark('first_validated_text', step);
          streamed += record.text;
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: record.text,
            timestamp: Date.now(),
          };
        }
        if (!result) throw Error('Provider returned no decision');
        response = result;
        const checked = parseDecision(response.result, names);
        if (checked.text !== streamed || (streamed && checked.toolCalls.length))
          throw Error('Provider final decision does not match committed text');
        if (streamed)
          yield {
            type: EventType.TEXT_MESSAGE_END,
            messageId,
            timestamp: Date.now(),
          };
      } else {
        response = await this.request(
          {
            ...this.subscription,
            signal,
            prompt: renderSubscriptionPrompt(payload),
            schema,
          },
          step,
        );
      }
      signal?.throwIfAborted();
      options.logger?.provider('subscription decision response', { response });
      const decision = parseDecision(response.result, names);

      // The integrator returns one complete result; each step emits one delta.
      if (decision.text && !streamed) {
        this.timing?.mark('first_validated_text', step);
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: 'assistant',
          timestamp: Date.now(),
        };
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: decision.text,
          timestamp: Date.now(),
        };
        yield {
          type: EventType.TEXT_MESSAGE_END,
          messageId,
          timestamp: Date.now(),
        };
      }
      for (const call of decision.toolCalls) {
        signal?.throwIfAborted();
        const toolCallId = randomUUID();
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: call.name,
          parentMessageId: messageId,
          timestamp: Date.now(),
        };
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: call.argumentsJson,
          timestamp: Date.now(),
        };
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId,
          input: call.input,
          timestamp: Date.now(),
        };
      }
      const usage = tokenUsage(response.usage);
      yield {
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        model: this.model,
        finishReason: decision.toolCalls.length ? 'tool_calls' : 'stop',
        ...(usage ? { usage } : {}),
        timestamp: Date.now(),
      };
    } catch (error) {
      this.timing?.mark(
        signal?.aborted ? 'adapter_cancelled' : 'adapter_failed',
        step,
      );
      if (signal?.aborted) return;
      const message =
        error instanceof Error
          ? error.message
          : 'Subscription inference failed.';
      options.logger?.errors('subscription inference failed', { error });
      yield {
        type: EventType.RUN_ERROR,
        threadId,
        runId,
        message,
        timestamp: Date.now(),
      };
    }
  }

  async structuredOutput({
    chatOptions,
    outputSchema,
  }: StructuredOutputOptions<SubscriptionOptions>) {
    const signal = abortSignal(chatOptions);
    signal?.throwIfAborted();
    try {
      chatOptions.logger?.request('subscription structured output request', {
        provider: this.subscription.provider,
        model: this.model,
      });
      let payload: SubscriptionPayload = {
        ...serializeChatOptions({ ...chatOptions, tools: [] }),
        responseSchema: outputSchema,
        outputInstruction:
          'Return the final answer matching the supplied output schema.',
      };
      if (this.prepare)
        payload = await this.prepare(
          payload,
          signal ?? new AbortController().signal,
        );
      const response = await this.request({
        ...this.subscription,
        signal,
        prompt: renderSubscriptionPrompt(payload),
        schema: outputSchema,
      });
      signal?.throwIfAborted();
      chatOptions.logger?.provider('subscription structured output response', {
        response,
      });
      const usage = tokenUsage(response.usage);
      return {
        data: response.result,
        rawText: JSON.stringify(response.result),
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      chatOptions.logger?.errors('subscription structured output failed', {
        error,
      });
      throw error;
    }
  }
}

export function subscriptionText(config: SubscriptionConfig) {
  return new SubscriptionTextAdapter(config);
}

export async function subscriptionCompletion(
  prompt: string,
  config: SubscriptionConfig,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const response = await runAgent({
    ...requestConfig(config),
    signal,
    prompt: `${subscriptionInstructions}\nNo application tools are available. Return the answer in text.\n\n${prompt}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
  });
  signal.throwIfAborted();
  if (typeof response.result.text !== 'string')
    throw new Error(
      'Subscription provider returned an invalid text completion.',
    );
  return response.result.text;
}
