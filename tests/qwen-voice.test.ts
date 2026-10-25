import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { NativeVoiceWorker } from '../src/server/local-voice/native-worker';
import { QwenVoiceSession } from '../src/server/local-voice/qwen-voice';
const signal = new AbortController().signal;
function worker(mode = 'normal') {
  return new NativeVoiceWorker({
    executable: process.execPath,
    args: [resolve('tests/fixtures/native-voice-worker.mjs'), mode],
    timeoutMs: 3000,
  });
}
it('keeps speech failure separate from recognition and closes both processes', async () => {
  const recognition = worker();
  const speech = worker('rewrite');
  const session = new QwenVoiceSession(recognition, speech);
  try {
    await session.warm(signal);
    await expect(session.speak('The task failed.', signal)).rejects.toThrow(
      'Invalid native voice response',
    );
    expect((await session.interpret(Buffer.alloc(16000, 7), signal)).text).toBe(
      'Please inspect my project.',
    );
  } finally {
    await session.close();
  }
  await expect(recognition.warm(signal)).rejects.toThrow('closed');
  await expect(speech.warm(signal)).rejects.toThrow('closed');
});
it('uses the speech process for exact canonical words after recognition', async () => {
  const session = new QwenVoiceSession(worker(), worker());
  try {
    await session.warm(signal);
    await session.interpret(Buffer.alloc(16000, 7), signal);
    expect(await session.speak('I did not save your changes.', signal)).toEqual(
      {
        text: 'I did not save your changes.',
        pcm: Buffer.alloc(4800, 2),
      },
    );
  } finally {
    await session.close();
  }
});
