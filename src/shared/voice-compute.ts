// Retry grouping only; this marker grants no permissions. A distinct message ID
// for each attempt preserves conversation history, even on hosted replay.
export const voiceComputeMessagePrefix = 'opendots:voice_compute:';
export function voiceComputeScope(messageId: string): string | undefined {
  const match = messageId.match(
    /^opendots:voice_compute:([a-f0-9]{64}):[a-f0-9-]{36}$/,
  );
  return match ? voiceComputeMessagePrefix + match[1] : undefined;
}
