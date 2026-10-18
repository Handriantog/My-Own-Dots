import { expect, it, vi } from 'vitest';
import {
  LocalVoicePrototype,
  type PrototypePlatform,
  type SpeechEngine,
  type AudioSink,
} from '../src/server/local-voice/prototype.js';

function fixture() {
  const release = vi.fn();
  const platform: PrototypePlatform = {
    workspace: { requireThread: vi.fn(() => ({ dotId: 'dot' })) },
    memory: { enterForeground: vi.fn(async () => release) },
    turn: vi.fn(async () => 'A safe answer.'),
  };
  const engine: SpeechEngine = {
    warm: vi.fn(async () => {}),
    transcribe: vi.fn(async () => ({
      text: 'Hello',
      language: 'en',
      segments: [{ startMs: 0, endMs: 500, text: 'Hello' }],
    })),
    synthesize: vi.fn(async () => Buffer.alloc(4800)),
    close: vi.fn(async () => {}),
  };
  const sink: AudioSink = {
    write: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  };
  const call = new LocalVoicePrototype(platform, 'thread', engine, sink);
  return { call, platform, engine, sink, release };
}
const input = {
  utteranceId: 'utterance-1',
  pcm: Buffer.alloc(16000),
  sampleRate: 16000 as const,
  channels: 1 as const,
  language: 'en' as const,
};

it('holds foreground through silence, commits once through the bound thread and separates queued from played audio', async () => {
  const f = fixture();
  await f.call.start();
  expect(f.release).not.toHaveBeenCalled();
  const result = await f.call.commit(input);
  expect(f.platform.turn).toHaveBeenCalledWith(
    'thread',
    'Hello',
    expect.any(AbortSignal),
    expect.objectContaining({ opendotsSource: 'local_voice_prototype' }),
  );
  expect(f.engine.synthesize).toHaveBeenCalledWith(
    'A safe answer.',
    expect.any(AbortSignal),
  );
  expect(result.delivery).toEqual({
    generatedSamples: 2400,
    acceptedSamples: 2400,
    playedSamples: null,
  });
  const frames = vi.mocked(f.sink.write).mock.calls.map(([frame]) => frame);
  expect(frames.map((f) => f.sequence)).toEqual([0, 1, 2]);
  expect(
    frames.every(
      (frame) => frame.pcm.length <= 1920 && frame.callId === f.call.callId,
    ),
  ).toBe(true);
  await expect(f.call.commit(input)).rejects.toThrow(/already committed/);
  expect(f.platform.turn).toHaveBeenCalledOnce();
  await f.call.end();
  await f.call.end();
  expect(f.release).toHaveBeenCalledOnce();
});

it('rejects invalid formats, oversized input and changed scope before transcription', async () => {
  const f = fixture();
  await f.call.start();
  await expect(
    f.call.commit({ ...input, sampleRate: 48000 as never }),
  ).rejects.toThrow(/16 kHz/);
  await expect(
    f.call.commit({ ...input, pcm: Buffer.alloc(960002) }),
  ).rejects.toThrow(/30 seconds/);
  vi.mocked(f.platform.workspace.requireThread).mockReturnValue({
    dotId: 'foreign',
  });
  await expect(f.call.commit(input)).rejects.toThrow(/scope/);
  expect(f.engine.transcribe).not.toHaveBeenCalled();
  await f.call.end();
});

it('applies backpressure and discards late output after interruption', async () => {
  const f = fixture();
  let acknowledge!: () => void;
  vi.mocked(f.sink.write).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  await f.call.start();
  const pending = f.call.commit(input);
  const rejected = expect(pending).rejects.toThrow(/interrupt/i);
  await vi.waitFor(() => expect(f.sink.write).toHaveBeenCalledOnce());
  expect(f.engine.synthesize).toHaveBeenCalledOnce();
  await f.call.interrupt();
  acknowledge();
  await rejected;
  expect(f.sink.write).toHaveBeenCalledOnce();
  expect(f.sink.flush).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledOnce();
});

it('rejects concurrent commits and never speaks a failed turn', async () => {
  const f = fixture();
  let fail!: (reason: Error) => void;
  vi.mocked(f.platform.turn).mockImplementation(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  await f.call.start();
  const pending = f.call.commit(input);
  const rejected = expect(pending).rejects.toThrow('Runtime failed');
  await vi.waitFor(() => expect(f.platform.turn).toHaveBeenCalledOnce());
  await expect(
    f.call.commit({ ...input, utteranceId: 'another' }),
  ).rejects.toThrow(/busy/);
  fail(new Error('Runtime failed'));
  await rejected;
  expect(f.engine.synthesize).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});

it('ends during warmup without leaking foreground or becoming ready later', async () => {
  const f = fixture();
  let warm!: () => void;
  vi.mocked(f.engine.warm).mockImplementation(
    () =>
      new Promise((resolve) => {
        warm = resolve;
      }),
  );
  const starting = f.call.start();
  const rejected = expect(starting).rejects.toThrow(/ended/i);
  await vi.waitFor(() => expect(f.engine.warm).toHaveBeenCalledOnce());
  await f.call.end();
  warm();
  await rejected;
  expect(f.call.state).toBe('ended');
  expect(f.release).toHaveBeenCalledOnce();
});

it('bounds speech and malformed PCM and releases after worker failure', async () => {
  for (const mode of ['text', 'pcm', 'worker']) {
    const f = fixture();
    if (mode === 'text')
      vi.mocked(f.platform.turn).mockResolvedValue('a'.repeat(401));
    if (mode === 'pcm')
      vi.mocked(f.engine.synthesize).mockResolvedValue(Buffer.alloc(3));
    if (mode === 'worker')
      vi.mocked(f.engine.transcribe).mockRejectedValue(
        new Error('worker failed'),
      );
    await f.call.start();
    await expect(f.call.commit(input)).rejects.toThrow();
    expect(f.sink.write).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  }
});

it('allows only one call per Platform and never speaks a late model completion', async () => {
  const f = fixture();
  const second = new LocalVoicePrototype(
    f.platform,
    'thread',
    f.engine,
    f.sink,
  );
  await f.call.start();
  await expect(second.start()).rejects.toThrow(/already active/);
  let finish!: (text: string) => void;
  vi.mocked(f.platform.turn).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.call.commit(input);
  const rejected = expect(pending).rejects.toThrow(/ended/);
  await vi.waitFor(() => expect(f.platform.turn).toHaveBeenCalledOnce());
  await f.call.end();
  finish('A late answer that must stay silent.');
  await rejected;
  expect(f.engine.synthesize).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});

it('releases a reservation acquired after the call has already ended', async () => {
  const f = fixture();
  let acquire!: (release: () => void) => void;
  vi.mocked(f.platform.memory!.enterForeground).mockImplementation(
    () =>
      new Promise((resolve) => {
        acquire = resolve;
      }),
  );
  const pending = f.call.start();
  const rejected = expect(pending).rejects.toThrow(/ended/);
  await f.call.end();
  acquire(f.release);
  await rejected;
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.engine.warm).not.toHaveBeenCalled();
});
