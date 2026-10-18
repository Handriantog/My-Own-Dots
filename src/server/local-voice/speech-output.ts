interface SpeechOutputOptions {
  text: string;
  signal: AbortSignal;
  synthesize: (text: string, signal: AbortSignal) => Promise<Buffer>;
  play: (pcm: Buffer, signal: AbortSignal) => Promise<void>;
  generated: (samples: number) => void;
}

const MAX_TEXT = 350;
const MAX_PCM_BYTES = 1440000;
const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });

function splitLongSentence(text: string): string[] {
  const chunks: string[] = [];
  while (text.length > MAX_TEXT) {
    let boundary = MAX_TEXT;
    while (boundary > 0 && !/\s/u.test(text[boundary])) boundary--;
    if (!boundary) {
      boundary = MAX_TEXT;
      // A single oversized token still needs a bound; preserve surrogate pairs.
      if (/[\uD800-\uDBFF]/u.test(text[boundary - 1])) boundary--;
    }
    chunks.push(text.slice(0, boundary).trim());
    text = text.slice(boundary).trimStart();
  }
  if (text) chunks.push(text);
  return chunks;
}

/** Start on a short sentence or natural clause; retain longer later units. */
export function splitSpeechText(text: string): string[] {
  const whole: string[] = [];
  for (const { segment } of sentences.segment(text.trim())) {
    const previous = whole.at(-1);
    // ICU treats common titles and initials as sentence endings in English.
    if (
      previous &&
      (/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)|e\.g|i\.e)\.$/iu.test(previous) ||
        /\b[A-Z]\.$/u.test(previous))
    ) {
      whole[whole.length - 1] += ` ${segment.trim()}`;
    } else if (segment.trim()) whole.push(segment.trim());
  }
  const parts = whole.flatMap(splitLongSentence);
  const opening = parts[0];
  if (opening?.length > 160) {
    // Only shorten at punctuation followed by whitespace. Never manufacture a
    // stop mid-word or split decimal/thousands separators to meet a target.
    const boundary = [...opening.matchAll(/[,;:—–](?=\s)/gu)].find(
      (match) => match.index >= 60 && match.index < 160,
    );
    if (boundary) {
      const end = boundary.index + boundary[0].length;
      parts.splice(0, 1, opening.slice(0, end), opening.slice(end).trimStart());
    }
  }
  const chunks: string[] = [];
  for (const part of parts) {
    // Do not delay the first complete sentence to fill a larger first chunk.
    const previous = chunks.length > 1 ? chunks.at(-1) : undefined;
    if (previous && previous.length + 1 + part.length <= MAX_TEXT) {
      chunks[chunks.length - 1] += ` ${part}`;
    } else chunks.push(part);
  }
  return chunks;
}

/** One playback chunk plus at most one synthesis ahead, with bounded PCM. */
export async function playSpeechOutput(
  options: SpeechOutputOptions,
): Promise<void> {
  options.signal.throwIfAborted();
  const chunks = splitSpeechText(options.text);
  if (!chunks.length) return;
  const failed = new AbortController();
  const signal = AbortSignal.any([options.signal, failed.signal]);
  let active = true;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // The prefetch may fail between awaits. Attach a rejection handler immediately.
  void aborted.catch(() => {});
  const synthesize = (text: string) =>
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return options.synthesize(text, signal);
      })
      .then((pcm) => {
        if (!active) signal.throwIfAborted();
        if (!pcm.length || pcm.length % 2 || pcm.length > MAX_PCM_BYTES)
          throw new Error('Invalid speech output');
        // Count completed prefetch even when it never reaches the playback queue.
        options.generated(pcm.length / 2);
        signal.throwIfAborted();
        return { pcm };
      })
      .catch((error: unknown) => {
        failed.abort(error);
        return { error };
      });
  try {
    let pending = synthesize(chunks[0]);
    for (let index = 0; index < chunks.length; index++) {
      const result = await Promise.race([pending, aborted]);
      if ('error' in result) throw result.error;
      signal.throwIfAborted();
      if (index + 1 < chunks.length) pending = synthesize(chunks[index + 1]);
      const playback = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return options.play(result.pcm, signal);
      });
      await Promise.race([playback, aborted]);
      signal.throwIfAborted();
    }
  } catch (error) {
    failed.abort(error);
    throw error;
  } finally {
    active = false;
    signal.removeEventListener('abort', onAbort);
  }
}
