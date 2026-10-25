/** Explicit silent hardware test; synthetic inputs, network-denied worker, no provider. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { NativeVoiceWorker } from '../src/server/local-voice/native-worker.ts';
import { decodeFixtureWav } from '../src/server/local-voice/audio.ts';
import { voiceTaskControl } from '../src/server/local-voice/native-runtime.ts';
const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output)
  throw Error('Supply --output NEW_DIRECTORY. No microphone or playback.');
const output = resolve(values.output);
await mkdir(output);
const root = join(
  homedir(),
  'Library/Application Support/My Own Dots/native-voice',
);
const python = join(root, 'venv/bin/python');
const worker = new NativeVoiceWorker({
  executable: python,
  args: [
    resolve('scripts/local-voice/native_launcher.py'),
    '--runtime-root',
    root,
    '--python',
    python,
    '--speech-only',
  ],
});
const cases = [
  ['hello', 'Hello Dot, how are you today?', /how are you/i],
  [
    'folder',
    'Please inspect the project folder that I approved.',
    /project folder/i,
  ],
  ['deny', 'Do not open the parent folder.', /(?:do not|don.t) open/i],
  ['ability', 'Turn on the mouse mover for one minute.', /mouse mover/i],
  ['status', 'Are you still working?', /still working/i],
  ['stop', 'Cancel the current task.', /cancel.*current task/i],
  [
    'debug',
    'Run the failing test and explain the error.',
    /failing test.*error/i,
  ],
  ['followup', 'What did you change in the last task?', /change.*last task/i],
  [
    'correction',
    'Use the second project, not the first one.',
    /second project.*first/i,
  ],
  ['blocked', 'Tell me which permission is missing.', /permission.*missing/i],
];
const report = {
  microphone: false,
  playback: false,
  provider: false,
  speechOnly: true,
  results: [],
};
try {
  const start = performance.now();
  await worker.warm(AbortSignal.timeout(120000));
  report.coldMs = performance.now() - start;
  for (const [id, prompt, meaning] of cases) {
    const wav = join(output, id + '.wav');
    await promisify(execFile)(
      '/usr/bin/say',
      [
        '-v',
        'Samantha',
        '-r',
        '165',
        '-o',
        wav,
        '--file-format=WAVE',
        '--data-format=LEI16@16000',
        prompt,
      ],
      { timeout: 30000, killSignal: 'SIGKILL' },
    );
    const audio = decodeFixtureWav(await readFile(wav));
    let began = performance.now();
    const understood = await worker.interpret(
      audio,
      AbortSignal.timeout(60000),
    );
    const asrMs = performance.now() - began;
    began = performance.now();
    const speech = await worker.speak('Received.', AbortSignal.timeout(60000));
    const row = {
      id,
      prompt,
      caption: understood.text,
      asrMs,
      ackSynthesisMs: performance.now() - began,
      audioMs: speech.pcm.length / 48,
      pass:
        understood.route === 'delegate' &&
        meaning.test(understood.text) &&
        (id !== 'stop' || voiceTaskControl(understood.text) === 'stop') &&
        (id !== 'status' || voiceTaskControl(understood.text) === 'status') &&
        speech.text === 'Received.',
    };
    report.results.push(row);
    console.log(JSON.stringify(row));
    await writeFile(
      join(output, 'report.json'),
      JSON.stringify(report, null, 2),
    );
  }
  const times = report.results
    .map((r) => r.ackSynthesisMs)
    .sort((a, b) => a - b);
  report.ackP95Ms = times[Math.ceil(times.length * 0.95) - 1];
  report.pass = report.results.every((row) => row.pass);
  assert.ok(
    report.pass,
    'Inspect all speech cases; do not hide a failed attempt.',
  );
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await worker.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
