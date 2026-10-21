import { expect, it, vi } from 'vitest';
import { LiveVoiceCall } from '../src/server/local-voice/live.js';
import type { LocalVoiceEvent } from '../src/shared/local-voice.js';
import type { NativeUnderstanding } from '../src/server/local-voice/native-contract.js';

it.each([false, true])(
  'uses original audio and surfaces a host folder reminder only when requested (%s)',
  async (reviewFolders) => {
    const events: LocalVoiceEvent[] = [];
    const recognition = { warm: vi.fn(), close: vi.fn(), transcribe: vi.fn() };
    const synthesis = { warm: vi.fn(), close: vi.fn(), synthesize: vi.fn() };
    const native = {
      warm: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      interpret: vi.fn(async (): Promise<NativeUnderstanding> => ({
        route: 'chat',
        text: 'Hello',
      })),
      respond: vi.fn(),
      speak: vi.fn(),
    };
    let count = 0;
    const stop = vi.fn();
    const context = {
      history: [{ role: 'user' as const, text: 'Open my project folder.' }],
      taskStatus: 'completed' as const,
    };
    const nativeContext = vi.fn(async () => context);
    const nativeTurn = vi.fn(async (turn: { audio: Buffer }) => {
      expect(turn.audio.length).toBeGreaterThan(3000);
      return {
        text: 'Hi!',
        pcm: Buffer.alloc(1920),
        assistantMessageId: 'saved',
        reviewFolders,
      };
    });
    const call = new LiveVoiceCall(
      {
        id: 'call',
        token: 'token',
        dotId: 'dot',
        threadId: 'thread',
        quality: 'high',
      },
      {
        requireThread: () => ({ dotId: 'dot' }),
        paused: () => false,
        foreground: async () => () => {},
        snapshot: async () => ({ messages: [], state: {} }),
        stop,
        receipt: vi.fn(),
        delivery: vi.fn(),
        nativeTurn,
        nativeContext,
      },
      () => ({
        recognition,
        synthesis,
        native,
        vad: {
          warm: async () => {},
          close: async () => {},
          reset: async () => {},
          detect: async () => (count++ < 4 ? 1 : 0),
        },
      }),
    );
    call.listen(async (event) => {
      events.push(event);
      if (event.type === 'audio')
        queueMicrotask(() => {
          void call.played(
            event.generation,
            event.sequence,
            Buffer.from(event.pcm, 'base64').length / 2,
          );
        });
    });
    try {
      await call.start();
      for (let n = 0; n < 28; n++) await call.frame(n, Buffer.alloc(1024, 1));
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === 'audio')).toBe(true),
      );
      expect(nativeTurn).toHaveBeenCalledOnce();
      expect(nativeContext).toHaveBeenCalledOnce();
      expect(native.interpret).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(AbortSignal),
        context,
      );
      expect(events.some((event) => event.type === 'review-folders')).toBe(
        reviewFolders,
      );
      expect(events.some((event) => event.type === 'transcript')).toBe(false);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'native-transcript', text: 'Hello' }),
      );
      expect(recognition.warm).not.toHaveBeenCalled();
      expect(recognition.transcribe).not.toHaveBeenCalled();
      expect(synthesis.synthesize).not.toHaveBeenCalled();
      await call.interrupt();
      expect(stop).not.toHaveBeenCalled();
    } finally {
      await call.end();
    }
    expect(native.close).toHaveBeenCalledOnce();
  },
);

it('barge-in stops a spoken task receipt without ending the High call', async () => {
  const events: LocalVoiceEvent[] = [];
  const native = {
    warm: async () => {},
    close: async () => {},
    interpret: async (): Promise<NativeUnderstanding> => ({
      route: 'ignore',
      text: '',
    }),
    respond: vi.fn(),
    speak: async (text: string) => ({ text, pcm: Buffer.alloc(8000) }),
  };
  const call = new LiveVoiceCall(
    {
      id: 'call',
      token: 'token',
      dotId: 'dot',
      threadId: 'thread',
      quality: 'high',
    },
    {
      requireThread: () => ({ dotId: 'dot' }),
      paused: () => false,
      foreground: async () => () => {},
      snapshot: async () => ({ messages: [], state: {} }),
      stop: vi.fn(),
      receipt: vi.fn(),
      delivery: vi.fn(),
    },
    () => ({
      native,
      vad: {
        warm: async () => {},
        close: async () => {},
        reset: async () => {},
        detect: async () => 0,
      },
    }),
  );
  call.listen(async (event) => {
    events.push(event);
  });
  try {
    await call.start();
    call.nativeUpdate('receipt', 'Your task finished. The label is amber fox.');
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === 'audio')).toBe(true),
    );
    await call.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(call.ended).toBe(false);
  } finally {
    await call.end();
  }
});
