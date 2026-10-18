import {
  DEFAULT_VOICE_SETTINGS,
  personalityInstruction,
  type VoiceSettings,
} from '../../shared/voice-settings.js';
import type { AgentOptions, AgentResult } from 'myown-llm-integrator';
import { EventType, type BaseEvent } from '@ag-ui/client';
import type { DecisionStreamBinding } from '../subscription-stream.js';
import type { VoiceTurnTiming } from './timing.js';
type VoiceTurn = {
  callId: string;
  dotId: string;
  threadId: string;
  messageId: string;
  text: string;
  timing?: VoiceTurnTiming;
  personality?: VoiceSettings['personality'];
  inference?: (options: AgentOptions) => Promise<AgentResult>;
  stream?: DecisionStreamBinding['runDecision'];
  commitText?: (
    messageId: string,
    assistantId: string,
    sequence: number,
    text: string,
  ) => void;
  finishText?: (messageId: string, failed: boolean) => void;
};
// One active call per workspace. This is ephemeral turn metadata, not another
// conversation store, and cannot be supplied by forwardedProps or chat text.
type ActiveTurn = VoiceTurn & {
  unbound: { assistantId: string; sequence: number; text: string }[];
  mapped: Map<string, string>;
  pending: Map<string, { sequence: number; text: string }[]>;
  issued: Map<string, number>;
};
const turns = new WeakMap<object, ActiveTurn>();
export function setVoiceTurn(workspace: object, turn: VoiceTurn) {
  turns.set(workspace, {
    ...turn,
    unbound: [],
    mapped: new Map(),
    pending: new Map(),
    issued: new Map(),
  });
}
export function clearVoiceTurn(workspace: object, callId: string) {
  if (turns.get(workspace)?.callId === callId) turns.delete(workspace);
}
function currentVoiceTurn(
  workspace: object,
  dotId: string,
  input: {
    threadId: string;
    messages: { id: string; role: string; content?: unknown }[];
  },
) {
  const turn = turns.get(workspace);
  const user = input.messages.findLast((message) => message.role === 'user');
  if (
    !turn ||
    turn.dotId !== dotId ||
    turn.threadId !== input.threadId ||
    user?.id !== turn.messageId ||
    typeof user.content !== 'string' ||
    !(user.content === turn.text || user.content.endsWith(`\n\n${turn.text}`))
  )
    return undefined;
  return turn;
}
export function voiceTurnInference(
  ...args: Parameters<typeof currentVoiceTurn>
) {
  return currentVoiceTurn(...args)?.inference;
}
export function voiceTurnTiming(...args: Parameters<typeof currentVoiceTurn>) {
  return currentVoiceTurn(...args)?.timing;
}
export function voiceTurnStreaming(
  ...args: Parameters<typeof currentVoiceTurn>
): DecisionStreamBinding | undefined {
  const turn = currentVoiceTurn(...args);
  if (!turn?.stream || !turn.commitText) return undefined;
  return {
    runDecision: turn.stream,
    authorizeText(assistantId, sequence, text) {
      if (currentVoiceTurn(...args) !== turn)
        throw Error('Voice turn is no longer active');
      const expected = turn.issued.get(assistantId) ?? 0;
      if (
        sequence !== expected ||
        sequence >= 256 ||
        !text ||
        text.length > 400 ||
        (!turn.issued.has(assistantId) && turn.issued.size >= 32)
      )
        throw Error('Invalid voice text commitment');
      turn.issued.set(assistantId, sequence + 1);
      turn.unbound.push({ assistantId, sequence, text });
    },
  };
}
/** CopilotKit assigns its own assistant IDs; bind at the trusted agent output boundary. */
export function bindVoiceEvent(
  workspace: object,
  dotId: string,
  input: Parameters<typeof currentVoiceTurn>[2],
  event: BaseEvent,
) {
  const turn = currentVoiceTurn(workspace, dotId, input);
  if (
    !turn ||
    ![EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_CHUNK].includes(
      event.type as EventType,
    ) ||
    typeof event.messageId !== 'string'
  )
    return;
  const next = turn.unbound[0];
  if (!next) return;
  if (event.delta !== next.text)
    throw Error('Voice text changed before persistence');
  const mapped = turn.mapped.get(next.assistantId);
  if (mapped && mapped !== event.messageId)
    throw Error('Voice message identity changed');
  turn.mapped.set(next.assistantId, event.messageId);
  turn.unbound.shift();
  const queue = turn.pending.get(event.messageId) ?? [];
  queue.push({ sequence: next.sequence, text: next.text });
  turn.pending.set(event.messageId, queue);
}
/** Called by the conversation runner only after appendEvent resolves. */
export function persistedVoiceEvent(
  workspace: object,
  dotId: string,
  input: Parameters<typeof currentVoiceTurn>[2],
  event: BaseEvent,
) {
  const turn = currentVoiceTurn(workspace, dotId, input);
  if (
    !turn ||
    event.type !== EventType.TEXT_MESSAGE_CONTENT ||
    typeof event.messageId !== 'string'
  )
    return;
  // Buffered replies are also durable here, but are never approved for early
  // speech by this measurement. Streaming still requires the exact saved span.
  if (!turn.stream && typeof event.delta === 'string' && event.delta.length)
    turn.timing?.mark('text_saved');
  const queue = turn.pending.get(event.messageId);
  const next = queue?.[0];
  if (!next || event.delta !== next.text) return;
  queue!.shift();
  turn.timing?.mark('text_saved');
  turn.commitText?.(turn.messageId, event.messageId, next.sequence, next.text);
}
export function settledVoiceRun(
  workspace: object,
  dotId: string,
  input: Parameters<typeof currentVoiceTurn>[2],
  failed: boolean,
) {
  const turn = currentVoiceTurn(workspace, dotId, input);
  if (!turn) return;
  turn.timing?.mark(failed ? 'run_failed' : 'run_finished');
  turn.pending.clear();
  turn.unbound.length = 0;
  turn.finishText?.(turn.messageId, failed);
}
export function voiceTurnInstructions(
  ...args: Parameters<typeof currentVoiceTurn>
): string[] {
  const turn = currentVoiceTurn(...args);
  if (!turn) return [];
  return [
    'This is an English-only voice conversation. Reply in English only, even if speech recognition or earlier conversation contains another language. Preserve the full answer quality, context, tool use, and approval requirements. Begin with a short, useful complete sentence or phrase (around 120 characters when natural), then continue with the full answer. Do not add filler acknowledgements or truncate information to meet that preference. Speech transcripts can misrecognize similar-sounding words, names, and spelled letters. Use the ongoing topic and explicit user corrections to understand likely intent; do not insist the transcript is exactly what the user said or claim to have heard their audio. Resolve clear, low-risk wording from context without repeatedly asking the same correction. If ambiguity affects an action, permission, recipient, path, amount, or other consequential detail, ask a concise clarification and retain the normal approval flow. Never infer consent or rewrite the saved transcript. ' +
      (turn.personality
        ? personalityInstruction({
            ...DEFAULT_VOICE_SETTINGS,
            personality: turn.personality,
          })
        : ''),
  ];
}
