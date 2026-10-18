// Deliberately fixture reasoning in BOTH modes; never invokes a signed-in AI CLI.
/* global AbortController, DOMException, Request, Response */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { promisify, parseArgs } from 'node:util';
import { URL } from 'node:url';
import { Client } from 'pg';
import { Platform } from '../src/server/platform.ts';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace.ts';
import { LocalVoicePrototype } from '../src/server/local-voice/prototype.ts';
import { LocalSpeechWorker } from '../src/server/local-voice/worker.ts';
import {
  decodeFixtureWav,
  encodeFixtureWav,
} from '../src/server/local-voice/audio.ts';

const { values } = parseArgs({
  options: {
    fixture: { type: 'boolean' },
    'local-speech': { type: 'boolean' },
    python: { type: 'string' },
    assets: { type: 'string' },
    input: { type: 'string' },
  },
});
if (Boolean(values.fixture) === Boolean(values['local-speech']))
  throw new Error(
    'Choose --fixture or --local-speech. Local speech requires previously consented installation.',
  );
if (values.fixture && values.input)
  throw new Error('--input requires --local-speech');
if (values['local-speech'] && (!values.python || !values.assets))
  throw new Error(
    'Local speech requires explicit --python and --assets paths; nothing is downloaded.',
  );
const databaseUrl =
  process.env.LOCAL_TEST_DATABASE_URL || process.env.LOCAL_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'A running local PostgreSQL URL is required to create a disposable prototype database.',
  );
const adminUrl = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname))
  throw new Error(
    'Prototype database must be loopback; no remote database is used.',
  );
const database = 'dots_voice_prototype_' + randomUUID().replaceAll('-', '');
const testUrl = new URL(adminUrl);
testUrl.pathname = '/' + database;
testUrl.searchParams.set(
  'options',
  '-c statement_timeout=10000 -c lock_timeout=10000',
);
const root = await mkdtemp(join(tmpdir(), 'dots-local-voice-'));
const output = resolve(
  'artifacts/local-voice',
  `${Date.now()}-${values.fixture ? 'fixture' : 'local-speech'}`,
);
const python = resolve(
  'node_modules/myown-llm-integrator/python/.venv/bin/python',
);
await access(python);
const launcher = join(root, 'python-no-bytecode');
await writeFile(
  launcher,
  `#!/bin/sh\nexec '${python.replaceAll("'", "'\\''")}' -B "$@"\n`,
  { mode: 0o700 },
);
process.env.MYOWN_LLM_PYTHON = launcher;
process.env.AGENT_COMMAND_JSON = JSON.stringify([
  process.execPath,
  resolve('tests/fixtures/subscription-provider.mjs'),
]);
process.env.AGENT_LOCK_PATH = join(root, 'fixture.lock');
process.env.DO_NOT_TRACK = '1';
delete process.env.AGENT_ENV_PASSTHROUGH;

const engine = new LocalSpeechWorker(
  values.fixture
    ? {
        executable: '/usr/bin/python3',
        args: ['-B', resolve('tests/fixtures/voice-worker.py'), 'conversation'],
      }
    : {
        executable: resolve(values.python),
        args: [
          '-B',
          resolve('scripts/local-voice/worker.py'),
          '--assets',
          resolve(values.assets),
        ],
      },
);
const admin = new Client({
  connectionString: adminUrl.toString(),
  connectionTimeoutMillis: 10000,
  statement_timeout: 10000,
  lock_timeout: 10000,
  query_timeout: 15000,
});
let creationAttempted = false,
  platform,
  store,
  workspace,
  call,
  runError;
