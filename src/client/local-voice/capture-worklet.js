/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// Plain worklet asset: no imports or browser-main-thread dependencies.
class LocalVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new ArrayBuffer(1024);
    this.view = new DataView(this.buffer);
    this.offset = 0;
    this.sequence = 0;
    this.pending = new Set();
    this.failed = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'ack') this.pending.delete(data.sequence);
    };
  }

  fail(message) {
    if (!this.failed) this.port.postMessage({ type: 'error', message });
    this.failed = true;
    return false;
  }

  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.failed) return false;
    if (sampleRate !== 16000)
      return this.fail('Microphone audio context must run at 16 kHz');
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (const input of samples) {
      const sample = Number.isFinite(input)
        ? Math.max(-1, Math.min(1, input))
        : 0;
      this.view.setInt16(
        this.offset * 2,
        Math.round(sample * (sample < 0 ? 32768 : 32767)),
        true,
      );
      this.offset++;
      if (this.offset !== 512) continue;
      if (this.pending.size >= 8)
        return this.fail('Microphone capture backlog exceeded');
      const sequence = this.sequence++;
      this.pending.add(sequence);
      this.port.postMessage({ type: 'frame', sequence, pcm: this.buffer }, [
        this.buffer,
      ]);
      this.buffer = new ArrayBuffer(1024);
      this.view = new DataView(this.buffer);
      this.offset = 0;
    }
    return true;
  }
}

registerProcessor('local-voice-capture', LocalVoiceCapture);
