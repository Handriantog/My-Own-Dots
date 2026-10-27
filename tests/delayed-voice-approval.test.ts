import { expect, it, vi } from 'vitest';
import { LiveVoiceCall } from '../src/server/local-voice/live.js';
import type { LocalVoiceEvent } from '../src/shared/local-voice.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  synthesize?: (text: string) => Promise<{ text: string; pcm: Buffer }>,
  options: { routeGate?: Promise<void>; awaitingReply?: boolean } = {},
) {
  const events: LocalVoiceEvent[] = [];
  const inputs: string[] = [];
  let frames = 0;
  let sequence = 0;
  const speak = vi.fn(
    synthesize ?? (async (text: string) => ({ text, pcm: Buffer.alloc(1920) })),
  );
  const call = new LiveVoiceCall(
    {
      id: 'call',
      token: 'token',
      threadId: 'parent',
      dotId: 'dot',
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
      nativeTurn: async ({ messageId }) => {
        inputs.push(messageId);
        await options.routeGate;
        return {
          text: 'I will inspect the selected folder.',
          pcm: Buffer.alloc(1920),
          assistantMessageId: 'queued',
          awaitingReply: options.awaitingReply ?? true,
        };
      },
    },
    () => ({
      native: {
        warm: async () => {},
        close: async () => {},
        interpret: async () => ({
          route: 'chat' as const,
          text: 'Open the other folder.',
        }),
        respond: vi.fn(),
        speak,
      },
      vad: {
        warm: async () => {},
        close: async () => {},
        reset: async () => {},
        detect: async () => (frames++ < 4 ? 1 : 0),
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
  await call.start();
  const input = async () => {
    frames = 0;
    const previous = inputs.length;
    for (let i = 0; i < 28; i++)
      await call.frame(sequence++, Buffer.alloc(1024, 1));
    await vi.waitFor(() => expect(inputs).toHaveLength(previous + 1));
    const id = inputs.at(-1)!;
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'native-transcript', messageId: id }),
      ),
    );
    return id;
  };
  const phase = () => events.filter((event) => event.type === 'phase').at(-1);
  return { call, events, inputs, speak, input, phase };
}

it('surfaces delayed approval while speech is muted and clears its phase on terminal status', async () => {
  const f = await fixture();
  try {
    const sourceMessageId = await f.input();
    await f.call.speaker(true);
    f.call.nativeUpdate(
      'approval',
      'Your task is waiting for approval.',
      async () => true,
      { sourceMessageId, approval: true },
    );
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({ type: 'review-folders' }),
    );
    expect(f.phase()).toEqual({ type: 'phase', phase: 'approval' });
    expect(f.speak).not.toHaveBeenCalled();
    f.call.nativeUpdate(
      'approval',
      'Your task is waiting for approval.',
      async () => true,
      { sourceMessageId, approval: true },
    );
    expect(
      f.events.filter((event) => event.type === 'review-folders'),
    ).toHaveLength(1);
    f.call.nativeUpdate('completed', 'Done.', async () => true, {
      sourceMessageId,
      approval: false,
    });
    await vi.waitFor(() =>
      expect(f.phase()).toEqual({ type: 'phase', phase: 'listening' }),
    );
  } finally {
    await f.call.end();
  }
});

it('notifies approval before slow synthesis and retains approval after the receipt is spoken', async () => {
  const speech = deferred<{ text: string; pcm: Buffer }>();
  const f = await fixture(() => speech.promise);
  try {
    const sourceMessageId = await f.input();
    f.call.nativeUpdate(
      'approval',
      'Please review the folder.',
      async () => true,
      { sourceMessageId, approval: true },
    );
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({ type: 'review-folders' }),
    );
    expect(f.events.some((event) => event.type === 'audio')).toBe(false);
    speech.resolve({
      text: 'Please review the folder.',
      pcm: Buffer.alloc(1920),
    });
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.type === 'audio')).toBe(true),
    );
    await vi.waitFor(() =>
      expect(f.phase()).toEqual({ type: 'phase', phase: 'approval' }),
    );
  } finally {
    speech.resolve({
      text: 'Please review the folder.',
      pcm: Buffer.alloc(1920),
    });
    await f.call.end();
  }
});

it('does not surface a stale or cancelled approval', async () => {
  const f = await fixture();
  try {
    const sourceMessageId = await f.input();
    await f.call.speaker(true);
    const validate = vi.fn(async () => false);
    f.call.nativeUpdate('stale', 'Waiting for approval.', validate, {
      sourceMessageId,
      approval: true,
    });
    await vi.waitFor(() => expect(validate).toHaveBeenCalled());
    expect(f.events.some((event) => event.type === 'review-folders')).toBe(
      false,
    );
    expect(f.phase()).not.toEqual({ type: 'phase', phase: 'approval' });
  } finally {
    await f.call.end();
  }
});

it('keeps an earlier task approval from replacing the phase of a newer voice input', async () => {
  const f = await fixture();
  try {
    const earlier = await f.input();
    await f.call.speaker(true);
    const current = await f.input();
    expect(current).not.toBe(earlier);
    f.call.nativeUpdate(
      'earlier-approval',
      'The earlier task needs approval.',
      async () => true,
      { sourceMessageId: earlier, approval: true },
    );
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({ type: 'review-folders' }),
    );
    expect(f.phase()).toEqual({ type: 'phase', phase: 'thinking' });
  } finally {
    await f.call.end();
  }
});

it.each([false, true])(
  'preserves approval arriving before the native reply returns (awaitingReply=%s)',
  async (awaitingReply) => {
    const gate = deferred<void>();
    const f = await fixture(undefined, {
      routeGate: gate.promise,
      awaitingReply,
    });
    try {
      await f.call.speaker(true);
      const submitted = f.input();
      await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
      f.call.nativeUpdate(
        'early-approval',
        'Review the folder.',
        async () => true,
        { sourceMessageId: f.inputs[0], approval: true },
      );
      await vi.waitFor(() =>
        expect(f.events).toContainEqual({ type: 'review-folders' }),
      );
      gate.resolve();
      await submitted;
      expect(f.phase()).toEqual({ type: 'phase', phase: 'approval' });
    } finally {
      gate.resolve();
      await f.call.end();
    }
  },
);
