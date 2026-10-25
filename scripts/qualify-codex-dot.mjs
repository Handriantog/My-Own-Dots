/** Opt-in integration qualification: disposable data, existing subscription, synthetic speech only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lastValueFrom, toArray } from 'rxjs';
import { StorageClient } from '../src/server/storage/storage-client.ts';
import { Platform } from '../src/server/platform.ts';
import { DotAgent } from '../src/server/dot-agent.ts';
import { NativeVoiceWorker } from '../src/server/local-voice/native-worker.ts';
import { decodeFixtureWav } from '../src/server/local-voice/audio.ts';
import { delegatedApprovalTools } from '../src/server/local-voice/delegation.ts';
import { voiceJobReceipt } from '../src/server/local-voice/native-runtime.ts';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean' },
    output: { type: 'string' },
    speech: { type: 'boolean' },
    repeats: { type: 'string', default: '1' },
  },
});
if (!values.live || !values.output)
  throw Error(
    'Requires --live --output NEW_DIRECTORY. Uses the existing Codex allowance. Add --speech for silent local synthetic ASR/TTS.',
  );
const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3)
  throw Error('Use 1–3 repetitions.');
const output = resolve(values.output);
await mkdir(output);
const root = await realpath(
  await mkdtemp(join(tmpdir(), 'dot-codex-qualification-')),
);
const storage = await StorageClient.open({
  database: join(root, 'workspace.sqlite'),
  ownerId: randomUUID(),
  engine: 'sqlite',
});
const { store, workspace } = storage.repositories;
const config = {
  conversationBackend: 'local',
  storageEngine: 'sqlite',
  llmBackend: 'subscription',
  llmProvider: 'codex',
  agentEngine: 'codex',
  baseUrl: '',
  runtimeUrl: 'http://localhost/api/copilotkit',
  voiceName: 'marin',
  slackUsers: [],
  webSearchProvider: 'disabled',
  agentRunTimeoutMs: 180000,
};
const platform = await Platform.create(store, workspace, config, {
  storage,
  // Match the desktop tool catalog without opening an external browser in QA.
  openWebsite: async (url) => ({
    url,
    status: 'failed',
    error: 'This disposable qualification does not launch websites.',
  }),
});
const runtime = join(
  homedir(),
  'Library/Application Support/My Own Dots/native-voice',
);
const python = join(runtime, 'venv/bin/python');
const native = values.speech
  ? new NativeVoiceWorker({
      executable: python,
      args: [
        resolve('scripts/local-voice/native_launcher.py'),
        '--runtime-root',
        runtime,
        '--python',
        python,
        '--speech-only',
      ],
    })
  : {
      speak: async (text) => ({ text, pcm: Buffer.alloc(4) }),
      close: async () => {},
      respond: async () => {
        throw Error('Local conversation model must not run.');
      },
    };
const report = {
  startedAt: new Date().toISOString(),
  audio: values.speech
    ? 'synthetic; no microphone or playback'
    : 'finalized transcript fixture; no ASR/TTS',
  provider: 'Codex subscription',
  results: [],
};
try {
  await platform.start();
  if (values.speech) {
    const began = performance.now();
    await native.warm(AbortSignal.timeout(120000));
    report.speechColdMs = performance.now() - began;
  }
  const dot = (await workspace.dots())[0];
  for (let repetition = 1; repetition <= repeats; repetition++)
    for (const channel of ['text', 'voice']) {
      const result = { channel, repetition, pass: false };
      report.results.push(result);
      const project = join(root, `project-${channel}-${repetition}`);
      await mkdir(project);
      await writeFile(
        join(project, 'addition.mjs'),
        'export const add = (a, b) => a - b;\n',
      );
      const test =
        "import assert from 'node:assert/strict'; import { appendFileSync } from 'node:fs'; import { add } from './addition.mjs'; const actual = add(2, 3); appendFileSync('check-audit.jsonl', JSON.stringify({ actual }) + '\\n'); assert.equal(actual, 5); console.log('DOT_TEST_PASSED');\n";
      await writeFile(join(project, 'check.mjs'), test);
      await writeFile(join(project, 'openssl.cnf'), '');
      const thread = await platform.createConversation(
        dot.id,
        'Disposable coding qualification',
      );
      const request = await workspace.folders.request(dot.id, thread.id, {
        reason: 'Disposable qualification project',
        folderHint: project,
        access: 'execute',
      });
      const selection = await workspace.folders.select(
        thread.id,
        request.id,
        project,
      );
      await workspace.folders.decide(thread.id, request.id, {
        toolCallId: randomUUID(),
        approve: true,
        selectionId: selection.id,
        access: 'execute',
      });
      const prompt =
        'Fix the addition bug in the approved project. Reproduce the failure, edit the implementation, and run the unchanged check.mjs again. Use the project openssl.cnf as OPENSSL_CONF when running Node. Report the observed test result.';
      let caption = prompt;
      let audio = Buffer.alloc(4);
      if (channel === 'voice' && values.speech) {
        const wav = join(output, `input-${repetition}.wav`);
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
        audio = decodeFixtureWav(await readFile(wav));
        const began = performance.now();
        const understood = await native.interpret(
          audio,
          AbortSignal.timeout(60000),
        );
        result.asrMs = performance.now() - began;
        caption = understood.text;
      }
      result.caption = caption;
      const began = performance.now();
      let taskThread = thread.id;
      if (channel === 'text') {
        const agent = new DotAgent(
          store,
          workspace,
          config,
          dot.id,
          false,
          platform.setupTelemetry,
          platform.memory,
          storage.repositories.voiceDelegations,
          platform.openWebsite,
          platform.abilities,
        );
        const events = await lastValueFrom(
          platform.localRunner
            .run({
              threadId: thread.id,
              agent,
              input: {
                threadId: thread.id,
                runId: randomUUID(),
                messages: [
                  { id: randomUUID(), role: 'user', content: caption },
                ],
                tools: delegatedApprovalTools,
                context: [],
                state: {},
                forwardedProps: {},
              },
            })
            .pipe(toArray()),
        );
        result.errors = events.filter((event) => event.type === 'RUN_ERROR');
      } else {
        const call = await workspace.createCall(thread.id);
        await platform.nativeVoice.turn({
          callId: call.id,
          dotId: dot.id,
          threadId: thread.id,
          messageId: randomUUID(),
          audio,
          understanding: { route: 'chat', text: caption },
          native,
          signal: AbortSignal.timeout(180000),
        });
        result.ackMs = performance.now() - began;
        let job;
        for (;;) {
          job = (await platform.nativeVoice.list(thread.id))[0];
          if (job && !['queued', 'running'].includes(job.status)) break;
          if (performance.now() - began > 180000)
            throw Error('Voice task timeout');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        result.voiceStatus = job.status;
        taskThread = job.workerThreadId;
        await writeFile(
          join(output, `events-${channel}-${repetition}.json`),
          JSON.stringify(
            await platform.localConversations.getSnapshot(taskThread),
            null,
            2,
          ),
        );
        assert.equal(job.status, 'completed');
        if (values.speech) {
          const started = performance.now();
          result.spoken = voiceJobReceipt(job, true).spoken;
          await writeFile(
            join(output, 'report.json'),
            JSON.stringify(report, null, 2),
          );
          const spoken = await native.speak(
            result.spoken,
            AbortSignal.timeout(60000),
          );
          result.ttsMs = performance.now() - started;
          result.spoken = spoken.text;
          result.audioMs = spoken.pcm.length / 48;
        }
      }
      result.totalMs = performance.now() - began;
      const snapshot =
        await platform.localConversations.getSnapshot(taskThread);
      await writeFile(
        join(output, `events-${channel}-${repetition}.json`),
        JSON.stringify(snapshot, null, 2),
      );
      result.status = snapshot.lastRun?.status;
      assert.equal(result.status, 'finished');
      assert.equal(await readFile(join(project, 'check.mjs'), 'utf8'), test);
      const evidence = snapshot.messages
        .filter((m) => m.role === 'tool')
        .map((m) => {
          try {
            return JSON.parse(m.content);
          } catch {
            return null;
          }
        });
      assert.ok(
        evidence.some(
          (e) =>
            e?.kind === 'command' &&
            e.exitCode === 0 &&
            /^DOT_TEST_PASSED$/m.test(e.output ?? ''),
        ),
        'Missing actual successful command evidence',
      );
      const observations = (
        await readFile(join(project, 'check-audit.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).actual);
      result.checkObservations = observations;
      assert.equal(
        observations[0],
        -1,
        'The unchanged check did not observe the failure before the edit',
      );
      assert.equal(
        observations.at(-1),
        5,
        'The unchanged check did not observe the fix',
      );
      result.pass = true;
      await writeFile(
        join(output, 'report.json'),
        JSON.stringify(report, null, 2),
      );
      console.log(JSON.stringify(result));
    }
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await native.close();
  await platform.stop();
  await storage.close();
  await rm(root, { recursive: true, force: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
