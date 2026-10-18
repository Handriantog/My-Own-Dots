// Fixture-only capability probe. Run: node --import tsx scripts/check-voice-capabilities.mjs
// No authenticated CLI, uv setup, model download, microphone or audio playback.
/* global AbortController */
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { subscriptionText } from '../src/server/subscription-adapter.ts';
import { voiceModelCapabilities } from '../src/server/local-voice/capabilities.ts';

const root = await mkdtemp(join(tmpdir(), 'dots-voice-capability-'));
const python = fileURLToPath(
  new URL(
    '../node_modules/myown-llm-integrator/python/.venv/bin/python',
    import.meta.url,
  ),
);
const fixture = fileURLToPath(
  new URL('../tests/fixtures/voice-provider.mjs', import.meta.url),
);
const active = new Set();
const observed = async (path, event) => {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === event);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
};
async function waitFor(predicate) {
  const deadline = performance.now() + 10000;
  while (true) {
    const result = await predicate();
    if (result) return result;
    if (performance.now() >= deadline)
      throw new Error('Fixture observation timed out.');
    await setTimeout(10);
  }
}
function stopped(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}
async function probe(mode, name = mode) {
  const observationPath = join(root, name + '.jsonl');
  const suffixGate = join(root, name + '.suffix');
  const exitGate = join(root, name + '.exit');
  process.env.AGENT_COMMAND_JSON = JSON.stringify([
    process.execPath,
    fixture,
    mode,
    observationPath,
    suffixGate,
    exitGate,
  ]);
  const controller = new AbortController();
  active.add(controller);
  const began = performance.now();
  const timingsMs = {};
  const events = [];
  const collect = (async () => {
    for await (const event of subscriptionText({
      provider: 'claude-code',
      timeoutMs: 15000,
    }).chatStream({
      messages: [{ role: 'user', content: 'voice-capability-fixture' }],
      tools: [],
      systemPrompts: [],
      abortController: controller,
    })) {
      events.push(event);
      if (
        event.type === 'TEXT_MESSAGE_CONTENT' &&
        timingsMs.firstValidatedText === undefined
      )
        timingsMs.firstValidatedText = performance.now() - began;
    }
  })();
  const texts = () =>
    events.filter((event) => event.type === 'TEXT_MESSAGE_CONTENT');
  try {
    const first = await waitFor(() =>
      observed(observationPath, 'fragment-written'),
    );
    timingsMs.firstFixtureFragmentObserved = performance.now() - began;
    await setImmediate();
    const textBeforeSuffix = texts().length;
    assert.equal(
      textBeforeSuffix,
      0,
      'Partial provider JSON escaped validation.',
    );
    if (mode === 'cancel') {
      controller.abort();
      await collect;
      await waitFor(() => stopped(first.pid));
      assert.equal(texts().length, 0);
      return { textEvents: 0, providerStopped: true };
    }
    await writeFile(suffixGate, 'release', { flag: 'wx' });
    await waitFor(() => observed(observationPath, 'complete-written'));
    timingsMs.completeFixtureOutputObserved = performance.now() - began;
    await setImmediate();
    const textBeforeExit = texts().length;
    assert.equal(
      textBeforeExit,
      0,
      'Provider output escaped before subprocess completion.',
    );
    await writeFile(exitGate, 'release', { flag: 'wx' });
    await collect;
    timingsMs.adapterCompleted = performance.now() - began;
    const errors = events.filter((event) => event.type === 'RUN_ERROR');
    if (mode === 'invalid') {
      assert.equal(texts().length, 0);
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /invalid response envelope/);
      return { textEvents: 0, errorEvents: errors.length };
    }
    assert.equal(errors.length, 0);
    assert.equal(texts().length, 1);
    const result = texts()[0].delta;
    assert.equal(
      result,
      'Offline provider completed with 1 context messages. Saved note context: absent.',
    );
    return {
      textBeforeSuffix,
      textBeforeExit,
      textEvents: texts().length,
      result,
      timingsMs,
    };
  } finally {
    controller.abort();
    await collect;
    active.delete(controller);
  }
}

try {
  await access(python, constants.X_OK).catch(() => {
    throw new Error(
      'Installed Integrator Python is unavailable; no setup or download was attempted.',
    );
  });
  // -I ignores PYTHONDONTWRITEBYTECODE. A launcher adds -B explicitly so the
  // installed package remains untouched while its real Python bridge executes.
  const launcher = join(root, 'python-no-bytecode');
  const quotedPython = "'" + python.replaceAll("'", "'\\''") + "'";
  await writeFile(launcher, `#!/bin/sh\nexec ${quotedPython} -B "$@"\n`, {
    mode: 0o700,
  });
  process.env.MYOWN_LLM_PYTHON = launcher;
  process.env.AGENT_LOCK_PATH = join(root, 'requests.lock');
  process.env.AGENT_TIMEOUT_SECONDS = '15';
  process.env.AGENT_QUEUE_TIMEOUT_SECONDS = '5';
  // Prevent deployment passthrough from influencing the fixture subprocess.
  delete process.env.AGENT_ENV_PASSTHROUGH;
  const valid = await probe('valid');
  const invalid = await probe('invalid');
  const cancellation = await probe('cancel');
  const recovered = await probe('valid', 'after-cancellation');
  const capability = voiceModelCapabilities({
    llmBackend: 'subscription',
    llmProvider: 'claude-code',
  });
  process.stdout.write(
    JSON.stringify(
      {
        mode: 'fixture-only',
        integratorVersion: capability.integrator.version,
        liveProviderInvoked: false,
        fixtureProviderSelection:
          'claude-code custom command; no Claude CLI invoked',
        valid,
        invalid,
        cancellation,
        recovered,
        limitations: [
          'Fixture timings are not live-provider or audible latency.',
          'First fragment means this probe observed the fixture marker, not an internal Python read timestamp.',
          'The adapter emits one validated complete-step text event; headless adds a final-turn boundary.',
          'Internal validation, bridge stdout and child-close timestamps are not exposed by the legacy runAgent API.',
          'Cancellation checks fixture process termination, not remote provider acknowledgement.',
        ],
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  for (const controller of active) controller.abort();
  await rm(root, { recursive: true, force: true });
}
