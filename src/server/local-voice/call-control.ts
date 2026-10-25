/** Only an entire direct owner utterance can end a call, never a phrase inside prose. */
export function isEndCallRequest(transcript: string): boolean {
  const text = transcript.normalize('NFKC').replace(/[’‘]/g, "'").trim();
  if (text.length > 4000 || /["“”`]|(?:^|\s)'|'(?:\s|$)/u.test(text))
    return false;
  const words = text
    .toLowerCase()
    .replace(/[,.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:(?:ok|okay|all right|alright|hey) )?(?:dot )?(?:(?:can|could|would|will) you |(?:can|could) we |i (?:want|would like)(?: you)? to |i'd like(?: you)? to |let's |let us )?(?:please )?(?:(?:end|stop|close|disconnect) (?:the |this |our )?(?:call|voice call|voice chat|voice session)|hang up(?: (?:the |this |our )?(?:voice )?call)?)(?: now)?(?: please)?(?: thanks| thank you)?$/.test(
    words,
  );
}
