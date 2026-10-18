import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalVoiceAudio } from '../src/client/local-voice/audio';

class FakeTrack extends EventTarget {
  readyState = 'live';
  stops = 0;
  stop() {
    this.stops++;
    this.readyState = 'ended';
  }
  getSettings() {
    return { sampleRate: 48000, channelCount: 1, echoCancellation: true };
  }
  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}
class FakeNode {
  connected = false;
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}
class FakeSource extends FakeNode {
  buffer?: { duration: number; samples: Float32Array; sampleRate: number };
  onended: (() => void) | null = null;
  starts: number[] = [];
  stops = 0;
  start(time: number) {
    this.starts.push(time);
  }
  stop() {
    this.stops++;
    this.onended?.();
  }
  finish() {
    this.onended?.();
  }
}
class FakeContext extends EventTarget {
  static instances: FakeContext[] = [];
  static actualCaptureRate = 16000;
  static addModule = async (_url: string) => {};
  static resume = async () => {};
  state = 'running';
  currentTime = 4;
  sampleRate: number;
  sources: FakeSource[] = [];
  captureSource = new FakeNode();
  destination = new FakeNode();
  closed = false;
  audioWorklet = { addModule: (url: string) => FakeContext.addModule(url) };
  constructor(options?: AudioContextOptions) {
    super();
    this.sampleRate = options?.sampleRate
      ? FakeContext.actualCaptureRate
      : 48000;
    FakeContext.instances.push(this);
  }
  async resume() {
    await FakeContext.resume();
  }
  async close() {
    this.closed = true;
    this.state = 'closed';
    this.dispatchEvent(new Event('statechange'));
  }
  createMediaStreamSource() {
    return this.captureSource;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const samples = new Float32Array(length);
    return {
      samples,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => samples,
    };
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  interrupt() {
    this.state = 'suspended';
    this.dispatchEvent(new Event('statechange'));
  }
}
class FakeWorklet extends FakeNode {
  static instances: FakeWorklet[] = [];
  onprocessorerror: (() => void) | null = null;
  replies: unknown[] = [];
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: unknown) => this.replies.push(message),
    close: vi.fn(),
  };
  constructor(
    _context: FakeContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    super();
    FakeWorklet.instances.push(this);
  }
  frame(sequence: number, bytes = 1024) {
    this.message({ type: 'frame', sequence, pcm: new ArrayBuffer(bytes) });
  }
  message(data: unknown) {
    this.port.onmessage?.({ data });
  }
}
const callbacks = () => ({
  onFrame: vi.fn(),
  onError: vi.fn(),
  onPlayed: vi.fn(),
  onCaptureSettings: vi.fn(),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const pcm = (samples = 960) => new Uint8Array(samples * 2);
let tracks: FakeTrack[];
let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  tracks = [new FakeTrack()];
  FakeContext.instances = [];
  FakeContext.actualCaptureRate = 16000;
  FakeContext.addModule = async () => {};
  FakeContext.resume = async () => {};
  FakeWorklet.instances = [];
  getUserMedia = vi.fn(async () => ({
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
});
afterEach(() => vi.unstubAllGlobals());

describe('browser microphone lifecycle', () => {
  it('does not acquire until explicit start and requests processed mono capture', async () => {
    const events = callbacks();
    const audio = new LocalVoiceAudio(events);
    expect(getUserMedia).not.toHaveBeenCalled();
    await audio.startCapture();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    expect(FakeContext.instances[0].sampleRate).toBe(16000);
    expect(events.onCaptureSettings).toHaveBeenCalledWith({
      sampleRate: 48000,
      channelCount: 1,
      echoCancellation: true,
    });
    FakeWorklet.instances[0].frame(0);
    expect(events.onFrame).toHaveBeenCalledWith({ sequence: 0, pcm: pcm(512) });
    audio.stop();
  });

  it('releases all tracks on mute and reacquires only on explicit unmute', async () => {
    tracks.push(new FakeTrack());
    const events = callbacks();
    const audio = new LocalVoiceAudio(events);
    await audio.startCapture();
    const firstWorklet = FakeWorklet.instances[0];
    firstWorklet.frame(0);
    audio.muteCapture();
    expect(tracks.every((track) => track.stops === 1)).toBe(true);
    expect(FakeContext.instances[0].closed).toBe(true);
    firstWorklet.frame(1);
    expect(events.onFrame).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    tracks = [new FakeTrack()];
    await audio.startCapture();
    FakeWorklet.instances[1].frame(0);
    expect(events.onFrame).toHaveBeenLastCalledWith({
      sequence: 1,
      pcm: pcm(512),
    });
    audio.stop();
  });

  it('coalesces concurrent starts without opening a second microphone', async () => {
    const pending = deferred<void>();
    FakeContext.resume = () => pending.promise;
    const audio = new LocalVoiceAudio(callbacks());
    const first = audio.startCapture();
    const second = audio.startCapture();
    pending.resolve();
    await Promise.all([first, second]);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    audio.stop();
  });

  it('rejects unsupported context rates before acquiring microphone input', async () => {
    FakeContext.actualCaptureRate = 48000;
    const audio = new LocalVoiceAudio(callbacks());
    await expect(audio.startCapture()).rejects.toThrow(/16.*kHz/);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(FakeContext.instances[0].closed).toBe(true);
  });

  it('closes the context when microphone permission is denied', async () => {
    getUserMedia.mockRejectedValue(new Error('Permission denied'));
    const audio = new LocalVoiceAudio(callbacks());
    await expect(audio.startCapture()).rejects.toThrow('Permission denied');
    expect(FakeContext.instances[0].closed).toBe(true);
  });

  it('stops late permission results after hangup', async () => {
    const pending = deferred<unknown>();
    getUserMedia.mockReturnValue(pending.promise);
    const events = callbacks();
    const audio = new LocalVoiceAudio(events);
    const start = audio.startCapture();
    audio.stop();
    pending.resolve({ getTracks: () => tracks, getAudioTracks: () => tracks });
    await expect(start).rejects.toThrow(/cancel|stopp/i);
    expect(tracks[0].stops).toBe(1);
    expect(FakeContext.instances[0].closed).toBe(true);
    expect(events.onFrame).not.toHaveBeenCalled();
  });

  it('stops a late stream after worklet loading failed', async () => {
    const pending = deferred<unknown>();
    getUserMedia.mockReturnValue(pending.promise);
    FakeContext.addModule = async () => {
      throw new Error('Worklet unavailable');
    };
    const audio = new LocalVoiceAudio(callbacks());
    await expect(audio.startCapture()).rejects.toThrow('Worklet unavailable');
    pending.resolve({ getTracks: () => tracks, getAudioTracks: () => tracks });
    await Promise.resolve();
    expect(tracks[0].stops).toBe(1);
    expect(FakeContext.instances[0].closed).toBe(true);
  });

  it('keeps an explicit reacquisition alive when an older muted startup completes', async () => {
    const firstModule = deferred<void>();
    let loads = 0;
    FakeContext.addModule = () =>
      ++loads === 1 ? firstModule.promise : Promise.resolve();
    const oldTrack = tracks[0];
    getUserMedia.mockResolvedValueOnce({
      getTracks: () => [oldTrack],
      getAudioTracks: () => [oldTrack],
    });
    const events = callbacks();
    const audio = new LocalVoiceAudio(events);
    const first = audio.startCapture();
    await Promise.resolve();
    audio.muteCapture();
    tracks = [new FakeTrack()];
    await audio.startCapture();
    firstModule.resolve();
    await expect(first).rejects.toThrow(/cancel|stopp/i);
    FakeWorklet.instances[0].frame(0);
    expect(events.onFrame).toHaveBeenCalledTimes(1);
    expect(oldTrack.stops).toBe(1);
    expect(tracks[0].stops).toBe(0);
    expect(FakeContext.instances[1].closed).toBe(false);
    audio.stop();
  });

  it('releases capture if output startup fails', async () => {
    const audio = new LocalVoiceAudio(callbacks());
    await audio.startCapture();
    FakeContext.resume = async () => {
      throw new Error('Output unavailable');
    };
    await expect(audio.startPlayback()).rejects.toThrow('Output unavailable');
    expect(tracks[0].stops).toBe(1);
    expect(FakeContext.instances.every((context) => context.closed)).toBe(true);
  });

  it('releases both devices if the synchronous frame consumer rejects a frame', async () => {
    const events = callbacks();
    events.onFrame.mockImplementation(() => {
      throw new Error('Input queue exceeded');
    });
    const audio = new LocalVoiceAudio(events);
    await Promise.all([audio.startCapture(), audio.startPlayback()]);
    FakeWorklet.instances[0].frame(0);
    expect(events.onError).toHaveBeenCalledExactlyOnceWith(
      new Error('Input queue exceeded'),
    );
    expect(tracks[0].stops).toBe(1);
    expect(FakeContext.instances.every((context) => context.closed)).toBe(true);
  });

  it.each([
    'ended',
    'processor',
    'context',
    'frame gap',
    'frame size',
    'overflow',
  ])(
    'ends and releases capture and playback after %s failure',
    async (failure) => {
      const events = callbacks();
      const audio = new LocalVoiceAudio(events);
      await Promise.all([audio.startCapture(), audio.startPlayback()]);
      audio.play({ generation: 0, sequence: 0, pcm: pcm() });
      const worklet = FakeWorklet.instances[0];
      if (failure === 'ended') tracks[0].end();
      if (failure === 'processor') worklet.onprocessorerror?.();
      if (failure === 'context') FakeContext.instances[0].interrupt();
      if (failure === 'frame gap') worklet.frame(1);
      if (failure === 'frame size') worklet.frame(0, 1022);
      if (failure === 'overflow')
        worklet.message({ type: 'error', message: 'Capture backlog exceeded' });
      expect(events.onError).toHaveBeenCalledTimes(1);
      expect(tracks[0].stops).toBe(1);
      expect(FakeContext.instances.every((context) => context.closed)).toBe(
        true,
      );
      expect(events.onPlayed).not.toHaveBeenCalled();
    },
  );
});

describe('bounded PCM playback', () => {
  it('fails and releases a playback context whose resume is blocked by browser activation', async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    FakeContext.resume = () => pending.promise;
    const audio = new LocalVoiceAudio(callbacks());
    let failure: unknown;
    const starting = audio.startPlayback().catch((error) => {
      failure = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/audio.*start|playback.*blocked/i);
      expect(FakeContext.instances[0].closed).toBe(true);
      pending.resolve();
      await starting;
    } finally {
      audio.stop();
      vi.useRealTimers();
    }
  });

  it('converts little-endian PCM at 24 kHz and ACKs only natural completion', async () => {
    const events = callbacks();
    const audio = new LocalVoiceAudio(events);
    await audio.startPlayback();
    const bytes = new Uint8Array([0, 128, 0, 0, 255, 127]);
    expect(audio.play({ generation: 0, sequence: 0, pcm: bytes })).toBe(true);
    const source = FakeContext.instances[0].sources[0];
    expect(source.buffer?.sampleRate).toBe(24000);
    expect(source.buffer?.samples[0]).toBe(-1);
    expect(source.buffer?.samples[1]).toBe(0);
    expect(source.buffer?.samples[2]).toBeCloseTo(32767 / 32768);
    expect(events.onPlayed).not.toHaveBeenCalled();
    source.finish();
    expect(events.onPlayed).toHaveBeenCalledExactlyOnceWith({
      generation: 0,
      sequence: 0,
      playedSamples: 3,
    });
    audio.stop();
  });

  it('schedules sequentially and ends the call if four queued frames overflow', async () => {
    const events = callbacks();
    const audio = new LocalVoiceAudio(events);
    await audio.startPlayback();
    for (let sequence = 0; sequence < 4; sequence++) {
      expect(audio.play({ generation: 0, sequence, pcm: pcm() })).toBe(true);
    }
    const context = FakeContext.instances[0];
    expect(context.sources[0].starts).toEqual([4]);
    expect(context.sources[1].starts[0]).toBeCloseTo(4.04);
    expect(context.sources[3].starts[0]).toBeCloseTo(4.12);
    expect(audio.play({ generation: 0, sequence: 4, pcm: pcm() })).toBe(false);
    expect(events.onError).toHaveBeenCalledTimes(1);
    expect(context.sources.every((source) => source.stops === 1)).toBe(true);
    expect(events.onPlayed).not.toHaveBeenCalled();
  });

  it('flushes every active source and rejects stale chunks and late completions', async () => {
    const events = callbacks();
    const audio = new LocalVoiceAudio(events);
    await audio.startPlayback();
    audio.play({ generation: 0, sequence: 0, pcm: pcm() });
    audio.play({ generation: 0, sequence: 1, pcm: pcm() });
    const sources = FakeContext.instances[0].sources;
    const lateEnd = sources[0].onended;
    audio.flush(1);
    lateEnd?.();
    expect(sources.map((source) => source.stops)).toEqual([1, 1]);
    expect(events.onPlayed).not.toHaveBeenCalled();
    expect(audio.play({ generation: 0, sequence: 2, pcm: pcm() })).toBe(false);
    expect(audio.play({ generation: 1, sequence: 3, pcm: pcm() })).toBe(true);
    sources[2].finish();
    expect(events.onPlayed).toHaveBeenCalledExactlyOnceWith({
      generation: 1,
      sequence: 3,
      playedSamples: 960,
    });
    audio.stop();
  });

  it('does not rewind a generation when a stale flush arrives', async () => {
    const events = callbacks();
    const audio = new LocalVoiceAudio(events);
    await audio.startPlayback();
    audio.flush(2);
    audio.play({ generation: 2, sequence: 5, pcm: pcm() });
    audio.flush(1);
    FakeContext.instances[0].sources[0].finish();
    expect(events.onPlayed).toHaveBeenCalledExactlyOnceWith({
      generation: 2,
      sequence: 5,
      playedSamples: 960,
    });
    audio.stop();
  });

  it('speaker mute flushes immediately and cannot accumulate or replay old output', async () => {
    const events = callbacks();
    const audio = new LocalVoiceAudio(events);
    await audio.startPlayback();
    audio.play({ generation: 0, sequence: 0, pcm: pcm() });
    audio.setSpeakerMuted(true);
    expect(FakeContext.instances[0].sources[0].stops).toBe(1);
    expect(audio.play({ generation: 0, sequence: 1, pcm: pcm() })).toBe(false);
    audio.setSpeakerMuted(false);
    expect(audio.play({ generation: 0, sequence: 2, pcm: pcm() })).toBe(false);
    audio.flush(1);
    expect(audio.play({ generation: 1, sequence: 3, pcm: pcm() })).toBe(true);
    expect(events.onPlayed).not.toHaveBeenCalled();
    audio.stop();
  });

  it.each([
    { generation: 0, sequence: 0, pcm: pcm(0) },
    { generation: 0, sequence: 0, pcm: new Uint8Array(3) },
    { generation: 0, sequence: 0, pcm: pcm(961) },
    { generation: 1, sequence: 0, pcm: pcm() },
    { generation: 0, sequence: 2, pcm: pcm() },
  ])('rejects malformed or discontinuous playback %#', async (frame) => {
    const events = callbacks();
    const audio = new LocalVoiceAudio(events);
    await audio.startPlayback();
    expect(audio.play(frame)).toBe(false);
    expect(events.onError).toHaveBeenCalledTimes(1);
    expect(FakeContext.instances[0].closed).toBe(true);
  });

  it('rejects duplicate sequence numbers across generation changes', async () => {
    const events = callbacks();
    const audio = new LocalVoiceAudio(events);
    await audio.startPlayback();
    audio.play({ generation: 0, sequence: 0, pcm: pcm() });
    audio.flush(1);
    expect(audio.play({ generation: 1, sequence: 0, pcm: pcm() })).toBe(false);
    expect(events.onError).toHaveBeenCalledTimes(1);
  });

  it('closes late playback startup after stop without resuming the call', async () => {
    const pending = deferred<void>();
    FakeContext.resume = () => pending.promise;
    const audio = new LocalVoiceAudio(callbacks());
    const start = audio.startPlayback();
    audio.stop();
    pending.resolve();
    await expect(start).rejects.toThrow(/cancel|stopp/i);
    expect(FakeContext.instances[0].closed).toBe(true);
    expect(audio.play({ generation: 0, sequence: 0, pcm: pcm() })).toBe(false);
  });

  it('ends the call if the speaker context is interrupted', async () => {
    const events = callbacks();
    const audio = new LocalVoiceAudio(events);
    await Promise.all([audio.startPlayback(), audio.startCapture()]);
    FakeContext.instances[0].interrupt();
    expect(events.onError).toHaveBeenCalledTimes(1);
    expect(tracks[0].stops).toBe(1);
    expect(FakeContext.instances.every((context) => context.closed)).toBe(true);
  });
});

interface Processor {
  port: {
    onmessage?: (event: { data: unknown }) => void;
    messages: Record<string, unknown>[];
  };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
function processor(rate = 16000): Processor {
  let ProcessorClass!: new () => Processor;
  runInNewContext(
    readFileSync(
      new URL('../src/client/local-voice/capture-worklet.js', import.meta.url),
      'utf8',
    ),
    {
      sampleRate: rate,
      ArrayBuffer,
      DataView,
      AudioWorkletProcessor: class {
        port = {
          messages: [] as Record<string, unknown>[],
          postMessage(message: Record<string, unknown>) {
            this.messages.push(message);
          },
        };
      },
      registerProcessor: (
        _name: string,
        implementation: new () => Processor,
      ) => {
        ProcessorClass = implementation;
      },
    },
  );
  return new ProcessorClass();
}
describe('capture worklet', () => {
  it('emits a same-origin production worklet asset for the script-src self policy', async () => {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        rolldownOptions: {
          input: fileURLToPath(
            new URL('../src/client/local-voice/audio.ts', import.meta.url),
          ),
          preserveEntrySignatures: 'strict',
        },
      },
    });
    const bundles = Array.isArray(result) ? result : [result];
    const output = bundles.flatMap((bundle) =>
      'output' in bundle ? bundle.output : [],
    );
    const asset = output.find(
      (item) =>
        item.type === 'asset' && item.fileName.includes('capture-worklet'),
    );
    const entry = output.find((item) => item.type === 'chunk' && item.isEntry);
    expect(asset).toBeDefined();
    expect(
      entry?.type === 'chunk' && entry.code.includes(`/${asset!.fileName}`),
    ).toBe(true);
  });

  it('packs variable render quanta into 512-sample little-endian frames without monitoring', () => {
    const worklet = processor();
    const monitor = new Float32Array(128).fill(1);
    const samples = new Float32Array(512);
    samples.set([-2, -1, -0.5, 0, 0.5, 1, 2, NaN]);
    worklet.process([[samples.subarray(0, 129)]], [[monitor]]);
    expect(worklet.port.messages).toHaveLength(0);
    expect(monitor.every((value) => value === 0)).toBe(true);
    worklet.process([[samples.subarray(129)]], [[monitor]]);
    expect(worklet.port.messages).toHaveLength(1);
    const message = worklet.port.messages[0];
    expect(message.type).toBe('frame');
    expect(message.sequence).toBe(0);
    expect(new Uint8Array(message.pcm as ArrayBuffer).slice(0, 16)).toEqual(
      new Uint8Array([
        0, 128, 0, 128, 0, 192, 0, 0, 0, 64, 255, 127, 255, 127, 0, 0,
      ]),
    );
  });

  it('bounds unacknowledged frames and fails instead of silently dropping a gap', () => {
    const worklet = processor();
    const input = [[new Float32Array(512)]];
    for (let index = 0; index < 8; index++)
      expect(worklet.process(input, [])).toBe(true);
    expect(worklet.port.messages).toHaveLength(8);
    expect(worklet.process(input, [])).toBe(false);
    expect(worklet.port.messages).toHaveLength(9);
    expect(worklet.port.messages[8].type).toBe('error');
    worklet.process(input, []);
    expect(worklet.port.messages).toHaveLength(9);
  });

  it('releases only a matching frame credit and keeps its sequence monotonic', () => {
    const worklet = processor();
    const input = [[new Float32Array(512)]];
    worklet.process(input, []);
    worklet.port.onmessage?.({ data: { type: 'ack', sequence: 0 } });
    worklet.port.onmessage?.({ data: { type: 'ack', sequence: 0 } });
    for (let index = 0; index < 8; index++) worklet.process(input, []);
    expect(worklet.port.messages.at(-1)?.sequence).toBe(8);
    expect(worklet.process(input, [])).toBe(false);
  });

  it('refuses an unexpected audio-thread rate', () => {
    const worklet = processor(48000);
    expect(worklet.process([[new Float32Array(512)]], [])).toBe(false);
    expect(worklet.port.messages).toHaveLength(1);
    expect(worklet.port.messages[0].type).toBe('error');
  });
});
