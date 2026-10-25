import { taskProgressEvent } from './local-voice/task-progress.js';
import { randomUUID } from 'node:crypto';
import { AbstractAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';
import { z } from 'zod';
import {
  createExecutionSession,
  type ExecutionEvent,
  type ExecutionSession,
} from 'myown-llm-integrator';
import type { FolderExecutionScope } from '../shared/folder-access.js';
import { codexCoordinator } from './codex-runtime.js';

export type CodexTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute?: (
    input: Record<string, unknown>,
    context: { toolCallId: string },
  ) => unknown | Promise<unknown>;
  parse?: (input: unknown) => Record<string, unknown>;
};
/** Adapt existing checked host executors; never install arbitrary client executors. */
export function codexTools(
  tools: {
    name: string;
    description?: string;
    parameters?: unknown;
    inputSchema?: unknown;
    execute?: unknown;
  }[],
): CodexTool[] {
  return tools.map((tool) => {
    const schema = tool.parameters ?? tool.inputSchema;
    const validator = schema instanceof z.ZodType ? schema : undefined;
    if (!schema || typeof schema !== 'object')
      throw new Error(`Missing schema for ${tool.name}.`);
    return {
      name: tool.name,
      description: tool.description ?? tool.name,
      // The provider supplies pre-transform inputs; parsing below still validates
      // and normalizes them before the checked host executor sees them.
      inputSchema: (validator
        ? z.toJSONSchema(validator, { io: 'input' })
        : schema) as Record<string, unknown>,
      ...(validator
        ? {
            parse: (value: unknown) =>
              validator.parse(value) as Record<string, unknown>,
          }
        : {}),
      ...(typeof tool.execute === 'function'
        ? { execute: tool.execute as CodexTool['execute'] }
        : {}),
    };
  });
}

