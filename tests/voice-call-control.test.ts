import { expect, it, vi } from 'vitest';
import {
  LiveVoiceCall,
  type VoiceWorkers,
} from '../src/server/local-voice/live.js';
import type { LocalVoiceEvent } from '../src/shared/local-voice.js';
import type { VoiceQuality } from '../src/shared/voice-settings.js';
import { isEndCallRequest } from '../src/server/local-voice/call-control.js';
import { NativeVoiceWorker } from '../src/server/local-voice/native-worker.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventType, type BaseEvent } from '@ag-ui/client';
import { Subject } from 'rxjs';
import { StorageClient } from '../src/server/storage/storage-client.js';
import { Platform } from '../src/server/platform.js';
import { DotAgent } from '../src/server/dot-agent.js';

function fixture(
  quality: VoiceQuality,
  text: string,
  native?: VoiceWorkers['native'],
) {
  const events: LocalVoiceEvent[] = [];
  const receipts: { status: string; transcript: string; error?: string }[] = [];
  const routed: string[] = [];
  const closedWorkers: string[] = [];
  let closed = false;
  let voiced = true;
  const worker = (name: string) => ({
    warm: async () => {},
    close: async () => {
      closedWorkers.push(name);
    },
  });
  const workers: VoiceWorkers = {
    vad: {
      ...worker('vad'),
      reset: async () => {},
      detect: async () => (voiced ? 1 : 0),
    },
    ...(quality === 'high'
      ? {
          native: native ?? {
            ...worker('native'),
            interpret: async () => ({ text, route: 'chat' as const }),
            respond: async () => {
              throw Error('Unexpected local response');
            },
            speak: async () => {
              throw Error('Hangup should not require synthesis');
            },
          },
        }
      : {
          recognition: {
            ...worker('recognition'),
            transcribe: async () => ({ text, language: 'en', segments: [] }),
          },
          ...(quality === 'medium'
            ? {
                synthesis: {
                  ...worker('synthesis'),
                  synthesize: async () => Buffer.alloc(1920),
                },
              }
            : {}),
        }),
  };
  const call = new LiveVoiceCall(
    { id: 'call', token: 'token', dotId: 'dot', threadId: 'thread', quality },
    {
      requireThread: () => ({ dotId: 'dot' }),
      paused: () => false,
      foreground: async () => () => {},
      snapshot: async () => ({ messages: [], state: {} }),
      stop: async () => {},
      delivery: async () => {},
      receipt: async (status, transcript, error) => {
        receipts.push({ status, transcript, error });
      },
      closed: () => {
        closed = true;
      },
      nativeTurn: async ({ understanding }) => {
        routed.push(understanding.text);
        return {
          text: '',
          pcm: Buffer.alloc(0),
          assistantMessageId: 'task',
          awaitingReply: true,
        };
      },
    },
    () => workers,
  );
  call.listen(async (event) => {
    events.push(event);
  });
  return {
    call,
    events,
    receipts,
    routed,
    closedWorkers,
    closed: () => closed,
    capture: async () => {
      await call.start();
      for (let seq = 0; seq < 28 && !call.ended; seq++) {
        voiced = seq < 4;
        await call.frame(seq, Buffer.alloc(1024, 1));
      }
    },
  };
}

it.each(['basic', 'medium', 'high'] as const)(
  'ends %s from recognized direct speech without submitting a chat/task turn',
  async (quality) => {
    const f = fixture(quality, 'Dot, please end the call.');
    try {
      await f.capture();
      await vi.waitFor(() => expect(f.closed()).toBe(true), { timeout: 500 });
      expect(f.call.ended).toBe(true);
      expect(f.events.filter((e) => e.type === 'ended')).toEqual([
        { type: 'ended' },
      ]);
      expect(
        f.events.some(
          (e) =>
            e.type === 'transcript' ||
            e.type === 'native-transcript' ||
            e.type === 'audio',
        ),
      ).toBe(false);
      expect(f.routed).toEqual([]);
      expect(f.receipts.at(-1)).toEqual({
        status: 'ended',
        transcript: 'You: Dot, please end the call.',
        error: undefined,
      });
      expect(f.closedWorkers.sort()).toEqual(
        quality === 'high'
          ? ['native', 'vad']
          : quality === 'medium'
            ? ['recognition', 'synthesis', 'vad']
            : ['recognition', 'vad'],
      );
    } finally {
      await f.call.end();
    }
  },
);

