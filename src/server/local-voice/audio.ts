/** Bounded file-fixture utility. Device capture/resampling is deliberately separate. */
export function encodeFixtureWav(pcm: Buffer, rate: 16000 | 24000): Buffer {
  if (!pcm.length || pcm.length % 2 || pcm.length > rate * 2 * 30)
    throw new Error('PCM must be aligned and at most 30 seconds');
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function decodeFixtureWav(wav: Buffer): Buffer {
  if (
    wav.length < 44 ||
    wav.length > 1000000 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.readUInt32LE(4) !== wav.length - 8
  )
    throw new Error('Invalid or oversized WAV file');
  let format = false;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + size > wav.length) throw new Error('Truncated WAV chunk');
    if (kind === 'fmt ') {
      if (
        format ||
        size < 16 ||
        wav.readUInt16LE(offset) !== 1 ||
        wav.readUInt16LE(offset + 2) !== 1 ||
        wav.readUInt32LE(offset + 4) !== 16000 ||
        wav.readUInt32LE(offset + 8) !== 32000 ||
        wav.readUInt16LE(offset + 12) !== 2 ||
        wav.readUInt16LE(offset + 14) !== 16
      )
        throw new Error(
          'WAV input must be PCM16 mono at 16 kHz; resample explicitly',
        );
      format = true;
    }
    if (kind === 'data') {
      if (pcm || !size || size % 2 || size > 960000)
        throw new Error('Invalid WAV PCM length');
      pcm = wav.subarray(offset, offset + size);
    }
    offset += size + (size % 2);
  }
  if (!format || !pcm) throw new Error('Missing WAV format or PCM');
  return pcm;
}
