import { expect, it, vi } from 'vitest';
import { LiveVoiceCall } from '../src/server/local-voice/live.js';
import type { LocalVoiceEvent } from '../src/shared/local-voice.js';
import type { NativeUnderstanding } from '../src/server/local-voice/native-contract.js';
import { NativeVoiceWorker } from '../src/server/local-voice/native-worker.js';
import { join, resolve } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

it.each([
  { reviewFolders: false, awaitingReply: false },
  { reviewFolders: true, awaitingReply: false },
  { reviewFolders: false, awaitingReply: true },
])(
  'uses original audio and waits silently when the actual answer is pending (%o)',
  async ({ reviewFolders, awaitingReply }) => {
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
      speak: vi.fn(async (text: string) => ({ text, pcm: Buffer.alloc(1920) })),
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
        text: awaitingReply ? '' : 'Hi!',
        pcm: Buffer.alloc(awaitingReply ? 0 : 1920),
        assistantMessageId: 'saved',
        reviewFolders,
        awaitingReply,
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
      if (awaitingReply) {
        await vi.waitFor(() =>
          expect(events.some((e) => e.type === 'native-transcript')).toBe(true),
        );
        expect(
          events.some((e) => e.type === 'audio' || e.type === 'caption'),
        ).toBe(false);
        expect(call.ended).toBe(false);
        call.nativeUpdate('actual-answer', 'Hi!', async () => true);
      }
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

it.each(['manual', 'speech'] as const)(
  '%s interruption stops a spoken task receipt without ending the High call',
  async (source) => {
    const events: LocalVoiceEvent[] = [];
    let probability = 0;
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
          detect: async () => probability,
        },
      }),
    );
    call.listen(async (event) => {
      events.push(event);
    });
    try {
      await call.start();
      call.nativeUpdate(
        'receipt',
        'Your task finished. The label is amber fox.',
        async () => true,
      );
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === 'audio')).toBe(true),
      );
      if (source === 'manual') await call.interrupt();
      else {
        probability = 1;
        for (let n = 0; n < 46; n++) await call.frame(n, Buffer.alloc(1024));
        expect(events.some((event) => event.type === 'flush')).toBe(false);
        await call.frame(46, Buffer.alloc(1024));
      }
      expect(events.filter((event) => event.type === 'flush')).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(call.ended).toBe(false);
    } finally {
      await call.end();
    }
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function receiptCall(
  synthesize: (text: string) => Promise<{ text: string; pcm: Buffer }> = async (
    text,
  ) => ({ text, pcm: Buffer.alloc(16000) }),
  observe: (event: LocalVoiceEvent) => void = () => {},
  acknowledge = true,
  warm: () => Promise<void> = async () => {},
  beforeStart: (call: LiveVoiceCall) => void = () => {},
) {
  const events: LocalVoiceEvent[] = [];
  const speak = vi.fn(synthesize);
  const stop = vi.fn();
  const receipt = vi.fn();
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
      receipt,
      delivery: vi.fn(),
    },
    () => ({
      native: {
        warm,
        close: async () => {},
        interpret: async (): Promise<NativeUnderstanding> => ({
          route: 'ignore',
          text: '',
        }),
        respond: vi.fn(),
        speak,
      },
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
    observe(event);
    if (acknowledge && event.type === 'audio')
      queueMicrotask(() => {
        void call.played(
          event.generation,
          event.sequence,
          Buffer.from(event.pcm, 'base64').length / 2,
        );
      });
  });
  beforeStart(call);
  await call.start();
  return { call, speak, stop, events, receipt };
}