it.each([
  "Don't end the call.",
  'How do I end the call?',
  'Say "end the call".',
  'End the call after the file is saved.',
  'Stop the task.',
  'Please explain what hang up means.',
])('keeps "%s" as conversation rather than a call control', async (text) => {
  const f = fixture('high', text);
  try {
    await f.capture();
    await vi.waitFor(() => expect(f.routed).toEqual([text]));
    expect(f.call.ended).toBe(false);
  } finally {
    await f.call.end();
  }
});

it.each([
  'end the call',
  'DOT, END THE CALL!',
  'Please stop this call.',
  'Close the voice chat, please.',
  'Disconnect our voice call.',
  'Hang up.',
  'Okay, Dot, please hang up now. Thank you.',
  'Can you end the call?',
  'Could you please hang up now?',
  'I would like to end the call.',
  'I want to end this voice chat.',
  "I'd like you to end the call.",
  "Let's end the call.",
  'Can we end the call?',
  'Hang up the voice call.',
])('recognizes the complete direct call control "%s"', (text) => {
  expect(isEndCallRequest(text)).toBe(true);
});

it.each([
  '',
  'stop',
  'cancel that',
  'end',
  'The call ended.',
  'Do not end the call.',
  "Don't hang up.",
  'Please never end this call.',
  'How do I end the call?',
  'Should I end the call?',
  'Can you explain how to end the call?',
  'If I say end the call, what happens?',
  'End the call after the task finishes.',
  'End the call tomorrow.',
  'Create a file then end the call.',
  'End the call and delete my files.',
  'End the call? No, keep talking.',
  'Say end the call.',
  '"End the call"',
  "'end the call'",
  '“hang up”',
  'Repeat: end the call.',
  'Can you stop the task?',
  'Disconnect Spotify.',
])('does not treat "%s" as direct call-ending intent', (text) => {
  expect(isEndCallRequest(text)).toBe(false);
});

it('drains recognition and reaps the actual High child after a recognized hangup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dots-call-hangup-'));
  const pidFile = join(root, 'pid');
  const native = new NativeVoiceWorker({
    executable: process.execPath,
    args: [
      resolve('tests/fixtures/native-voice-worker.mjs'),
      'end-call',
      pidFile,
    ],
    timeoutMs: 2000,
  });
  const f = fixture('high', '', native);
  try {
    await f.capture();
    await vi.waitFor(() => expect(f.closed()).toBe(true), { timeout: 3000 });
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(f.events.filter((e) => e.type === 'ended')).toEqual([
      { type: 'ended' },
    ]);
    expect(f.receipts.at(-1)).toEqual({
      status: 'ended',
      transcript: 'You: Please end the voice call.',
      error: undefined,
    });
    expect(f.routed).toEqual([]);
  } finally {
    await f.call.end();
    await rm(root, { recursive: true, force: true });
  }
});

