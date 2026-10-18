import captureWorkletUrl from './capture-worklet.js?url&no-inline';

export interface CaptureFrame {
  sequence: number;
  /** PCM16 little-endian mono, 512 samples at 16 kHz (32 ms). */
  pcm: Uint8Array;
}
export interface PlaybackFrame {
  generation: number;
  /** Monotonic across the entire call, including generation changes. */
  sequence: number;
  /** PCM16 little-endian mono at 24 kHz, at most 960 samples (40 ms). */
  pcm: Uint8Array;
}
export interface PlayedFrame {
  generation: number;
  sequence: number;
  /** Natural software playback completion; this does not prove acoustic hearing. */
  playedSamples: number;
}
export interface LocalVoiceAudioOptions {
  /** Must synchronously enqueue or reject. HTTP backpressure belongs to the caller. */
  onFrame(frame: CaptureFrame): void;
  onPlayed(frame: PlayedFrame): void;
  onError(error: Error): void;
  onCaptureSettings?(settings: MediaTrackSettings): void;
}
interface CaptureResources {
  context: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  node?: AudioWorkletNode;
  removeListeners: (() => void)[];
}

const errorOf = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));
const stoppedError = () => new Error('Audio startup was cancelled or stopped');
function closeContext(context: AudioContext) {
  if (context.state !== 'closed') void context.close().catch(() => {});
}

async function resumePlayback(context: AudioContext): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      context.resume(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Audio playback did not start. Try starting the call again.',
              ),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One call's device resources. Construction never opens a device. */
export class LocalVoiceAudio {
  private stopped = false;
  private capture?: CaptureResources;
  private captureStarting?: Promise<void>;
  private captureSequence = 0;
  private playback?: AudioContext;
  private playbackStarting?: Promise<void>;
  private playbackStateListener?: () => void;
  private sources = new Set<AudioBufferSourceNode>();
  private nextPlaybackTime = 0;
  private generation = 0;
  private lastSequence = -1;
  private allowSequenceGap = false;
  private speakerMuted = false;
  private mutedGeneration = -1;

  constructor(private readonly options: LocalVoiceAudioOptions) {}