it('waits for native warmup before speaking a task result arriving during call startup', async () => {
  const warming = deferred<void>();
  const began = deferred<void>();
  let early = false;
  let ready = false;
  let pending!: LiveVoiceCall;
  const opening = receiptCall(
    async (text) => {
      if (!ready) {
        early = true;
        throw Error('Native voice worker is busy');
      }
      return { text, pcm: Buffer.alloc(1920) };
    },
    undefined,
    true,
    async () => {
      began.resolve();
      await warming.promise;
      ready = true;
    },
    (call) => {
      pending = call;
    },
  );
  await began.promise;
  pending.nativeUpdate(
    'task-during-warmup',
    'Your answer is ready.',
    async () => true,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  warming.resolve();
  const f = await opening;
  try {
    expect(early).toBe(false);
    await vi.waitFor(() =>
      expect(f.events.some((e) => e.type === 'audio')).toBe(true),
    );
    void opening.catch(() => {});
    expect(f.call.ended).toBe(false);
  } finally {
    await f.call.end();
  }
});

it('includes the actual task reply in the call transcript', async () => {
  const f = await receiptCall();
  try {
    f.call.nativeUpdate(
      'actual-answer',
      'Hello again! What is on your mind?',
      async () => true,
    );
    await vi.waitFor(() =>
      expect(f.receipt).toHaveBeenCalledWith(
        'active',
        expect.stringContaining(
          'Dot (generated): Hello again! What is on your mind?',
        ),
      ),
    );
  } finally {
    await f.call.end();
  }
});

it.each(['interrupt', 'mute', 'revoke'] as const)(
  'discards a task reply after %s while its transcript is being saved',
  async (action) => {
    const saving = deferred<void>();
    const saved = deferred<void>();
    const f = await receiptCall();
    let authorized = true;
    f.receipt.mockImplementationOnce(async () => {
      saving.resolve();
      await saved.promise;
    });
    try {
      f.call.nativeUpdate('stale', 'Private reply.', async () => authorized);
      await saving.promise;
      if (action === 'interrupt') await f.call.interrupt();
      else if (action === 'mute') await f.call.speaker(true);
      else authorized = false;
      saved.resolve();
      await vi.waitFor(() => expect(f.speak).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(f.events.some((e) => e.type === 'caption')).toBe(false);
      expect(f.events.some((e) => e.type === 'audio')).toBe(false);
      expect(f.call.ended).toBe(false);
      if (action === 'mute') await f.call.speaker(false);
      f.call.nativeUpdate('fresh', 'Current reply.', async () => true);
      await vi.waitFor(() =>
        expect(f.events).toContainEqual(
          expect.objectContaining({ type: 'caption', text: 'Current reply.' }),
        ),
      );
      await vi.waitFor(() =>
        expect(f.events.some((e) => e.type === 'audio')).toBe(true),
      );
      expect(f.call.ended).toBe(false);
    } finally {
      saved.resolve();
      await f.call.end();
    }
  },
);

it('discards a muted task receipt when the owner interrupts before unmuting', async () => {
  vi.useFakeTimers();
  const f = await receiptCall();
  try {
    await f.call.speaker(true);
    f.call.nativeUpdate('receipt', 'Private task result.', async () => true);
    await f.call.interrupt();
    await f.call.speaker(false);
    await vi.advanceTimersByTimeAsync(2100);
    expect(f.speak).not.toHaveBeenCalled();
    expect(f.events.filter((event) => event.type === 'audio')).toHaveLength(0);
  } finally {
    await f.call.end();
    vi.useRealTimers();
  }
});

it('binds an unresolved authorization check to the interruption generation', async () => {
  const validation = deferred<() => Promise<boolean>>();
  const f = await receiptCall();
  try {
    f.call.nativeUpdate('receipt', 'Private task result.', validation.promise);
    await f.call.interrupt();
    validation.resolve(async () => true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.speak).not.toHaveBeenCalled();
    expect(f.events.filter((event) => event.type === 'audio')).toHaveLength(0);
  } finally {
    await f.call.end();
  }
});

it('discards revoked task speech before synthesis without retrying the task', async () => {
  const f = await receiptCall();
  try {
    f.call.nativeUpdate('receipt', 'Private task result.', async () => false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.speak).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.call.ended).toBe(false);
  } finally {
    await f.call.end();
  }
});

it('discards task speech revoked while local synthesis is pending', async () => {
  const generated = deferred<{ text: string; pcm: Buffer }>();
  const f = await receiptCall(() => generated.promise);
  let authorized = true;
  try {
    f.call.nativeUpdate(
      'receipt',
      'Private task result.',
      async () => authorized,
    );
    await vi.waitFor(() => expect(f.speak).toHaveBeenCalledOnce());
    authorized = false;
    generated.resolve({
      text: 'Private task result.',
      pcm: Buffer.alloc(16000),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      f.events.filter(
        (event) => event.type === 'audio' || event.type === 'caption',
      ),
    ).toHaveLength(0);
    expect(f.call.ended).toBe(false);
  } finally {
    generated.resolve({ text: '', pcm: Buffer.alloc(16000) });
    await f.call.end();
  }
});

it('flushes task audio when authorization changes between streamed frames', async () => {
  let authorized = true;
  const f = await receiptCall(undefined, (event) => {
    if (event.type === 'audio') authorized = false;
  });
  const validate = async () => authorized;
  const events = f.events;
  try {
    f.call.nativeUpdate('receipt', 'Private task result.', validate);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'flush')).toBe(true),
    );
    expect(events.filter((event) => event.type === 'audio')).toHaveLength(1);
    expect(f.call.ended).toBe(false);
    expect(f.stop).not.toHaveBeenCalled();
  } finally {
    await f.call.end();
  }
});

it('keeps authorized task speech queued across a speaker mute', async () => {
  vi.useFakeTimers();
  const f = await receiptCall();
  try {
    await f.call.speaker(true);
    f.call.nativeUpdate('receipt', 'Allowed task result.', async () => true);
    await vi.advanceTimersByTimeAsync(2100);
    expect(f.speak).not.toHaveBeenCalled();
    await f.call.speaker(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.events.some((event) => event.type === 'audio')).toBe(true);
    expect(f.speak).toHaveBeenCalledOnce();
  } finally {
    await f.call.end();
    vi.useRealTimers();
  }
});

