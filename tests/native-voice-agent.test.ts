import { expect, it, vi } from 'vitest';
import { lastValueFrom, toArray } from 'rxjs';
import { EventType, type RunAgentInput } from '@ag-ui/client';
import { MemoryStore } from './fixtures/memory-conversations.js';
import { LocalAgentRunner } from '../src/server/local-runner.js';
import { NativeConversationAgent } from '../src/server/local-voice/native-agent.js';
const input: RunAgentInput = {
  threadId: 'parent',
  runId: 'native',
  messages: [{ id: 'voice-caption', role: 'user', content: 'Hello' }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
};
it('saves an admitted voice caption without inventing an assistant acknowledgement', async () => {
  const store = new MemoryStore();
  const runner = new LocalAgentRunner(store);
  const agent = new NativeConversationAgent('dot', async () => null);
  const events = await lastValueFrom(
    runner.run({ threadId: 'parent', agent, input }).pipe(toArray()),
  );
  expect(store.snapshot.messages).toEqual(input.messages);
  expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(
    false,
  );
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});
it('saves the audio caption before native work and the native answer before completion', async () => {
  const store = new MemoryStore();
  const run = vi.fn(async () => {
    expect(store.snapshot.messages).toEqual(input.messages);
    return { id: 'native-answer', text: 'Hello back.' };
  });
  const agent = new NativeConversationAgent('dot', run);
  const output = await lastValueFrom(
    new LocalAgentRunner(store)
      .run({ threadId: 'parent', agent, input })
      .pipe(toArray()),
  );
  expect(output.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  expect(store.snapshot.messages.at(-1)).toMatchObject({
    id: 'native-answer',
    role: 'assistant',
    content: 'Hello back.',
  });
  expect(run).toHaveBeenCalledOnce();
});
it('does not publish native audio text when canonical persistence fails', async () => {
  const store = new MemoryStore();
  store.failure = 'append';
  const agent = new NativeConversationAgent('dot', async () => ({
    id: 'answer',
    text: 'Unsaved answer',
  }));
  const events = await lastValueFrom(
    new LocalAgentRunner(store)
      .run({ threadId: 'parent', agent, input })
      .pipe(toArray()),
  );
  expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(
    false,
  );
});
it('does not duplicate a deterministic host receipt already in canonical history', async () => {
  const store = new MemoryStore();
  const runner = new LocalAgentRunner(store);
  const run = () =>
    new NativeConversationAgent('dot', async () => ({
      id: 'receipt',
      text: 'Task completed.',
    }));
  await lastValueFrom(
    runner.run({ threadId: 'parent', agent: run(), input }).pipe(toArray()),
  );
  await lastValueFrom(
    runner
      .run({
        threadId: 'parent',
        agent: run(),
        input: { ...input, runId: 'retry', messages: [] },
      })
      .pipe(toArray()),
  );
  expect(
    store.snapshot.messages.filter((m) => m.id === 'receipt'),
  ).toHaveLength(1);
});