let adminConnected = false;
const originalFetch = globalThis.fetch;
let frames = [];
const lifetime = new AbortController();
const stop = () => {
  lifetime.abort(new DOMException('Prototype cancelled', 'AbortError'));
  if (!adminConnected) void admin.end().catch(() => {});
  void call?.end().catch(() => {});
  void engine.close().catch(() => {});
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  lifetime.signal.throwIfAborted();
  await admin.connect();
  adminConnected = true;
  lifetime.signal.throwIfAborted();
  creationAttempted = true;
  await admin.query(`CREATE DATABASE "${database}"`);
  lifetime.signal.throwIfAborted();
  await mkdir(output, { recursive: true });
  store = new Store(':memory:');
  workspace = new WorkspaceStore(':memory:', randomUUID());
  const token = randomUUID();
  const config = {
    conversationBackend: 'local',
    localDatabaseUrl: testUrl.toString(),
    llmBackend: 'subscription',
    llmProvider: 'claude-code',
    baseUrl: '',
    runtimeUrl: 'http://voice-prototype.invalid/api/copilotkit',
    ownerToken: token,
    voiceName: 'unused',
    slackUsers: [],
    webSearchProvider: 'disabled',
  };
  // Real Platform + SDK + durable runtime. Only transport is in-process for this CLI.
  // Reject ALL other fetches, so no accidental hosted integration can run.
  globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    if (
      !request.url.startsWith(config.runtimeUrl + '/') ||
      request.headers.get('Authorization') !== `Bearer ${token}`
    )
      return new Response('Fixture transport rejected request', {
        status: 403,
      });
    return platform.handle(request);
  };
  platform = new Platform(store, workspace, config);
  await platform.start();
  lifetime.signal.throwIfAborted();
  const thread = await platform.createConversation(
    workspace.dots()[0].id,
    'Local voice prototype fixture',
  );
  lifetime.signal.throwIfAborted();
  const sink = {
    async write(frame, signal) {
      signal.throwIfAborted();
      frames.push(Buffer.from(frame.pcm));
    },
    async flush() {
      frames = [];
    },
  };
  call = new LocalVoicePrototype(platform, thread.id, engine, sink);
  const warmStart = performance.now();
  await call.start();
  lifetime.signal.throwIfAborted();
  const warmupMs = performance.now() - warmStart;
  let pcm = Buffer.alloc(16000);
  let inputSource =
    'synthetic zero PCM + deterministic transcript fixture (not STT evidence)';
  if (values['local-speech']) {
    let inputFile = values.input && resolve(values.input);
    if (!inputFile) {
      if (process.platform !== 'darwin')
        throw new Error(
          'Provide a PCM16 mono16k --input WAV on this platform.',
        );
      const generated = await engine.synthesize(
        'Hello Dot. Please answer in one short sentence.',
        lifetime.signal,
      );
      const source = join(output, 'generated-input-24k.wav');
      await writeFile(source, encodeFixtureWav(generated, 24000));
      inputFile = join(output, 'generated-input-16k.wav');
      // Explicit sample conversion by macOS AudioToolbox, not a device-rate assumption.
      await promisify(execFile)(
        '/usr/bin/afconvert',
        ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', source, inputFile],
        { signal: lifetime.signal },
      );
      inputSource =
        'Kokoro-generated English fixture, explicitly resampled 24→16k by afconvert';
    } else inputSource = 'explicit local WAV file';
    if ((await stat(inputFile)).size > 1000000)
      throw new Error('Input WAV exceeds prototype file bound');
    pcm = decodeFixtureWav(await readFile(inputFile));
  }
  const turns = [];
  for (let i = 0; i < 2; i++) {
    lifetime.signal.throwIfAborted();
    frames = [];
    const result = await call.commit({
      utteranceId: `fixture-${i}`,
      pcm,
      sampleRate: 16000,
      channels: 1,
      language: 'auto',
    });
    await writeFile(
      join(output, `reply-${i + 1}.wav`),
      encodeFixtureWav(Buffer.concat(frames), 24000),
    );
    turns.push(result);
  }
  if (values.fixture) {
    assert(
      workspace.pages
        .list(workspace.dots()[0].spaceId)
        .some((page) => page.title === 'Offline fixture note'),
    );
    assert.match(turns[1].text, /Saved note context: present/);
  }
  await call.end();
  const before = await platform.history(thread.id);
  await platform.stop();
  platform = new Platform(store, workspace, config);
  await platform.start();
  lifetime.signal.throwIfAborted();
  assert.equal(await platform.history(thread.id), before);
  const report = {
    mode: values.fixture
      ? 'fixture-only'
      : 'real-local-speech-with-fixture-reasoning',
    modelDelivery: 'buffered',
    inputSource,
    warmupMs,
    turns,
    historyRestoredAfterRuntimeRestart: true,
    disposableDatabase: true,
    toolsExercised: Boolean(values.fixture),
    microphoneUsed: false,
    liveProviderInvoked: false,
    audioPlayed: false,
    limitations: [
      'No audible latency measured; file sink acknowledgements are not heard audio.',
      'Two samples do not establish p50/p95, naturalness or Indonesian quality.',
      'Headless approval UI tools remain unavailable; Talk remains gated.',
    ],
  };
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  process.stdout.write(
    JSON.stringify(
      {
        output,
        mode: report.mode,
        warmupMs,
        historyRestored: true,
        turns: turns.map((turn) => ({
          text: turn.text,
          delivery: turn.delivery,
          fileEndToPcmMs: turn.timings.firstPcm - turn.timings.fileEnd,
        })),
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  runError = error;
} finally {
  const cleanup = await Promise.allSettled([call?.end(), engine.close()]);
  cleanup.push(...(await Promise.allSettled([platform?.stop()])));
  for (const resource of [store, workspace]) {
    try {
      resource?.close();
    } catch (reason) {
      cleanup.push({ status: 'rejected', reason });
    }
  }
  globalThis.fetch = originalFetch;
  if (creationAttempted)
    cleanup.push(
      ...(await Promise.allSettled([
        admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
      ])),
    );
  cleanup.push(
    ...(await Promise.allSettled([
      admin.end(),
      rm(root, { recursive: true, force: true }),
    ])),
  );
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  const failures = cleanup.filter((result) => result.status === 'rejected');
  if (failures.length)
    runError = new AggregateError(
      [
        ...(runError ? [runError] : []),
        ...failures.map((failure) => failure.reason),
      ],
      'Prototype cleanup failed; all cleanup steps were attempted.',
    );
}
if (runError) throw runError;