it('ends High while an accepted task keeps running and saves its result without replay', async () => {
  vi.stubEnv('CODEX_BIN', '/nonexistent/forbidden-live-provider');
  vi.stubEnv(
    'AGENT_COMMAND_JSON',
    JSON.stringify([
      process.execPath,
      resolve('tests/fixtures/subscription-provider.mjs'),
    ]),
  );
  const root = await mkdtemp(join(tmpdir(), 'dots-hangup-task-'));
  const task = new Subject<BaseEvent>();
  let storage: StorageClient | undefined;
  let platform: Platform | undefined;
  let call: LiveVoiceCall | undefined;
  let restoreAgent: (() => void) | undefined;
  try {
    storage = await StorageClient.open({
      database: join(root, 'workspace.sqlite'),
      ownerId: randomUUID(),
      engine: 'sqlite',
    });
    const { store, workspace, voiceDelegations: jobs } = storage.repositories;
    platform = await Platform.create(
      store,
      workspace,
      {
        conversationBackend: 'local',
        llmBackend: 'subscription',
        llmProvider: 'claude-code',
        baseUrl: '',
        runtimeUrl: 'http://localhost/api/copilotkit',
        voiceName: 'marin',
        slackUsers: [],
        webSearchProvider: 'disabled',
      },
      { storage },
    );
    await platform.start();
    platform.config.agentEngine = 'codex';
    platform.config.llmProvider = 'codex';
    const runtime = platform;
    const run = vi
      .spyOn(DotAgent.prototype, 'run')
      .mockImplementation((input) => {
        queueMicrotask(() =>
          task.next({
            type: EventType.RUN_STARTED,
            threadId: input.threadId,
            runId: input.runId,
          }),
        );
        return task;
      });
    restoreAgent = () => run.mockRestore();
    const dot = (await workspace.dots())[0];
    const thread = await platform.createConversation(dot.id, 'Hangup fixture');
    const receipt = await workspace.createCall(thread.id);
    const events: LocalVoiceEvent[] = [];
    const native = {
      warm: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      interpret: vi
        .fn()
        .mockResolvedValueOnce({
          route: 'chat',
          text: 'Inspect the fixture project.',
        })
        .mockResolvedValueOnce({ route: 'chat', text: 'Please end the call.' }),
      respond: vi.fn(async () => {
        throw Error('Unexpected local response');
      }),
      speak: vi.fn(async () => {
        throw Error('Unexpected speech output');
      }),
    };
    let voiced = false;
    let sequence = 0;
    let closed = false;
    call = new LiveVoiceCall(
      {
        id: receipt.id,
        token: 'fixture-token',
        dotId: dot.id,
        threadId: thread.id,
        quality: 'high',
      },
      {
        requireThread: () => workspace.requireThread(thread.id, dot.id),
        paused: async () => (await store.settings()).paused,
        foreground: (signal) =>
          runtime.memory!.enterForeground(signal, thread.id),
        snapshot: () => runtime.localConversations!.getSnapshot(thread.id),
        stop: (messageId) => runtime.stopVoiceTurn(thread.id, messageId),
        delivery: (rows) => workspace.saveVoiceDelivery(receipt.id, rows),
        receipt: async (status, transcript, error) => {
          await workspace.setCall(receipt.id, status, transcript, error);
        },
        closed: () => {
          closed = true;
        },
        nativeTurn: (turn) =>
          runtime.nativeVoice!.turn({
            ...turn,
            callId: receipt.id,
            dotId: dot.id,
            threadId: thread.id,
            native,
          }),
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
    const live = call;
    live.listen(async (event) => {
      events.push(event);
    });
    await live.start();
    const capture = async () => {
      for (let frame = 0; frame < 26 && !live.ended; frame++) {
        voiced = frame < 4;
        await live.frame(sequence++, Buffer.alloc(1024, 1));
      }
    };
    await capture();
    await vi.waitFor(async () => {
      expect(
        events.filter((event) => event.type === 'native-transcript'),
      ).toHaveLength(1);
      expect(await jobs.list({ callId: receipt.id })).toEqual([
        expect.objectContaining({
          status: 'running',
          request: 'Inspect the fixture project.',
        }),
      ]);
    });
    const [accepted] = await jobs.list({ callId: receipt.id });
    const input = run.mock.calls[0][0];
    await capture();
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(events.filter((event) => event.type === 'ended')).toEqual([
      { type: 'ended' },
    ]);
    expect(native.close).toHaveBeenCalledOnce();
    expect(await jobs.get(accepted.id)).toMatchObject({
      status: 'running',
      runId: input.runId,
    });
    expect(
      (await runtime.localConversations!.getSnapshot(accepted.workerThreadId))
        .lastRun,
    ).toMatchObject({ status: 'running', runId: input.runId });
    expect(task.observed).toBe(true);
    expect(await workspace.call(receipt.id)).toMatchObject({
      status: 'ended',
      transcript:
        'You: Inspect the fixture project.\nYou: Please end the call.',
    });
    task.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'task-result',
      role: 'assistant',
    });
    task.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'task-result',
      delta: 'The fixture inspection is complete.',
    });
    task.next({ type: EventType.TEXT_MESSAGE_END, messageId: 'task-result' });
    task.next({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    });
    task.complete();
    await vi.waitFor(async () => {
      expect(await jobs.get(accepted.id)).toMatchObject({
        status: 'completed',
        result: 'The fixture inspection is complete.',
      });
    });
    expect(run).toHaveBeenCalledOnce();
    expect(await jobs.list({ callId: receipt.id })).toHaveLength(1);
    expect(native.respond).not.toHaveBeenCalled();
    expect(native.speak).not.toHaveBeenCalled();
  } finally {
    task.complete();
    await call?.end();
    await platform?.stop();
    restoreAgent?.();
    await storage?.close();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
