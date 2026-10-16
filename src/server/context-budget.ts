import {
  renderSubscriptionPrompt,
  type SubscriptionPayload,
} from './subscription-prompt.js';
/** Conservative fallback: one token per UTF-8 byte. Not reported as model usage. */
export const estimateTokens = (text: string): number =>
  Buffer.byteLength(text, 'utf8');
export const payloadTokens = (payload: SubscriptionPayload): number =>
  estimateTokens(renderSubscriptionPrompt(payload)) +
  estimateTokens(JSON.stringify(payload.responseSchema ?? {}));
export class ContextCapacityError extends Error {
  constructor() {
    super(
      'Context capacity exceeded. Compact this conversation, shorten the request, or reduce attached content and tools.',
    );
  }
}
