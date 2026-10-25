/** Explicit file-only qualification: no microphone, playback or provider. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { NativeVoiceWorker } from '../src/server/local-voice/native-worker.ts';
import { QwenVoiceSession } from '../src/server/local-voice/qwen-voice.ts';
import {
  decodeFixtureWav,
  encodeFixtureWav,
} from '../src/server/local-voice/audio.ts';
import { HIGH_VOICES } from '../src/shared/voice-settings.ts';

const { values } = parseArgs({
  options: {
    'runtime-root': { type: 'string' },
    'tts-root': { type: 'string' },
    output: { type: 'string' },
    scripts: { type: 'string' },
  },
});
if (!values['runtime-root'] || !values['tts-root'] || !values.output)
  throw Error(
    'Supply --runtime-root PATH --tts-root PATH --output NEW_DIRECTORY.',
  );
const runtime = resolve(values['runtime-root']);
const tts = resolve(values['tts-root']);
const output = resolve(values.output);
const scripts = resolve(values.scripts || 'scripts/local-voice');
const python = join(runtime, 'venv/bin/python');
await mkdir(output);
const createSpeech = (voice) =>
  new NativeVoiceWorker({
    executable: python,
    args: [
      join(scripts, 'qwen_launcher.py'),
      '--runtime-root',
      runtime,
      '--python',
      python,
      '--tts-root',
      tts,
      '--voice',
      voice,
      '--personality',
      'natural',
    ],
    timeoutMs: 45000,
    speechChunkSize: 240,
  });
const report = {
  microphone: false,
  playback: false,
  provider: false,
  results: [],
};
const deadline = () => AbortSignal.timeout(45000);
const save = () =>
  writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
try {
  for (const { id } of HIGH_VOICES) {
    const worker = createSpeech(id);
    try {
      let start = performance.now();
      await worker.warm(deadline());
      const warmMs = performance.now() - start;
      const prompts = [
        'Hello, I am your Dot. Which voice would you like to use?',
      ];
      if (id === 'vivian')
        prompts.push(
          'The test failed. I did not save your changes.',
          'Qwen3-TTS generates speech. Codex handles the task, and LFM recognizes your words.',
        );
      for (const [index, text] of prompts.entries()) {
        start = performance.now();
        const speech = await worker.speak(text, deadline());
        assert.equal(speech.text, text);
        assert.ok(speech.pcm.length > 0 && speech.pcm.some((b) => b));
        await writeFile(
          join(output, `${id}-${index}.wav`),
          encodeFixtureWav(speech.pcm, 24000),
        );
        const row = {
          voice: id,
          text,
          warmMs,
          synthesisMs: performance.now() - start,
          audioMs: speech.pcm.length / 48,
        };
        report.results.push(row);
        console.log(JSON.stringify(row));
        await save();
      }
    } finally {
      await worker.close();
    }
  }
  const recognition = new NativeVoiceWorker({
    executable: python,
    args: [
      join(scripts, 'native_launcher.py'),
      '--runtime-root',
      runtime,
      '--python',
      python,
      '--recognition-only',
    ],
    timeoutMs: 45000,
  });
  const synthesis = createSpeech('ryan');
  const session = new QwenVoiceSession(recognition, synthesis);
  try {
    await session.warm(deadline());
    await assert.rejects(
      session.speak(
        'Please read this slowly and clearly.',
        AbortSignal.timeout(25),
      ),
    );
    await synthesis.close();
    const resampled = join(output, 'recognition.wav');
    await promisify(execFile)(
      '/usr/bin/afconvert',
      [
        '-f',
        'WAVE',
        '-d',
        'LEI16@16000',
        join(output, 'vivian-1.wav'),
        resampled,
      ],
      { timeout: 30000 },
    );
    const caption = await session.interpret(
      decodeFixtureWav(await readFile(resampled)),
      deadline(),
    );
    assert.match(caption.text, /test failed/i);
    assert.match(caption.text, /(?:did not|didn't) save/i);
    report.recognitionAfterSpeechCancellation = caption.text;
  } finally {
    await session.close();
  }
  const replacement = createSpeech('ryan');
  try {
    await replacement.warm(deadline());
    assert.equal(
      (await replacement.speak('Ready again.', deadline())).text,
      'Ready again.',
    );
    report.newSpeechWorkerAfterCancellation = true;
  } finally {
    await replacement.close();
  }
  report.pass = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await save();
}
