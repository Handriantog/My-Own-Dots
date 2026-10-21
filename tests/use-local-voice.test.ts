import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import type { LocalVoiceEvent } from '../src/shared/local-voice';
import { useLocalVoice } from '../src/client/local-voice/useLocalVoice';
import type { VoiceQuality } from '../src/shared/voice-settings';

const audio = vi.hoisted(() => ({ instances: [] as FakeAudio[] }));
vi.mock('../src/client/api', () => ({
  authHeaders: () => ({ Authorization: 'Bearer owner' }),
}));
vi.mock('../src/client/local-voice/audio', () => ({
  LocalVoiceAudio: class {
    startCapture = vi.fn(async () => {});
    startPlayback = vi.fn(async () => {});
    muteCapture = vi.fn();
    play = vi.fn(() => true);
    flush = vi.fn();
    setSpeakerMuted = vi.fn();
    stop = vi.fn();
    constructor(readonly options: FakeAudio['options']) {
      audio.instances.push(this);
    }
  },
}));
interface FakeAudio {
  options: {
    onFrame(frame: { sequence: number; pcm: Uint8Array }): void;
    onPlayed(frame: {
      generation: number;
      sequence: number;
      playedSamples: number;
    }): void;
    onError(error: Error): void;
  };
  startCapture: ReturnType<typeof vi.fn>;
  startPlayback: ReturnType<typeof vi.fn>;
  muteCapture: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  setSpeakerMuted: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let voice: ReturnType<typeof useLocalVoice>;
let quality: VoiceQuality = 'medium';
let root: ReactTestRenderer;
let fetchMock: ReturnType<typeof vi.fn>;
let stream: ReadableStreamDefaultController<Uint8Array>;
let onTranscript: Mock<
  (transcript: { messageId: string; text: string }) => Promise<void>
>;
let onCancelTranscript: Mock<(messageId: string) => Promise<void>>;
let onSaved: Mock<() => void>;
let nativeStop: (reason: string) => void;
let windowEvents: EventTarget;
let documentEvents: EventTarget & { visibilityState: string };
let bridge: {
  begin: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  reviewFolders: ReturnType<typeof vi.fn>;
  onStop: ReturnType<typeof vi.fn>;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const controls = (action: string) =>
  fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url).endsWith('/control') &&
      JSON.parse(init.body).action === action,
  );