  /** Invoke from Start call or explicit unmute, never automatic recovery. */
  async startCapture(): Promise<void> {
    if (this.stopped) throw stoppedError();
    if (this.captureStarting) return this.captureStarting;
    if (this.capture?.node) return;
    let resources: CaptureResources | undefined;
    let starting: Promise<void> | undefined;
    try {
      const context = new AudioContext({ sampleRate: 16000 });
      resources = { context, removeListeners: [] };
      this.capture = resources;
      if (context.sampleRate !== 16000)
        throw new Error(
          'This browser cannot capture through a 16 kHz audio context',
        );
      const current = resources;
      // MediaStreamAudioSourceNode converts the actual device rate to this context's
      // verified 16 kHz rate. The worklet only packs samples; it never relabels a rate.
      const stream = navigator.mediaDevices
        .getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })
        .then((value) => {
          if (this.stopped || this.capture !== current) {
            value.getTracks().forEach((track) => track.stop());
            throw stoppedError();
          }
          current.stream = value;
          const tracks = value.getAudioTracks();
          if (
            !tracks.length ||
            tracks.some((track) => track.readyState !== 'live')
          )
            throw new Error('Microphone is unavailable');
          for (const track of tracks) {
            const ended = () => this.fail(new Error('Microphone disconnected'));
            track.addEventListener('ended', ended);
            current.removeListeners.push(() =>
              track.removeEventListener('ended', ended),
            );
            this.options.onCaptureSettings?.(track.getSettings());
          }
          return value;
        });
      starting = Promise.all([
        stream,
        context.resume(),
        context.audioWorklet.addModule(captureWorkletUrl),
      ]).then(([mediaStream]) => {
        if (this.stopped || this.capture !== current) throw stoppedError();
        if (context.state !== 'running')
          throw new Error('Microphone audio context did not start');
        const node = new AudioWorkletNode(context, 'local-voice-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        });
        current.node = node;
        let expectedSequence = 0;
        node.port.onmessage = ({ data }: MessageEvent<unknown>) => {
          if (this.stopped || this.capture !== current) return;
          try {
            const message = data as {
              type?: string;
              sequence?: number;
              pcm?: unknown;
              message?: string;
            } | null;
            if (message?.type === 'error')
              throw new Error(message.message || 'Microphone capture failed');
            if (
              message?.type !== 'frame' ||
              message.sequence !== expectedSequence ||
              !(message.pcm instanceof ArrayBuffer) ||
              message.pcm.byteLength !== 1024
            )
              throw new Error('Malformed or discontinuous microphone frame');
            this.options.onFrame({
              sequence: this.captureSequence++,
              pcm: new Uint8Array(message.pcm),
            });
            expectedSequence++;
            if (this.capture === current && !this.stopped)
              node.port.postMessage({
                type: 'ack',
                sequence: message.sequence,
              });
          } catch (error) {
            this.fail(error);
          }
        };
        node.onprocessorerror = () =>
          this.fail(new Error('Microphone audio processor failed'));
        current.source = context.createMediaStreamSource(mediaStream);
        current.source.connect(node);
        // The worklet explicitly fills its output with zeroes: never monitor the mic.
        node.connect(context.destination);
        const stateChanged = () => {
          if (context.state !== 'running')
            this.fail(new Error('Microphone audio context interrupted'));
        };
        context.addEventListener('statechange', stateChanged);
        current.removeListeners.push(() =>
          context.removeEventListener('statechange', stateChanged),
        );
      });
      this.captureStarting = starting;
      await starting;
    } catch (error) {
      if (!resources || this.capture === resources) this.stop();
      throw errorOf(error);
    } finally {
      if (this.captureStarting === starting) this.captureStarting = undefined;
    }
  }

  /** Immediate release, including a permission request which resolves later. */
  muteCapture(): void {
    const resources = this.capture;
    this.capture = undefined;
    this.captureStarting = undefined;
    if (!resources) return;
    resources.removeListeners.forEach((remove) => remove());
    if (resources.node) {
      resources.node.port.onmessage = null;
      resources.node.onprocessorerror = null;
      resources.node.port.close();
      resources.node.disconnect();
    }
    resources.source?.disconnect();
    resources.stream?.getTracks().forEach((track) => track.stop());
    closeContext(resources.context);
  }

  /** Invoke in the Start call gesture to unlock output before asynchronous setup. */
  async startPlayback(): Promise<void> {
    if (this.stopped) throw stoppedError();
    if (this.playbackStarting) return this.playbackStarting;
    if (this.playback) return;
    let context: AudioContext | undefined;
    let starting: Promise<void> | undefined;
    try {
      context = new AudioContext();
      this.playback = context;
      const current = context;
      starting = resumePlayback(context).then(() => {
        if (this.stopped || this.playback !== current) throw stoppedError();
        if (current.state !== 'running')
          throw new Error('Speaker audio context did not start');
        const stateChanged = () => {
          if (current.state !== 'running')
            this.fail(new Error('Speaker audio context interrupted'));
        };
        this.playbackStateListener = stateChanged;
        current.addEventListener('statechange', stateChanged);
      });
      this.playbackStarting = starting;
      await starting;
    } catch (error) {
      if (!context || this.playback === context) this.stop();
      throw errorOf(error);
    } finally {
      if (this.playbackStarting === starting) this.playbackStarting = undefined;
    }
  }

  play(frame: PlaybackFrame): boolean {
    if (this.stopped) return false;
    try {
      if (!Number.isSafeInteger(frame.generation) || frame.generation < 0)
        throw new Error('Invalid playback generation');
      if (frame.generation < this.generation) return false;
      if (frame.generation !== this.generation)
        throw new Error(
          'Playback generation has not been acknowledged by flush',
        );
      if (this.speakerMuted || frame.generation <= this.mutedGeneration)
        return false;
      if (
        !Number.isSafeInteger(frame.sequence) ||
        frame.sequence <= this.lastSequence ||
        (!this.allowSequenceGap && frame.sequence !== this.lastSequence + 1) ||
        !(frame.pcm instanceof Uint8Array) ||
        !frame.pcm.byteLength ||
        frame.pcm.byteLength % 2 ||
        frame.pcm.byteLength > 1920
      )
        throw new Error('Malformed or discontinuous playback frame');
      const context = this.playback;
      if (!context || context.state !== 'running')
        throw new Error('Speaker audio is unavailable');
      if (this.sources.size >= 4)
        throw new Error('Speaker playback backlog exceeded');
      // The buffer carries its real 24 kHz rate; Web Audio resamples to device output.
      const buffer = context.createBuffer(1, frame.pcm.byteLength / 2, 24000);
      const samples = buffer.getChannelData(0);
      const pcm = new DataView(
        frame.pcm.buffer,
        frame.pcm.byteOffset,
        frame.pcm.byteLength,
      );
      for (let index = 0; index < samples.length; index++)
        samples[index] = pcm.getInt16(index * 2, true) / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (!this.sources.delete(source)) return;
        source.onended = null;
        source.disconnect();
        if (
          this.stopped ||
          frame.generation !== this.generation ||
          this.speakerMuted
        )
          return;
        try {
          this.options.onPlayed({
            generation: frame.generation,
            sequence: frame.sequence,
            playedSamples: samples.length,
          });
        } catch (error) {
          this.fail(error);
        }
      };
      this.sources.add(source);
      const start = Math.max(context.currentTime, this.nextPlaybackTime);
      source.start(start);
      this.nextPlaybackTime = start + buffer.duration;
      this.lastSequence = frame.sequence;
      this.allowSequenceGap = false;
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  /** Synchronous software flush; the caller may acknowledge it after this returns. */
  flush(generation: number): void {
    if (this.stopped) return;
    if (!Number.isSafeInteger(generation) || generation < 0) {
      this.fail(new Error('Invalid playback flush generation'));
      return;
    }
    if (generation < this.generation) return;
    if (generation > this.generation) this.allowSequenceGap = true;
    this.generation = generation;
    this.clearPlayback();
  }

  setSpeakerMuted(muted: boolean): void {
    if (this.stopped || this.speakerMuted === muted) return;
    this.speakerMuted = muted;
    if (muted) {
      this.mutedGeneration = this.generation;
      this.clearPlayback();
    }
    // A newer server flush is required before output resumes, rejecting late chunks
    // from the muted generation even when unmute races the control response.
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.muteCapture();
    this.clearPlayback();
    const context = this.playback;
    this.playback = undefined;
    if (context) {
      if (this.playbackStateListener)
        context.removeEventListener('statechange', this.playbackStateListener);
      closeContext(context);
    }
    this.playbackStateListener = undefined;
  }

  private clearPlayback(): void {
    const sources = [...this.sources];
    this.sources.clear();
    for (const source of sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* Already stopped by the audio device. */
      }
      source.disconnect();
    }
    this.nextPlaybackTime = 0;
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stop();
    this.options.onError(errorOf(error));
  }
}
