/** Silent, explicit hardware acceptance. No microphone, playback or task/provider code. */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { NativeVoiceWorker } from '../src/server/local-voice/native-worker.ts';
import {
  decodeFixtureWav,
  encodeFixtureWav,
} from '../src/server/local-voice/audio.ts';
const { values } = parseArgs({
  options: {
    'runtime-root': { type: 'string' },
    python: { type: 'string' },
    'output-dir': { type: 'string' },
  },
});
if (
  process.platform !== 'darwin' ||
  !values['runtime-root'] ||
  !values['output-dir']
)
  throw Error(
    'Use macOS and supply --runtime-root and a new --output-dir. No audio is played.',
  );
const root = resolve(values['runtime-root']),
  output = resolve(values['output-dir']);
await mkdir(output); // Refuse to overwrite another evaluation.
const python = values.python
  ? resolve(values.python)
  : join(root, 'venv/bin/python');
const worker = new NativeVoiceWorker({
  executable: python,
  args: [
    resolve('scripts/local-voice/native_launcher.py'),
    '--runtime-root',
    root,
    '--python',
    python,
  ],
});
const cases = JSON.parse(
  await readFile(
    new URL('../tests/fixtures/native-voice-smalltalk.json', import.meta.url),
    'utf8',
  ),
);
const report = {
  microphone: false,
  playback: false,
  provider: false,
  models: JSON.parse(
    await readFile(
      new URL('./local-voice/native-models.json', import.meta.url),
      'utf8',
    ),
  ),
  results: [],
  pass: false,
};
const refusal =
  /\b(can(?:not|['’]t)|unable to|won['’]t|not able to)\b.{0,35}\b(help|assist|provide|support)\b/i;
const instructions =
  'You are Dot. Dot instructions: Be thoughtful, practical, and concise. Help the user think clearly and follow through. Your name is Jane. Respond naturally and conversationally. You are having a local voice conversation. Tasks run separately; never claim actions or approvals occurred without a host task receipt. Supporting preferences: []. Current page: none.';
try {
  const start = performance.now();
  await worker.warm(AbortSignal.timeout(120000));
  report.startupSeconds = (performance.now() - start) / 1000;
  for (const fixture of cases) {
    const wav = join(output, fixture.id + '-input.wav');
    await promisify(execFile)('/usr/bin/say', [
      '-v',
      'Samantha',
      '-r',
      '165',
      '-o',
      wav,
      '--file-format=WAVE',
      '--data-format=LEI16@16000',
      fixture.utterance,
    ]);
    const audio = decodeFixtureWav(await readFile(wav)),
      started = performance.now();
    const signal = AbortSignal.timeout(60000);
    const understood = await worker.interpret(audio, signal);
    const result = {
      id: fixture.id,
      input: fixture.utterance,
      ...understood,
      issues: [],
    };
    const routeMatches =
      fixture.route === 'delegate'
        ? understood.route === 'delegate'
        : ['chat', 'clarify'].includes(understood.route);
    if (!routeMatches) result.issues.push('Incorrect task routing');
    if (understood.route === 'chat' || understood.route === 'clarify') {
      const reply = await worker.respond(
        audio,
        {
          caption: understood.text,
          instructions,
          history: fixture.history ?? [],
        },
        signal,
      );
      result.reply = reply.text;
      result.audioSeconds = reply.pcm.length / 48000;
      await writeFile(
        join(output, fixture.id + '-reply.wav'),
        encodeFixtureWav(reply.pcm, 24000),
      );
      if (refusal.test(reply.text) !== !!fixture.expectRefusal)
        result.issues.push('Unexpected refusal behavior');
      for (const phrase of fixture.mentions ?? [])
        if (!new RegExp(phrase, 'i').test(reply.text))
          result.issues.push('Missing expected meaning: ' + phrase);
    }
    result.seconds = (performance.now() - started) / 1000;
    report.results.push(result);
    console.log(JSON.stringify(result));
  }
  report.pass =
    report.results.length === cases.length &&
    report.results.every((r) => !r.issues.length);
  // These coarse checks catch regressions; read replies and inspect speech separately.
  if (!report.pass) process.exitCode = 1;
} finally {
  await worker.close();
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