function Hook() {
  voice = useLocalVoice({
    threadId: 'thread',
    dotId: 'dot',
    quality,
    onTranscript,
    onCancelTranscript,
    onSaved,
  });
  return null;
}
async function emit(event: LocalVoiceEvent, fragmented = false) {
  await act(async () => {
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify(event)}\n\n`,
    );
    if (fragmented) {
      stream.enqueue(bytes.slice(0, 7));
      stream.enqueue(bytes.slice(7));
    } else stream.enqueue(bytes);
    await Promise.resolve();
  });
}
beforeEach(async () => {
  quality = 'medium';
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  audio.instances.length = 0;
  onTranscript = vi.fn(async () => {});
  onCancelTranscript = vi.fn(async () => {});
  onSaved = vi.fn();
  windowEvents = new EventTarget();
  documentEvents = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
  });
  bridge = {
    begin: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    reviewFolders: vi.fn(async () => {}),
    onStop: vi.fn((callback: (reason: string) => void) => {
      nativeStop = callback;
      return () => {};
    }),
  };
  vi.stubGlobal('window', Object.assign(windowEvents, { dotVoice: bridge }));
  vi.stubGlobal('document', documentEvents);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/calls'))
      return json({ id: 'call', token: 'capability' });
    if (url.endsWith('/events')) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      });
      init?.signal?.addEventListener('abort', () => {
        try {
          stream.close();
        } catch {
          /* A terminal stream may already be closed. */
        }
      });
      return new Response(body, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    root = create(createElement(Hook));
  });
});
it('captures Basic input and displays text without initializing playback or accepting audio', async () => {
  quality = 'basic';
  await act(async () => root.update(createElement(Hook)));
  fetchMock.mockImplementationOnce(async () =>
    json({ id: 'call', token: 'capability', quality: 'basic' }),
  );
  await act(async () => {
    await voice.start();
  });
  expect(audio.instances[0].startPlayback).not.toHaveBeenCalled();
  expect(audio.instances[0].startCapture).toHaveBeenCalledOnce();
  expect(bridge.begin).toHaveBeenCalledWith('call', 'basic');
  await emit({ type: 'caption', text: 'Your answer is in chat.' });
  expect(voice.caption).toBe('Your answer is in chat.');
  await emit({ type: 'audio', generation: 0, sequence: 0, pcm: btoa('\0\0') });
  await act(async () => voice.toggleSpeaker());
  expect(audio.instances[0].play).not.toHaveBeenCalled();
  expect(controls('played')).toHaveLength(0);
  expect(controls('speaker')).toHaveLength(0);
  expect(voice.quality).toBe('basic');
  await act(async () => voice.toggleMute());
  expect(voice.muted).toBe(true);
  expect(controls('mute')).toHaveLength(1);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('unlocks playback in the click, waits for warm setup and event connection before microphone capture', async () => {
  const created = deferred<Response>();
  const connected = deferred<Response>();
  fetchMock
    .mockImplementationOnce(() => created.promise)
    .mockImplementationOnce(() => connected.promise);
  let start!: Promise<void>;
  await act(async () => {
    start = voice.start();
  });
  const current = audio.instances[0];
  expect(current.startPlayback).toHaveBeenCalledTimes(1);
  expect(current.startCapture).not.toHaveBeenCalled();
  await act(async () => {
    created.resolve(json({ id: 'call', token: 'capability' }));
  });
  expect(bridge.begin).toHaveBeenCalledWith('call');
  expect(current.startCapture).not.toHaveBeenCalled();
  await act(async () => {
    connected.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    await start;
  });
  expect(current.startCapture).toHaveBeenCalledTimes(1);
  expect(voice.status).toBe('active');
  const [, init] = fetchMock.mock.calls.find(([url]) =>
    url.endsWith('/events'),
  )!;
  expect(init.headers).toMatchObject({
    Authorization: 'Bearer owner',
    'X-Dot-Voice-Token': 'capability',
  });
});

it('submits each transcript once without blocking SSE or approval polling on the agent promise', async () => {
  const agent = deferred<void>();
  onTranscript.mockReturnValue(agent.promise);
  await act(async () => {
    await voice.start();
  });
  await emit({ type: 'flush', generation: 1 });
  await emit(
    { type: 'transcript', generation: 1, messageId: 'message', text: 'Hello' },
    true,
  );
  await emit({
    type: 'transcript',
    generation: 1,
    messageId: 'message',
    text: 'Hello',
  });
  await emit({ type: 'phase', phase: 'approval' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(onTranscript).toHaveBeenCalledExactlyOnceWith({
    messageId: 'message',
    text: 'Hello',
  });
  expect(voice.phase).toBe('approval');
  expect(controls('answer').length).toBeGreaterThan(0);
  expect(JSON.parse(controls('answer')[0][1].body)).toEqual({
    action: 'answer',
    messageId: 'message',
  });
  agent.resolve();
});

it('checks the canonical answer at run completion without waiting for the 500 ms poll', async () => {
  const run = deferred<void>();
  onTranscript.mockReturnValue(run.promise);
  await act(async () => {
    await voice.start();
  });
  await emit({
    type: 'transcript',
    generation: 0,
    messageId: 'finished',
    text: 'Hello',
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(175);
  });
  expect(controls('answer')).toHaveLength(0);
  await act(async () => {
    run.resolve();
  });
  expect(controls('answer')).toHaveLength(1);
  expect(JSON.parse(controls('answer')[0][1].body)).toEqual({
    action: 'answer',
    messageId: 'finished',
  });
});

it('rechecks immediately after an in-flight answer poll when the run completes', async () => {
  const run = deferred<void>();
  const poll = deferred<Response>();
  onTranscript.mockReturnValue(run.promise);
  await act(async () => {
    await voice.start();
  });
  await emit({
    type: 'transcript',
    generation: 0,
    messageId: 'finished',
    text: 'Hello',
  });
  fetchMock.mockImplementationOnce(() => poll.promise);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(controls('answer')).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(175);
    run.resolve();
  });
  expect(controls('answer')).toHaveLength(1);
  await act(async () => {
    poll.resolve(json({}));
  });
  expect(controls('answer')).toHaveLength(2);
});

it('releases the ended session even if receipt refresh throws', async () => {
  await act(async () => {
    await voice.start();
  });
  onSaved.mockImplementation(() => {
    throw new Error('Receipt refresh unavailable');
  });
  await act(async () => {
    await expect(voice.end()).resolves.toBeUndefined();
  });
  expect(voice.status).toBe('idle');
  expect(audio.instances[0].stop).toHaveBeenCalledTimes(1);
  expect(bridge.end).toHaveBeenCalledWith('call');
});

it('shows recognition retry guidance without ending or reopening microphone capture', async () => {
  await act(async () => {
    await voice.start();
  });
  await emit({
    type: 'notice',
    text: 'I could not understand that. Please try again.',
  });
  expect(voice.status).toBe('active');
  await emit({ type: 'phase', phase: 'listening' });
  expect(voice.status).toBe('active');
  expect(voice.error).toBe('');
  expect(voice.notice).toBe('I could not understand that. Please try again.');
  expect(controls('end')).toHaveLength(0);
  expect(audio.instances[0].startCapture).toHaveBeenCalledTimes(1);
  expect(audio.instances[0].stop).not.toHaveBeenCalled();
  await emit({ type: 'phase', phase: 'thinking' });
  expect(voice.notice).toBe('');
});

it('clears a nonfatal speech notice when a new transcript arrives', async () => {
  await act(async () => {
    await voice.start();
  });
  await emit({ type: 'notice', text: 'Please try again.' });
  expect(voice.notice).toBe('Please try again.');
  await emit({
    type: 'transcript',
    generation: 0,
    messageId: 'retry',
    text: 'Hello again',
  });
  expect(voice.notice).toBe('');
  expect(onTranscript).toHaveBeenCalledExactlyOnceWith({
    messageId: 'retry',
    text: 'Hello again',
  });
});

it('waits for the previous interrupted agent callback before submitting the next transcript', async () => {
  const agent = deferred<void>();
  onTranscript.mockReturnValueOnce(agent.promise);
  await act(async () => {
    await voice.start();
  });
  await emit({ type: 'flush', generation: 1 });
  await emit({
    type: 'transcript',
    generation: 1,
    messageId: 'first',
    text: 'One',
  });
  await emit({ type: 'flush', generation: 2 });
  await emit({
    type: 'transcript',
    generation: 2,
    messageId: 'second',
    text: 'Two',
  });
  expect(onCancelTranscript).toHaveBeenCalledExactlyOnceWith('first');
  expect(onTranscript).toHaveBeenCalledTimes(1);
  await act(async () => {
    agent.resolve();
  });
  expect(onTranscript).toHaveBeenLastCalledWith({
    messageId: 'second',
    text: 'Two',
  });
});

it('retains answer polling only on a speaker-mute flush', async () => {
  await act(async () => {
    await voice.start();
  });
  await emit({ type: 'flush', generation: 1 });
  await emit({
    type: 'transcript',
    generation: 1,
    messageId: 'first',
    text: 'One',
  });
  await emit({ type: 'flush', generation: 2, keepTranscript: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  const afterSpeakerMute = controls('answer').length;
  expect(afterSpeakerMute).toBeGreaterThan(0);
  expect(onCancelTranscript).not.toHaveBeenCalled();
  await emit({ type: 'flush', generation: 3 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(controls('answer')).toHaveLength(afterSpeakerMute);
});

it('aborts the owned chat submission before disconnecting SSE or requesting server end', async () => {
  const run = deferred<void>();
  const cancellation = deferred<void>();
  onTranscript.mockReturnValue(run.promise);
  onCancelTranscript.mockReturnValue(cancellation.promise);
  await act(async () => {
    await voice.start();
  });
  await emit({
    type: 'transcript',
    generation: 0,
    messageId: 'owned',
    text: 'Hello',
  });
  const [, init] = fetchMock.mock.calls.find(([url]) =>
    url.endsWith('/events'),
  )!;
  let ended!: Promise<void>;
  await act(async () => {
    ended = voice.end();
  });
  expect(audio.instances[0].stop).toHaveBeenCalledTimes(1);
  expect(bridge.end).toHaveBeenCalledWith('call');
  expect(onCancelTranscript).toHaveBeenCalledExactlyOnceWith('owned');
  expect(init.signal.aborted).toBe(false);
  expect(controls('end')).toHaveLength(0);
  await act(async () => {
    run.resolve();
    cancellation.resolve();
    await ended;
  });
  expect(init.signal.aborted).toBe(true);
  expect(controls('end')).toHaveLength(1);
});

it('keeps the server alive while the microphone permission request is pending', async () => {
  const microphone = deferred<void>();
  const creation = deferred<Response>();
  fetchMock.mockImplementationOnce(() => creation.promise);
  let starting!: Promise<void>;
  await act(async () => {
    starting = voice.start();
  });
  audio.instances[0].startCapture.mockReturnValue(microphone.promise);
  await act(async () => {
    creation.resolve(json({ id: 'call', token: 'capability' }));
  });
  expect(voice.status).toBe('connecting');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(controls('heartbeat')).toHaveLength(2);
  await act(async () => {
    microphone.resolve();
    await starting;
  });
  expect(voice.status).toBe('active');
});

it('serializes rapid speaker toggles while applying local mute immediately', async () => {
  await act(async () => {
    await voice.start();
  });
  const muted = deferred<Response>();
  fetchMock.mockImplementationOnce(() => muted.promise);
  await act(async () => {
    voice.toggleSpeaker();
    voice.toggleSpeaker();
  });
  expect(audio.instances[0].setSpeakerMuted.mock.calls).toEqual([
    [true],
    [false],
  ]);
  expect(controls('speaker')).toHaveLength(1);
  await act(async () => {
    muted.resolve(json({}));
  });
  expect(
    controls('speaker').map(([, init]) => JSON.parse(init.body).value),
  ).toEqual([true, false]);
});

it('keeps a call muted when a pending unmute acquisition is superseded by mute', async () => {
  await act(async () => {
    await voice.start();
    voice.toggleMute();
  });
  const microphone = deferred<void>();
  audio.instances[0].startCapture.mockReturnValueOnce(microphone.promise);
  await act(async () => {
    voice.toggleMute();
  });
  expect(audio.instances[0].startCapture).toHaveBeenCalledTimes(2);
  await act(async () => {
    voice.toggleMute();
    microphone.reject(new Error('Audio startup was cancelled or stopped'));
  });
  expect(voice.status).toBe('active');
  expect(voice.muted).toBe(true);
  expect(voice.error).toBe('');
  expect(controls('end')).toHaveLength(0);
  expect(
    controls('mute').map(([, init]) => JSON.parse(init.body).value),
  ).toEqual([true, false, true]);
});

it('drops queued microphone frames on mute and sends contiguous sequences after deliberate unmute', async () => {
  await act(async () => {
    await voice.start();
  });
  const firstFrame = deferred<Response>();
  fetchMock.mockImplementationOnce(() => firstFrame.promise);
  const current = audio.instances[0];
  await act(async () => {
    current.options.onFrame({ sequence: 0, pcm: new Uint8Array(1024) });
    current.options.onFrame({ sequence: 1, pcm: new Uint8Array(1024) });
    voice.toggleMute();
  });
  expect(current.muteCapture).toHaveBeenCalledTimes(1);
  expect(controls('mute')).toHaveLength(0);
  await act(async () => {
    firstFrame.resolve(json({}));
  });
  expect(JSON.parse(controls('mute')[0][1].body)).toEqual({
    action: 'mute',
    value: true,
  });
  await act(async () => {
    voice.toggleMute();
  });
  expect(current.startCapture).toHaveBeenCalledTimes(2);
  await act(async () => {
    current.options.onFrame({ sequence: 5, pcm: new Uint8Array(1024) });
  });
  const frames = fetchMock.mock.calls.filter(([url]) => url.endsWith('/frame'));
  expect(frames.map(([, init]) => JSON.parse(init.body).sequence)).toEqual([
    0, 1,
  ]);
});

it('ends capture immediately when the single-flight microphone backlog exceeds eight frames', async () => {
  await act(async () => {
    await voice.start();
  });
  const pending = deferred<Response>();
  fetchMock.mockImplementationOnce(() => pending.promise);
  await act(async () => {
    for (let sequence = 0; sequence < 10; sequence++)
      audio.instances[0].options.onFrame({
        sequence,
        pcm: new Uint8Array(1024),
      });
  });
  expect(audio.instances[0].stop).toHaveBeenCalledTimes(1);
  expect(voice.error).toMatch(/backlog|queue/i);
  pending.resolve(json({}));
});

it('sends software playback ACKs and flushes output immediately on interruption', async () => {
  await act(async () => {
    await voice.start();
  });
  await emit({ type: 'audio', generation: 0, sequence: 0, pcm: btoa('\0\0') });
  expect(audio.instances[0].play).toHaveBeenCalledWith({
    generation: 0,
    sequence: 0,
    pcm: new Uint8Array(2),
  });
  await act(async () => {
    audio.instances[0].options.onPlayed({
      generation: 0,
      sequence: 0,
      playedSamples: 1,
    });
    await voice.interrupt();
  });
  expect(JSON.parse(controls('played')[0][1].body)).toEqual({
    action: 'played',
    generation: 0,
    sequence: 0,
    samples: 1,
  });
  expect(audio.instances[0].flush).toHaveBeenCalledWith(0);
  await emit({ type: 'audio', generation: 0, sequence: 1, pcm: btoa('\0\0') });
  expect(audio.instances[0].play).toHaveBeenCalledTimes(1);
});

it('stops devices and revokes the native call before waiting for end persistence', async () => {
  await act(async () => {
    await voice.start();
  });
  const receipt = deferred<Response>();
  fetchMock.mockImplementationOnce(() => receipt.promise);
  let end!: Promise<void>;
  await act(async () => {
    end = voice.end();
  });
  expect(audio.instances[0].stop).toHaveBeenCalledTimes(1);
  expect(bridge.end).toHaveBeenCalledWith('call');
  expect(voice.status).toBe('ending');
  await act(async () => {
    receipt.resolve(json({}));
    await end;
  });
  expect(voice.status).toBe('idle');
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it('ends a late call-creation result without ever acquiring its microphone', async () => {
  const created = deferred<Response>();
  fetchMock.mockImplementationOnce(() => created.promise);
  let start!: Promise<void>;
  await act(async () => {
    start = voice.start();
  });
  await act(async () => {
    await voice.end();
  });
  await act(async () => {
    created.resolve(json({ id: 'call', token: 'capability' }));
    await start;
  });
  expect(audio.instances[0].startCapture).not.toHaveBeenCalled();
  expect(controls('end')).toHaveLength(1);
  expect(bridge.begin).not.toHaveBeenCalled();
});

it.each(['pagehide', 'hidden', 'native', 'stream', 'device'])(
  'releases the call after %s loss',
  async (reason) => {
    await act(async () => {
      await voice.start();
    });
    await act(async () => {
      if (reason === 'pagehide')
        windowEvents.dispatchEvent(new Event('pagehide'));
      if (reason === 'hidden') {
        documentEvents.visibilityState = 'hidden';
        documentEvents.dispatchEvent(new Event('visibilitychange'));
      }
      if (reason === 'native') nativeStop('screen-locked');
      if (reason === 'stream') stream.close();
      if (reason === 'device')
        audio.instances[0].options.onError(
          new Error('Microphone disconnected'),
        );
    });
    expect(audio.instances[0].stop).toHaveBeenCalledTimes(1);
    expect(bridge.end).toHaveBeenCalledWith('call');
    expect(controls('end')).toHaveLength(1);
  },
);

it('sends a heartbeat while the microphone is muted', async () => {
  await act(async () => {
    await voice.start();
    voice.toggleMute();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(controls('heartbeat')).toHaveLength(1);
});

it('ends instead of retaining malformed or unbounded SSE data', async () => {
  await act(async () => {
    await voice.start();
  });
  await act(async () => {
    stream.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(70000)}`));
  });
  expect(audio.instances[0].stop).toHaveBeenCalledTimes(1);
  expect(voice.error).toMatch(/event|stream|large/i);
});