it('suppresses task speech if receipt validation fails while muted', async () => {
  vi.useFakeTimers();
  const f = await receiptCall();
  try {
    await f.call.speaker(true);
    f.call.nativeUpdate(
      'receipt',
      'Private task result.',
      Promise.reject(new Error('Receipt disappeared')),
    );
    await vi.advanceTimersByTimeAsync(2100);
    await f.call.speaker(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.speak).not.toHaveBeenCalled();
    expect(f.call.ended).toBe(false);
  } finally {
    await f.call.end();
    vi.useRealTimers();
  }
});

it('flushes revoked task audio while the playback queue awaits acknowledgements', async () => {
  vi.useFakeTimers();
  const f = await receiptCall(undefined, undefined, false);
  let authorized = true;
  try {
    f.call.nativeUpdate(
      'receipt',
      'Private task result.',
      async () => authorized,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(f.events.filter((event) => event.type === 'audio')).toHaveLength(4);
    authorized = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(f.events.filter((event) => event.type === 'flush')).toHaveLength(1);
    expect(f.events.filter((event) => event.type === 'audio')).toHaveLength(4);
    expect(f.call.ended).toBe(false);
  } finally {
    await f.call.end();
    vi.useRealTimers();
  }
});

it('ignores an old playback monitor after its receipt finished speaking', async () => {
  vi.useFakeTimers();
  const f = await receiptCall(undefined, undefined, false);
  const delayed = deferred<boolean>();
  let holdMonitor = false;
  const acknowledged = new Set<number>();
  try {
    f.call.nativeUpdate('first', 'First result.', async () =>
      holdMonitor ? delayed.promise : true,
    );
    await vi.advanceTimersByTimeAsync(1);
    holdMonitor = true;
    await vi.advanceTimersByTimeAsync(100);
    holdMonitor = false;
    for (let batch = 0; batch < 3; batch++) {
      for (const event of f.events.slice()) {
        if (event.type !== 'audio' || acknowledged.has(event.sequence))
          continue;
        acknowledged.add(event.sequence);
        await f.call.played(
          event.generation,
          event.sequence,
          Buffer.from(event.pcm, 'base64').length / 2,
        );
      }
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(acknowledged.size).toBe(9);
    f.call.nativeUpdate('second', 'Second result.', async () => true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.speak).toHaveBeenCalledTimes(2);
    delayed.resolve(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.events.filter((event) => event.type === 'flush')).toHaveLength(0);
  } finally {
    delayed.resolve(false);
    await f.call.end();
    vi.useRealTimers();
  }
});

it.each(['interrupt', 'mute'] as const)(
  'retains the native speech worker after %s during receipt synthesis for the next turn in the same call',
  async (action) => {
    const root = await mkdtemp(join(tmpdir(), 'native-call-drain-'));
    const release = join(root, 'release');
    const native = new NativeVoiceWorker({
      executable: process.execPath,
      args: [
        resolve('tests/fixtures/native-voice-worker.mjs'),
        'delayed-speak',
        '',
        release,
      ],
      timeoutMs: 3000,
    });
    const speak = vi.spyOn(native, 'speak');
    const events: LocalVoiceEvent[] = [];
    let voiced = true;
    const nativeTurn = vi.fn(async () => ({
      text: 'The next turn was recognized.',
      pcm: Buffer.alloc(4800),
      assistantMessageId: 'next-reply',
    }));
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
        nativeTurn,
      },
      () => ({
        native,
        vad: {
          warm: async () => {},
          close: async () => {},
          reset: async () => {},
          detect: async () => (voiced ? 1 : 0),
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
      call.nativeUpdate('old-receipt', 'Stale task result.', async () => true);
      await vi.waitFor(() => expect(speak).toHaveBeenCalledOnce());
      if (action === 'interrupt') await call.interrupt();
      else await call.speaker(true);
      for (let sequence = 0; sequence < 28; sequence++) {
        voiced = sequence < 4;
        await call.frame(sequence, Buffer.alloc(1024, 1));
      }
      await writeFile(release, 'ready');
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'native-transcript',
            text: 'Please inspect my project.',
          }),
        ),
      );
      expect(nativeTurn).toHaveBeenCalledOnce();
      expect(call.ended).toBe(false);
      expect(events).not.toContainEqual({
        type: 'caption',
        text: 'Stale task result.',
      });
      expect(
        events.some(
          (event) =>
            event.type === 'audio' &&
            Buffer.from(event.pcm, 'base64').includes(2),
        ),
      ).toBe(false);
      if (action === 'mute')
        expect(events.filter((event) => event.type === 'audio')).toHaveLength(
          0,
        );
      expect(speak).toHaveBeenCalledOnce();
    } finally {
      await call.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
