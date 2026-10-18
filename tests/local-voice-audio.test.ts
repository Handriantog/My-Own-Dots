import { expect, it } from 'vitest';
import {
  decodeFixtureWav,
  encodeFixtureWav,
} from '../src/server/local-voice/audio.js';
it('roundtrips PCM16 mono WAV with explicit rate and rejects implicit resampling', () => {
  const pcm = Buffer.alloc(32000);
  expect(decodeFixtureWav(encodeFixtureWav(pcm, 16000))).toEqual(pcm);
  expect(() => decodeFixtureWav(encodeFixtureWav(pcm, 24000))).toThrow(
    /16 kHz/,
  );
});
it('rejects truncated, unaligned and oversized file audio', () => {
  const wav = encodeFixtureWav(Buffer.alloc(32000), 16000);
  expect(() => decodeFixtureWav(wav.subarray(0, 100))).toThrow();
  expect(() => decodeFixtureWav(Buffer.alloc(1000001))).toThrow();
  expect(() => encodeFixtureWav(Buffer.alloc(3), 16000)).toThrow();
});