it('keeps windowless audio alive when hidden, forwards phases, and still ends on native stop', async () => {
  const phase = vi.fn(async () => {});
  Object.assign(bridge, { isWindowless: () => true, phase });
  await act(async () => {
    await voice.start();
  });
  await act(async () => {
    documentEvents.visibilityState = 'hidden';
    documentEvents.dispatchEvent(new Event('visibilitychange'));
  });
  expect(audio.instances[0].stop).not.toHaveBeenCalled();
  await emit({ type: 'phase', phase: 'thinking' });
  expect(phase).toHaveBeenCalledWith('call', 'thinking');
  await act(async () => nativeStop('shortcut'));
  expect(audio.instances[0].stop).toHaveBeenCalled();
  expect(bridge.end).toHaveBeenCalledWith('call');
});

it('releases the native starting state when the user ends before a call handle arrives', async () => {
  const pending = deferred<Response>();
  const normal = fetchMock.getMockImplementation() as (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>;
  fetchMock.mockImplementation((url: string, init?: RequestInit) =>
    url.endsWith('/calls') ? pending.promise : normal(url, init),
  );
  const cancelStart = vi.fn(async () => {});
  Object.assign(bridge, { cancelStart });
  let starting!: Promise<void>;
  await act(async () => {
    starting = voice.start();
  });
  await act(async () => {
    await voice.end();
  });
  expect(cancelStart).toHaveBeenCalledOnce();
  pending.resolve(json({ id: 'late-call', token: 'capability' }));
  await act(async () => {
    await starting;
  });
  expect(audio.instances[0].startCapture).not.toHaveBeenCalled();
});

it('shows High captions without submitting a second subscription turn', async () => {
  quality = 'high';
  await act(async () => root.update(createElement(Hook)));
  fetchMock.mockImplementationOnce(async () =>
    json({ id: 'call', token: 'capability', quality: 'high' }),
  );
  await act(async () => {
    await voice.start();
  });
  await emit({
    type: 'native-transcript',
    generation: 0,
    messageId: 'saved-native',
    text: 'Hello locally',
  });
  expect(voice.userCaption).toBe('Hello locally');
  await emit({ type: 'review-folders' });
  expect(bridge.reviewFolders).toHaveBeenCalledWith('call');
  expect(voice.error).toBe('');
  expect(onTranscript).not.toHaveBeenCalled();
  expect(controls('answer')).toHaveLength(0);
  expect(onSaved).toHaveBeenCalled();
});
