import { describe, expect, it } from 'vitest';
import {
  playSpeechOutput,
  splitSpeechText,
} from '../src/server/local-voice/speech-output';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const threeSentences = `First. Second ${'word '.repeat(39)}ends. Third ${'word '.repeat(39)}ends.`;

describe('speech text chunks', () => {
  it('starts a long opening sentence at a natural clause and preserves its complete answer', () => {
    const first =
      'For the clearest mountain views I would start with the cable car to Fansipan,';
    const rest =
      ' then leave enough time to explore the valley and return to your hotel before the weather changes later in the afternoon.';
    const text = first + rest + ' Keep tomorrow flexible.';
    const chunks = splitSpeechText(text);
    expect(chunks[0]).toBe(first);
    expect(chunks.slice(1).join(' ')).toBe(
      rest.trim() + ' Keep tomorrow flexible.',
    );
    expect(chunks.join(' ')).toBe(text);
  });

  it('does not cut short phrases, decimals, numeric separators or titles for a smaller first chunk', () => {
    const text =
      'Dr. Smith says the cost is 1,234.50 dollars and the temperature is 3.14 degrees, so we should bring a coat.';
    expect(splitSpeechText(text)).toEqual([text]);
  });

  it('starts with a complete sentence and groups later sentences within the bound', () => {
    expect(
      splitSpeechText('The total is 3.14. That is useful. We can continue.'),
    ).toEqual(['The total is 3.14.', 'That is useful. We can continue.']);
    expect(splitSpeechText('Dr. Smith saved the notes. Next step.')).toEqual([
      'Dr. Smith saved the notes.',
      'Next step.',
    ]);
    expect(splitSpeechText('She said, “Done!” Then left.')).toEqual([
      'She said, “Done!”',
      'Then left.',
    ]);
  });

  it('splits long sentences between words without losing the remaining text', () => {
    expect(splitSpeechText(`${'word '.repeat(80)}ends.`)).toEqual([
      Array(70).fill('word').join(' '),
      `${Array(10).fill('word').join(' ')} ends.`,
    ]);
    expect(splitSpeechText('  \n ')).toEqual([]);
  });

  it('bounds a single oversized token without cutting a Unicode character', () => {
    const text = `a${'😀'.repeat(200)}`;
    const chunks = splitSpeechText(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 350)).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });
});

describe('speech synthesis ahead of playback', () => {
  it('synthesizes exactly one chunk ahead while retaining playback order', async () => {
    const synthesized: string[] = [];
    const played: number[] = [];
    const playback = [deferred<void>(), deferred<void>(), deferred<void>()];
    let generated = 0;
    const output = playSpeechOutput({
      text: threeSentences,
      signal: new AbortController().signal,
      synthesize: async (text) => {
        synthesized.push(text);
        return Buffer.alloc(synthesized.length * 2);
      },
      generated: (samples) => {
        generated += samples;
      },
      play: async (pcm) => {
        played.push(pcm.length);
        await playback[played.length - 1].promise;
      },
    });
    await settle();
    expect(synthesized).toHaveLength(2);
    expect(synthesized[0]).toBe('First.');
    expect(played).toEqual([2]);
    expect(generated).toBe(3);

    playback[0].resolve();
    await settle();
    expect(synthesized).toHaveLength(3);
    expect(played).toEqual([2, 4]);
    playback[1].resolve();
    await settle();
    expect(played).toEqual([2, 4, 6]);
    playback[2].resolve();
    await output;
    expect(generated).toBe(6);
  });

  it('counts completed prefetch on cancellation without queueing that audio', async () => {
    const controller = new AbortController();
    const played: number[] = [];
    let generated = 0;
    let syntheses = 0;
    const output = playSpeechOutput({
      text: threeSentences,
      signal: controller.signal,
      synthesize: async () => Buffer.alloc(++syntheses * 4),
      generated: (samples) => {
        generated += samples;
      },
      play: async (pcm) => {
        played.push(pcm.length);
        await new Promise<void>(() => {});
      },
    });
    const result = expect(output).rejects.toThrow('interrupted');
    await settle();
    controller.abort(new Error('interrupted'));
    await result;
    expect(generated).toBe(6);
    expect(played).toEqual([4]);
    expect(syntheses).toBe(2);
  });

  it('surfaces prefetch failure and aborts playback without waiting for acknowledgements', async () => {
    const next = deferred<Buffer>();
    let syntheses = 0;
    let playbackSignal: AbortSignal | undefined;
    let generated = 0;
    const output = playSpeechOutput({
      text: threeSentences,
      signal: new AbortController().signal,
      synthesize: async () =>
        ++syntheses === 1 ? Buffer.alloc(4) : next.promise,
      generated: (samples) => {
        generated += samples;
      },
      play: async (_pcm, signal) => {
        playbackSignal = signal;
        await new Promise<void>(() => {});
      },
    });
    const result = expect(output).rejects.toThrow('synthesis failed');
    await settle();
    next.reject(new Error('synthesis failed'));
    await result;
    expect(playbackSignal?.aborted).toBe(true);
    expect(generated).toBe(2);
  });

  it('consumes late prefetch rejection after playback failure', async () => {
    const next = deferred<Buffer>();
    const playing = deferred<void>();
    let syntheses = 0;
    let synthesisSignal: AbortSignal | undefined;
    const output = playSpeechOutput({
      text: threeSentences,
      signal: new AbortController().signal,
      synthesize: async (_text, signal) => {
        synthesisSignal = signal;
        return ++syntheses === 1 ? Buffer.alloc(4) : next.promise;
      },
      generated: () => {},
      play: () => playing.promise,
    });
    const result = expect(output).rejects.toThrow('playback failed');
    await settle();
    playing.reject(new Error('playback failed'));
    await result;
    expect(synthesisSignal?.aborted).toBe(true);
    next.reject(new Error('late synthesis failure'));
    await settle();
  });

  it.each([Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(1440002)])(
    'rejects invalid synthesis PCM before accounting or playing',
    async (pcm) => {
      let generated = 0;
      let played = false;
      await expect(
        playSpeechOutput({
          text: 'Hello.',
          signal: new AbortController().signal,
          synthesize: async () => pcm,
          generated: (samples) => {
            generated += samples;
          },
          play: async () => {
            played = true;
          },
        }),
      ).rejects.toThrow('Invalid speech output');
      expect(generated).toBe(0);
      expect(played).toBe(false);
    },
  );
});
