# Local voice prototype

This records the first file-audio feasibility prototype, reconciled with the active root checkout on October 18, 2026. The compact cloud menu, stationary Dot while the menu is open, matching chat avatar and readable header remain in place. This report describes the completed file-audio stage. The subsequent [local voice call implementation](local-voice-calls.md) adds the desktop Talk path; its hardware checks remain separate.

## What works in this slice

`LocalVoicePrototype` accepts a server-owned Platform/thread binding and a supervised local speech worker. It holds foreground activity through warmup and silence, commits each file utterance once through `Platform.turn()`, and sends only successful final assistant text to synthesis. Existing Dot context, memory, server tools, permissions and canonical history remain on the normal runtime path. There is no sidecar reasoning model or separate voice conversation store.

Input is finalized PCM16 mono at 16 kHz, at most 30 seconds. The worker returns a committed transcript with language and segment times. Output is buffered PCM16 mono at 24 kHz, at most 30 seconds, delivered to a sink in frames of at most 40 ms with one outstanding acknowledgement. Frames identify call, turn, sequence, sample offset and text span. Interruption aborts inference, terminates/reaps the speech worker, discards late output and flushes the sink. A new session is required after interruption or failure. Duplicate utterances, concurrent turns, changed thread bindings and oversized/malformed audio are rejected.

The first synthesis bound is **400 characters**. A longer answer remains in canonical chat and produces an explicit prototype speech error; it is not silently truncated. Generated and accepted samples are recorded separately. Played samples and physical audible timing remain unknown for the file sink.

## Streaming capability findings

Installed versions checked: Integrator **0.1.0**, Codex CLI **0.157.1**, Node **24.20.0**, Integrator Python **3.12.13**. Only CLI help/version was invoked; no signed-in provider inference was used.

| Boundary                            | Verified behavior                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integrator Python process/transport | Buffers stdout; parses and validates the complete provider result after completion.                                                                                               |
| Integrator Node API                 | `runAgent()` resolves after bridge process close; no public incremental callback or iterator.                                                                                     |
| Dots subscription adapter           | Validates the decision envelope, tool names and argument objects before emitting one complete-step text event. Application executors still enforce full tool schemas/permissions. |
| Durable local runtime               | Persists events before SSE delivery; prototype preserves this boundary.                                                                                                           |
| Headless/`Platform.turn()`          | Waits for the completed current turn and returns its assistant text. Partial SSE text does not become speech.                                                                     |
| Cancellation                        | Abort signals and process-group cleanup work in fixtures. Headless requests scoped stop but does not expose awaited remote acknowledgement or a measured stop deadline.           |

Codex's JSONL option does **not** establish safe incremental user-facing text. Future Integrator streaming work belongs in its source repository and requires a coordinated versioned package update; neither sibling source nor installed package was patched here.

Headless calls currently provide no client approval tools. Approval-gated connection actions stay unavailable; the prototype cannot approve them. This is governed headless behavior, **not full chat approval-UI parity**. An OpenAI-compatible loopback endpoint is also not evidence of local reasoning parity: local memory construction still depends on the subscription backend. Those are gates before desktop Talk integration.

## Run the deterministic checks

```sh
npm run voice:check
npx vitest run tests/local-voice-*.test.ts tests/headless-streaming-boundary.test.ts
python3 -B scripts/local-voice/test_worker.py
```

The capability probe uses the installed Integrator Python environment and a custom fixture executable. Its `claude-code` selection chooses the custom-command path; it never invokes Claude or another signed-in CLI. It proves zero text before complete validation/process exit, invalid-result rejection, cancelled process termination and subsequent lock recovery. If the installed Integrator Python environment is missing, it reports that instead of running setup.

The complete fixture pipeline additionally needs the existing local PostgreSQL service and `LOCAL_DATABASE_URL` (loaded from `.env`), or `LOCAL_TEST_DATABASE_URL`:

```sh
npm run voice:prototype -- --fixture
```

The command creates a uniquely named disposable PostgreSQL database and in-memory workspace, forces fixture reasoning, and routes SDK requests through the real Platform in process. It runs two turns, creates a note with an existing server tool, verifies follow-up context, restarts the runtime and verifies history restoration. It drops only the database it created. It does not modify the owner's workspace or conversation database. SIGINT/SIGTERM cancel setup/active work; startup database operations have deadlines.

Reports and WAV files go into `artifacts/local-voice/<run>/`. **Fixture WAV output is synthetic zero PCM; it is not recognized or synthesized speech.** First fixture observations included a ~29 ms synthetic-worker warmup and ~521/166 ms file-end-to-fixture-PCM for two turns. These are harness observations, not real speech, subscription latency, audible response, or p50/p95 results.

## Real local speech readiness

