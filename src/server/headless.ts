import {
  IntelligenceAgent,
  ProxiedCopilotRuntimeAgent,
} from '@copilotkit/core';
import type { Message } from '@ag-ui/core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { voiceComputeMessagePrefix } from '../shared/voice-compute.js';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';
import { scheduledTaskMessagePrefix } from '../shared/scheduled-message.js';

export function currentTurnText(messages: Message[], error?: Error): string {
  if (error) throw error;
  const content = messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new Error('The current compute turn returned no assistant response.');
  return content;
}

const runtimeInfoSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('intelligence'),
    intelligence: z.object({ wsUrl: z.url() }),
    agents: z.record(z.string(), z.unknown()),
  }),
  z.object({
    mode: z.literal('sse'),
    agents: z.record(z.string(), z.unknown()),
  }),
]);

export async function runThreadTurn(
  runtimeUrl: string,
  headers: Record<string, string>,
  dotId: string,
  threadId: string,
  prompt: string,
  signal: AbortSignal,
  metadata?: Record<string, unknown>,
): Promise<string> {
  signal.throwIfAborted();
  const response = await fetch(`${runtimeUrl}/info`, { headers, signal });
  if (!response.ok)
    throw new Error(`Conversation runtime returned HTTP ${response.status}.`);
  const info = runtimeInfoSchema.parse(await response.json());
  if (!Object.hasOwn(info.agents, dotId))
    throw new Error('The selected Dot is unavailable in the runtime.');
  // Core's runtime discovery is browser-only. Use the SDK's Node-compatible
  // Intelligence agent for voice compute and scheduled server turns.
  const options = {
    runtimeUrl,
    agentId: dotId,
    headers,
    fetch: ((input, init) =>
      fetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      })) as typeof fetch,
  };
  const agent =
    info.mode === 'intelligence'
      ? new IntelligenceAgent({ ...options, url: info.intelligence.wsUrl })
      : new ProxiedCopilotRuntimeAgent({
          ...options,
          runtimeMode: 'sse',
          transport: 'rest',
        });
  agent.threadId = threadId;
  let runError: Error | undefined;
  const subscription = agent.subscribe({
    onRunErrorEvent: ({ event }) => {
      runError = new Error(event.message);
    },
  });
  const stop = () => agent.abortRun();
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    if (info.mode === 'sse') {
      await agent.connectAgent();
      // Replayed failures describe a previous turn, not the new one.
      runError = undefined;
      signal.throwIfAborted();
    }
    const idPrefix =
      metadata?.opendotsSource === 'voice_receipt'
        ? voiceReceiptMessagePrefix
        : metadata?.opendotsSource === 'scheduled_task'
          ? scheduledTaskMessagePrefix
          : metadata?.opendotsSource === 'voice_compute' &&
              typeof metadata.browserRequestId === 'string' &&
              /^[a-f0-9]{64}$/.test(metadata.browserRequestId)
            ? `${voiceComputeMessagePrefix}${metadata.browserRequestId}:`
            : '';
    agent.addMessage({
      id: `${idPrefix}${randomUUID()}`,
      role: 'user',
      content: prompt,
      ...(metadata ? { metadata } : {}),
    });
    const result = await agent.runAgent();
    signal.throwIfAborted();
    return currentTurnText(result.newMessages, runError);
  } finally {
    signal.removeEventListener('abort', stop);
    subscription.unsubscribe();
    await agent.detachActiveRun();
  }
}
