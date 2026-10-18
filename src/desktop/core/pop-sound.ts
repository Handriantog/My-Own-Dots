/** Original, quiet water-drop pop. No downloaded audio or runtime synthesis nodes. */
export function dropletPop(sampleRate: number): Float32Array {
  const samples = new Float32Array(Math.round(sampleRate * 0.12));
  let phase = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    const frequency = 430 + 1300 * Math.exp(-t * 48);
    phase += (2 * Math.PI * frequency) / sampleRate;
    const envelope =
      (1 - Math.exp(-t * 1400)) *
      Math.exp(-t * 48) *
      Math.min(1, (samples.length - 1 - i) / (sampleRate * 0.012));
    samples[i] =
      0.3 * envelope * (Math.sin(phase) + 0.08 * Math.sin(phase * 2.04));
  }
  return samples;
}