type Options = {
  agentId: string;
  workspace: object;
  instructions: string;
  tools: CodexTool[];
  getScope(): Promise<FolderExecutionScope | undefined>;
  check(): Promise<void>;
  shouldPause(): boolean;
  takeProjectSwitch?(): boolean;
  model?: string;
  timeoutMs?: number;
  context?: unknown;
  admittedRunId?: string;
  prepare?(
    input: RunAgentInput,
    signal: AbortSignal,
  ): Promise<{ instructions: string; messages: unknown[] }>;
};
export class CodexAgent extends AbstractAgent {
  private controller?: AbortController;
  private session?: ExecutionSession;
  private running?: Promise<void>;
  private persisted = new Map<string, () => void>();
  constructor(private options: Options) {
    super({ agentId: options.agentId });
  }
  clone() {
    return new CodexAgent(this.options);
  }
  private runTask(
    runId: string,
    signal: AbortSignal,
    work: () => Promise<void>,
    threadId: string,
  ) {
    const coordinator = codexCoordinator(this.options.workspace);
    if (this.options.admittedRunId !== undefined) {
      if (
        this.options.admittedRunId !== runId ||
        coordinator.status(this.options.agentId).activeRunId !== runId
      )
        return Promise.reject(
          new Error('Execution admission is no longer current.'),
        );
      signal.throwIfAborted();
      return work();
    }
    return coordinator.run(this.options.agentId, runId, signal, work, threadId);
  }
  async detachActiveRun() {
    // Stop must retain execution ownership until the provider has confirmed its
    // outcome and reaped its process, including an uncertain cancellation.
    await this.running;
    await super.detachActiveRun();
  }
  abortRun() {
    this.controller?.abort();
    void this.session?.interrupt();
  }
  onPersistedEvent(input: RunAgentInput, event: BaseEvent) {
    const key =
      event.type === EventType.RUN_STARTED
        ? `${input.runId}:start`
        : event.type === EventType.TOOL_CALL_START && 'toolCallId' in event
          ? `${input.runId}:${event.toolCallId}`
          : undefined;
    if (key) this.persisted.get(key)?.();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      this.controller = controller;
      const signal = controller.signal;
      let watcher: ReturnType<typeof setInterval> | undefined;
      const tools = new Map(
        this.options.tools.map((tool) => [tool.name, tool]),
      );
      const calls = new Set<string>();
      const messages = new Set<string>();
      let progressSent = false;
      const finalMessages = new Map<string, string>();
      const outcomes: unknown[] = [];
      const emit = (event: BaseEvent) => {
        if (!subscriber.closed) subscriber.next(event);
      };
      const persist = async (key: string, event: BaseEvent) => {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            this.persisted.delete(key);
            signal.removeEventListener('abort', abort);
          };
          const abort = () => {
            cleanup();
            reject(
              new Error('Execution stopped before persistence was confirmed.'),
            );
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(
              new Error(
                'Execution was not dispatched because conversation persistence was not confirmed.',
              ),
            );
          }, 15_000);
          this.persisted.set(key, () => {
            cleanup();
            resolve();
          });
          signal.addEventListener('abort', abort, { once: true });
          emit(event);
        });
      };
      const startTool = async (id: string, name: string, args: unknown) => {
        if (calls.has(id)) return;
        calls.add(id);
        await persist(`${input.runId}:${id}`, {
          type: EventType.TOOL_CALL_START,
          toolCallId: id,
          toolCallName: name,
          parentMessageId: `execution:${input.runId}`,
        });
        emit({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: id,
          delta: JSON.stringify(args),
        });
        emit({ type: EventType.TOOL_CALL_END, toolCallId: id });
      };
      const toolResult = (id: string, content: string) =>
        emit({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: id,
          messageId: randomUUID(),
          role: 'tool',
          content,
        });
      const message = (id: string, text: string) => {
        if (!text.trim() || messages.has(id)) return;
        messages.add(id);
        emit({
          type: EventType.TEXT_MESSAGE_START,
          messageId: id,
          role: 'assistant',
        });
        emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: id,
          delta: text,
        });
        emit({ type: EventType.TEXT_MESSAGE_END, messageId: id });
      };
      const onEvent = async (event: ExecutionEvent) => {
        signal.throwIfAborted();
        if (event.type === 'message') {
          if (event.final) finalMessages.set(event.id, event.text);
          else {
            message(event.id, event.text);
            if (!progressSent && event.text.trim()) {
              progressSent = true;
              emit({
                type: EventType.CUSTOM,
                name: taskProgressEvent,
                value: { messageId: event.id },
              });
            }
          }
        }
        if (event.type === 'tool' && event.phase === 'started')
          await startTool(event.id, event.name, event.arguments);
        if (event.type === 'execution') {
          const evidence = event.evidence;
          await startTool(
            evidence.id,
            evidence.kind === 'command'
              ? 'run_project_command'
              : 'edit_project_files',
            {
              ...(evidence.command ? { command: evidence.command } : {}),
              ...(evidence.changes ? { changes: evidence.changes } : {}),
            },
          );
          if (evidence.status !== 'running')
            toolResult(evidence.id, JSON.stringify(evidence));
        }
      };
      const execute = async () => {
        const resolveProject = async () => {
          try {
            return { scope: await this.options.getScope(), problem: '' };
          } catch (error) {
            return {
              scope: undefined,
              problem:
                error instanceof Error
                  ? error.message
                  : 'The saved project is unavailable.',
            };
          }
        };
        await persist(`${input.runId}:start`, {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });
        await this.runTask(
          input.runId,
          signal,
          async () => {
            // The canonical snapshot is data; client-supplied system/developer messages never become instructions.
            const prepared = await this.options.prepare?.(input, signal);
            const snapshot =
              prepared?.messages ??
              input.messages.filter((m) =>
                ['user', 'assistant', 'tool'].includes(m.role),
              );
            for (let phase = 0; phase < 3; phase++) {
              signal.throwIfAborted();
              await this.options.check();
              const project = await resolveProject();
              const { scope } = project;
              const signature = JSON.stringify(project);
              let checking = false;
              watcher = setInterval(() => {
                if (checking || this.options.shouldPause()) return;
                checking = true;
                void (async () => {
                  await this.options.check();
                  if (JSON.stringify(await resolveProject()) !== signature)
                    throw new Error('Project permission changed.');
                })()
                  .catch(() => this.abortRun())
                  .finally(() => {
                    checking = false;
                  });
              }, 250);
              this.session = createExecutionSession({
                instructions:
                  (prepared?.instructions ?? this.options.instructions) +
                  (project.problem
                    ? `\nSaved project unavailable: ${project.problem} Native execution is disabled. Explain this blocker and use the normal owner permission tools to select a valid project.`
                    : ''),
                model: this.options.model,
                timeoutMs: this.options.timeoutMs,
                ...(scope
                  ? { scope: { cwd: scope.path, access: 'execute' } }
                  : {}),
                tools: this.options.tools.map(
                  ({ name, description, inputSchema }) => ({
                    name,
                    description,
                    inputSchema,
                  }),
                ),
                onTool: async (call) => {
                  signal.throwIfAborted();
                  call.signal.throwIfAborted();
                  await this.options.check();
                  const tool = tools.get(call.name);
                  if (!tool)
                    return {
                      content: 'This tool is not authorized.',
                      isError: true,
                    };
                  await startTool(call.callId, call.name, call.arguments);
                  if (!tool.execute) {
                    return {
                      content:
                        'Waiting for the owner to review this request. No approval has been granted.',
                      pause: true,
                    };
                  }
                  let content: string,
                    isError = false;
                  try {
                    const args = tool.parse
                      ? tool.parse(call.arguments)
                      : call.arguments;
                    const result = await tool.execute(args, {
                      toolCallId: call.callId,
                    });
                    content = JSON.stringify(result ?? null);
                  } catch (error) {
                    isError = true;
                    content = JSON.stringify({
                      status: 'failed',
                      error:
                        error instanceof Error ? error.message : 'Tool failed.',
                    });
                  }
                  signal.throwIfAborted();
                  outcomes.push({
                    name: call.name,
                    arguments: call.arguments,
                    result: content,
                  });
                  toolResult(call.callId, content);
                  return {
                    content,
                    isError,
                    pause: this.options.shouldPause(),
                  };
                },
              });
              try {
                const result = await this.session.run({
                  input: JSON.stringify({
                    conversation: snapshot,
                    supportingContext: this.options.context ?? null,
                    ...(outcomes.length
                      ? {
                          completedToolResults: outcomes,
                          continuation:
                            'Continue the original task in the selected project. These tool calls already finished; do not repeat their effects.',
                        }
                      : {}),
                  }),
                  signal,
                  timeoutMs: this.options.timeoutMs,
                  onEvent,
                });
                if (result.status === 'uncertain') {
                  emit({
                    type: EventType.RUN_ERROR,
                    code: 'EXECUTION_UNCERTAIN',
                    message:
                      'Execution was interrupted and some changes may already have happened. Inspect the recorded actions before retrying.',
                  });
                  return;
                }
                if (
                  result.status === 'failed' ||
                  result.status === 'cancelled'
                ) {
                  emit({
                    type: EventType.RUN_ERROR,
                    code:
                      result.status === 'cancelled'
                        ? 'EXECUTION_CANCELLED'
                        : 'EXECUTION_FAILED',
                    message:
                      result.error ??
                      'Execution stopped. Review its recorded actions before continuing.',
                  });
                  return;
                }
                if (
                  result.status === 'paused' &&
                  this.options.takeProjectSwitch?.()
                ) {
                  finalMessages.clear();
                  continue;
                }
                if (result.status === 'completed')
                  for (const [id, text] of finalMessages) message(id, text);
                if (!messages.size && result.text)
                  message(randomUUID(), result.text);
                emit({
                  type: EventType.RUN_FINISHED,
                  threadId: input.threadId,
                  runId: input.runId,
                });
                return;
              } finally {
                clearInterval(watcher);
                await this.session.close();
                this.session = undefined;
              }
            }
            throw new Error(
              'The project changed repeatedly. Review the selected project before continuing.',
            );
          },
          input.threadId,
        );
      };
      this.running = execute()
        .catch((error) =>
          emit({
            type: EventType.RUN_ERROR,
            code: 'EXECUTION_FAILED',
            message:
              error instanceof Error
                ? error.message
                : 'Execution could not start.',
          }),
        )
        .finally(() => {
          clearInterval(watcher);
          subscriber.complete();
        });
      return () => {
        clearInterval(watcher);
        controller.abort();
        void this.session?.close();
        this.persisted.clear();
      };
    });
  }
}