The optional worker uses **pywhispercpp 1.5.1**, multilingual **Whisper base**, and **kokoro-onnx 0.6.1** with Kokoro v1.0 and preset `af_heart`. The worker loads both engines once, hashes every local model/preset before loading, verifies pinned dependency versions, disables automatic model download, and keeps native logs off its JSON protocol stream. It uses CPU ONNX execution; accelerated Whisper paths have not been benchmarked. [pywhispercpp source](https://github.com/absadiki/pywhispercpp), [Kokoro ONNX source](https://github.com/thewh1teagle/kokoro-onnx).

The [asset manifest](../../scripts/local-voice/manifest.json) and [runtime lock](../../scripts/local-voice/runtime-lock.json) pin sources, versions, SHA-256 hashes, licenses and download/installed sizes. After explicit owner consent, **544,166,265 bytes** of models and 21 wheels were downloaded, hash/size verified and installed from the local wheel directory without index access. The dedicated setup occupies about **700 MB** including retained wheels, within the approved 1 GB download/3 GB disk budget. The Python interpreter is reused. License details include the GPL phonemizer/eSpeak dependencies; redistribution/native-source inventory remains incomplete.

The evaluation setup is installed at `~/Library/Application Support/My Own Dots/local-voice/{venv,assets,wheels}`. This owner's installation/file-audio consent has been used; it does not authorize microphone, live-provider or speaker tests. For a different machine, follow [the worker setup instructions](../../scripts/local-voice/README.md) after obtaining that installation consent. Run:

```sh
npm run voice:prototype -- --local-speech \
  --python /absolute/path/to/voice-venv/bin/python \
  --assets /absolute/path/to/verified-models
```

This mode still forces fixture reasoning. On macOS it generates an English input phrase with Kokoro, explicitly resamples that file with AudioToolbox `afconvert`, recognizes it with Whisper, passes the transcript through the same Dot runtime, then writes the reply WAV. It never opens a microphone or plays sound. Alternatively provide `--input /absolute/path/to/pcm16-mono-16k.wav`; supplied input must fit the same bounds. Indonesian capability comes from the multilingual model choice; Indonesian quality and code-switching have not been demonstrated. Output remains English-first.

## Permissioned file-audio result — October 18

Two turns completed with real Whisper/Kokoro and fixture reasoning; history matched after runtime restart. The input phrase was “Hello Dot. Please answer in one short sentence.” Both transcriptions detected English but omitted **Dot**, returning “Hello. Please answer in one short sentence.” This is a limited recognition check, not a quality benchmark. Output WAVs contain about 5.98 and 6.09 seconds of generated speech; no listening assessment was performed.

| Observation                                                              | Result                                 |
| ------------------------------------------------------------------------ | -------------------------------------- |
| First cold warmup, including imports/hashes/model loading                | 13,246 ms                              |
| Turn 1: recognition / fixture model / buffered synthesis                 | 437 / 345 / 941 ms                     |
| Turn 2: recognition / fixture model / buffered synthesis                 | 82 / 175 / 940 ms                      |
| File end → generated PCM                                                 | 1,724 / 1,198 ms                       |
| Separate network-denied worker warmup, after filesystem caches were warm | 1,112 ms                               |
| Network-denied English recognition/synthesis                             | Passed                                 |
| Cancel active synthesis → worker close acknowledgement                   | 10.7 ms, one software-only observation |

The offline check launched the speech worker under macOS `sandbox-exec` with `(deny network*)`; it transcribed the same file, synthesized a reply, then cancelled active synthesis. Worker process cleanup passed. This checks local speech offline operation, not offline reasoning. The full pipeline's `time -l` reported maximum RSS **946,208,768 bytes**; that is a command-level measurement, not aggregate system memory or sustained resource use. No remaining worker or disposable prototype database was found after cleanup.

Artifacts: `artifacts/local-voice/1792303499595-local-speech/{report.json,generated-input-16k.wav,reply-1.wav,reply-2.wav}`, `artifacts/local-voice/offline-cancellation.json`, and `artifacts/local-voice/installed-runtime.json`. File-end timing is not physical end-of-speech detection or audible onset. These samples are insufficient for p50/p95 and do not establish the one-second conversational target; subscription buffering will add its own cost.

Verification: **654 TypeScript tests passed, 20 skipped; 10 Python worker tests passed**. Root typecheck, server NodeNext typecheck, lint, targeted formatting and diff checks pass. Fixtures also cover malformed protocol/audio, stale output after cancellation, duplicate commits, startup cancellation and foreground cleanup. Review found and corrected setup cancellation, late database creation cleanup and native Whisper failure handling.

## Remaining gates

Live subscription checks, microphone capture and speaker playback require their own permission. The subsequent call implementation adds Silero detection, interruption, bounded transport, approval continuity, software-delivery records and desktop lifecycle controls. Permissioned listening and stability benchmarks remain outstanding. Indonesian/code-switching quality and sustained resource use remain unmeasured. Qwen3-TTS comparison remains a later benchmark; this initial Kokoro sample does not select the shipped voice.

This guide is the standalone record of the completed file-audio prototype; use the local voice call guide for the current desktop workflow.
