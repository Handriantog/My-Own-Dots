# Native voice evaluation

High now uses the owner-approved local hybrid repair below: Qwen chooses conversational wording from text, and LFM generates speech with access to the original audio. The original LFM-native conversation implementation passed plumbing checks but failed the owner's ordinary small talk. Enabling High requires an explicitly installed runtime, compatible Apple Silicon host and SQLite workspace. Physical listening and extended-call acceptance remain outstanding; installation alone does not establish audio quality or acceptable performance.

## Physical-action routing repair — October 25, 2026

The installed Qwen router classified “Hello Jane, can you move my mouse around?” and “Stop Mouse Mover.” as conversation. That bypassed delegation and its tool receipts. The routing prompt now explicitly covers computer/device actions, Abilities, starting/stopping/resuming activities, and greetings followed by an action request. Reported speech, quotations, hypotheticals and negation retain priority. No keyword override, task permission or model change is involved.

Router-only evaluation used the existing verified Qwen4 runtime with network, Keychain and audio services denied. The original prompt passed 63/70 cases; the revised prompt passed 68/70, including all 13 new action/negative/context cases and every previously passing case. Two existing mismatches remain: a hypothetical file-permission question returns `clarify` instead of `chat`, and “Yes, go ahead” without history returns `chat` instead of `clarify`. Neither starts work. These are text-routing measurements, not microphone or live action acceptance.

The free-form conversation branch is still a grounding limit. Forced-chat probes with a previous “Mouse Mover started” statement produced false restart/stop claims without execution. Additional conversation instructions did not reliably prevent this and were not shipped. Correct routing sends the tested action requests through governed task execution; it does not prove every future utterance is classified correctly.

Run the retained silent evaluator after explicitly selecting an installed native runtime:

```sh
python3 -I -S -B scripts/local-voice/evaluate_routing.py \
  --runtime-root "/absolute/native-voice-runtime" \
  --output-dir "/new/evaluation-directory"
```

It verifies the existing wheel inventory and local Qwen assets, stages the current worker and fixtures, and writes `report.json`, raw results and stderr. It does not install, download, generate/play audio, invoke a provider, or execute a task. The command returns nonzero for any expected-route mismatch, including the two documented residual cases.

## Task-announcement voice repair — October 21, 2026

The owner confirmed good conversation quality/speed but reported a female-to-male voice change on delegation. `speak()` used the upstream sequential TTS recipe with the explicit instruction **“Perform TTS. Use a UK male voice.”** Conversation used interleaved speech. This affected queued/busy announcements and later approval/result receipts, not the subscription agent's voice.

Both `respond()` and `speak()` now use the same constrained interleaved renderer and sampling settings. Task updates use host-owned wording directly, without asking Qwen to rewrite status; canonical receipt spacing is retained while synthesized whitespace is normalized. Text mismatches fail closed, and the temporary sampler restores even on error. No models, dependencies, permissions or task execution paths changed.

A silent same-text comparison measured median voiced pitch of about 106 Hz for the old task recipe, 175 Hz for conversational generation and 182 Hz for interleaved task speech. This supports the reported speaker-mode mismatch; pitch alone does not prove identical perceived timbre. All eight generated task-status recordings were produced and returned their exact canonical text; conversation still worked afterward. Independent Whisper checks disagreed on “queued”/“huge” and “task”/“test”, failed timestamp validation on the failure receipt, and omitted the final sentence of a long receipt. LFM's ASR retained the corresponding status/negation, but these round trips do **not** establish exact spoken fidelity. No microphone, physical playback or real task was used. Human listening remains the voice-consistency acceptance check.

Regression evidence: the new worker test failed on the old decoder branch, then passed with receipt-wording, whitespace and mismatch checks. All 33 native Python checks and 22 focused TypeScript adapter/runtime/call tests passed. Independent narrow review found no concrete issue. The running development app received only the updated Python worker atomically for its next call; a real bundled-launcher approval-receipt probe passed; restarting the backend would disturb a pending owner approval and is unnecessary for this worker-only change.

## Small-talk repair — October 21, 2026

The saved user captions were accurate for “I am trying to sleep. How about you?”; the reply generator nevertheless refused and repeated its earlier refusal. Separate instructions and history roles, prompt changes, sequential/interleaved LFM variants, and Qwen 1.7B correction did not reliably fix conversation. Qwen3-4B-Instruct-2507 generates more useful short replies from the recognized caption, authorized Dot instructions and bounded real conversation turns. Its output must end normally, contain plain speech, and fit the length limit. Legitimate refusals are retained; no refusal-substring rewrite or canned bedtime answer is shipped.

The selected composition is **caption → Qwen wording**, then **original waveform + constrained wording → LFM interleaved speech**. The pinned LFM text sampler is temporarily constrained to the Qwen tokens and restored even on error; serialized requests prevent overlapping overrides. Task routing remains local and only validated delegation reaches the normal agent. Task receipts retain host-owned wording and now use the shared interleaved speaker described above. This is a local hybrid, not fully audio-aware answer selection. The owner explicitly approved activating it after this limitation was explained. Vocal emotion and background sounds do not inform Qwen's wording; their effect on spoken delivery has not been established.

The actual sandboxed adapter passed 20 generated-audio checks: sixteen harmless conversation/control inputs, one legitimate refusal, and three work requests. Bedtime produced “I don't sleep, but I'm here if you need me for anything tomorrow. Good night!” in 2.98 s; recovery from contaminated refusal history took 3.21 s, name/persona 2.15 s and remembered-label recall 2.43 s. These include recognition, routing and whole-response generation, exclude live microphone/playback, and are individual samples rather than latency guarantees. The automated checks are coarse; every generated reply was also read. Some replies remain generic. Five independent Whisper round trips preserved key meanings/negations and names but included word errors; exact spoken fidelity and physical listening are not proven.

Reproduce the explicitly requested, silent hardware checks with `node --import tsx scripts/evaluate-native-voice.mjs --runtime-root /absolute/runtime --output-dir /new/output-directory`. This uses Apple `say` to write recordings and the production sandboxed worker. It never opens the microphone, plays audio or invokes a provider. The fixtures and machine-readable report are retained. Focused regression verification: 63 TypeScript tests; 10 native-worker, 4 launcher and 18 setup Python tests; typecheck/lint. Earlier full-suite/build figures below predate this repair.

**Model-data review before execution:** [mlx-community/Qwen3-4B-Instruct-2507-4bit](https://huggingface.co/mlx-community/Qwen3-4B-Instruct-2507-4bit), derived from [Qwen's Instruct checkpoint](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507), is Apache-2.0 and pinned to `50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b`. Only four allowlisted JSON/safetensors files are used; published Git/LFS digests and local SHA-256/byte counts were verified. Configuration selects the existing reviewed Qwen implementation and Qwen2 tokenizer, without `auto_map`, remote code or executed model-supplied templates. No new package, native binary or dependency was installed. The existing MLX wheel/native-code review limitations still apply. LFM plus the new Qwen data totals **3,682,006,015 bytes**; the current manifest records all hashes. The previous 1.7B runtime remains intact; install changed manifests into a separate runtime directory.

An attempted LFM audible-tone/background summary hallucinated distant chatter and a clock in clean generated speech. It was rejected and is not part of this repair. A fresh file-only Nemotron 11B bedtime probe did respond without refusing (“I am here and ready to help whenever you are ready”), with first speech 1.13 s after input and a measured 12.92 GB physical-footprint peak. One sample does not establish conversation quality; the earlier memory, routing and frame-deadline limitations still apply. No larger native model is activated by this repair.

The installed replacement repeated all 20 checks successfully. First use warmed in 20.56 s; a subsequent full service call started in 4.59 s and generated 6.64 s of reply audio 3.14 s after supplied bedtime input. It saved “I don't sleep, but I'm here whenever you need a chat. Good night to you!” through canonical persistence, with real task inference prohibited. The desktop rebuild passed; the running app now shows High selected and ready. The previous runtime and a private configuration backup are retained. The call remains stopped. An additional 20-test settings/setup suite passed after the capability text changed.

## Evaluation host

The inspected host is an Apple M3 Max with 36 GiB unified memory, macOS 26.6.2 and Xcode Swift 6.4. Evaluation includes actual offline inference with verified Nemotron INT5 and LFM 4-bit weights. Model probes use synthetic recordings written directly to WAV by the existing Apple `say` tool, plus generated silence/noise. They use no microphone, speaker playback or live subscription. A separate integration-test configuration mistake may have invoked the live Codex CLI; see the integrated checkpoint below.

## Original candidate evidence — before the small-talk repair

| Candidate                                              | Native audio path                                                                                            | Delegation and implementation status                                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NVIDIA NemotronLabs VoiceChat 11B through speech-swift | Measured original audio → captions and generated speech; 16 kHz input, 22.05 kHz output, 80 ms frames        | Explicit delegation and fake-result continuation work. Three ordinary work requests miss delegation, including with a Dot-specific prompt. Not selected for production.                                       |
| The same Nemotron model through MLX Audio              | Source includes offline and duplex audio generation, user captions, assistant text and function-token events | The inspected streaming API exposes function deltas but no public completed-tool/result-injection operation. Additional adapter/runtime work is needed before a governed task round trip can be demonstrated. |
| Liquid LFM2.5 Audio 1.5B through MLX Audio             | Measured original audio → interleaved text and 24 kHz speech; English                                        | Much smaller measured allocation. Neither tested routing prompt produces the required reliable structured handoff; an audio-input tool/result round trip is not established.                                  |
| Speaches and Vocalis                                   | Keep as local speech-stack references from the original shortlist                                            | A recognition → text model → synthesis pipeline does not meet the native High requirement by itself.                                                                                                          |

The [official Nemotron model](https://huggingface.co/nvidia/NVIDIA-NemotronLabs-VoiceChat-11B) and [LFM model card](https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B) describe model capabilities. Those claims do not establish acceptable performance, emotion interpretation or task reliability in Dot.

## Exact runtime revisions

- `soniqo/speech-swift`: `3f58a58a8f867a4c87b97dbf4d6050d6a88ef665`. See its [VoiceChat session implementation](https://github.com/soniqo/speech-swift/blob/3f58a58a8f867a4c87b97dbf4d6050d6a88ef665/Sources/VoiceChat/VoiceChatSession.swift) and [model instructions](https://github.com/soniqo/speech-swift/blob/3f58a58a8f867a4c87b97dbf4d6050d6a88ef665/docs/models/voicechat.md).
- The Swift runtime's complete INT5 bundle is `aufklarer/VoiceChat-11B-Perception-MLX-int5` at revision `11c937c1826bb79abbaa210091fafaa14576b785`. Despite the legacy “Perception” name, it includes encoder, language model and TTS weights. Approximately 8.58 GB of selected data is downloaded and verified; this does not make it a production-selected model. No repository Python code was downloaded or executed.
- The LFM bundle is `mlx-community/LFM2.5-Audio-1.5B-4bit` at `55d4de65fa10fa935561aaaa995271d8b8ff2ee0`. Seven selected JSON/safetensors files total approximately 1.408 GB, including the audio detokenizer. The unused Mimi checkpoint and remote code are excluded.
- `Blaizzy/mlx-audio`: `4510ba631faf5676b2bf4633161756664d154e28` (source version 0.6.1). Inspected [Nemotron streaming API](https://github.com/Blaizzy/mlx-audio/blob/4510ba631faf5676b2bf4633161756664d154e28/mlx_audio/sts/models/nemotron_voicechat/streaming.py) and [LFM implementation](https://github.com/Blaizzy/mlx-audio/blob/4510ba631faf5676b2bf4633161756664d154e28/mlx_audio/sts/models/lfm_audio/model.py). Neither is added to Dot's production dependencies.

## Swift build and password prompt

The evaluation invoked the existing Xcode package manager to build `voicechat-bench` in ignored worktree scratch. It did not request `sudo` or install Swift globally. The initial build stalled while fetching a public GitHub binary dependency, and the owner reported a `swift-package` password prompt.

The owner confirmed that the prompt requested access to a Keychain item. The installed tool's `swift build --help` confirms that Keychain credential lookup defaults to enabled for package downloads. The exact item was not inspected. The build was terminated, then the same artifact downloaded successfully with credential lookup disabled:

```sh
GIT_TERMINAL_PROMPT=0 \
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=credential.helper \
GIT_CONFIG_VALUE_0='' \
swift build --disable-keychain --disable-netrc \
  -c release --product voicechat-bench -j 4
```

The retry advanced into compilation and failed at `CompileMetalFile`. Independently, `xcrun -sdk macosx metal --version` reported the missing Metal Toolchain and suggested:

```sh
xcodebuild -downloadComponent MetalToolchain
```

The owner explicitly approved the component installation. Xcode downloaded 838.9 MB, reporting Metal Toolchain `27A266a`; `xcrun -sdk macosx metal --version` then returned Apple Metal `32023.921`. No authentication prompt was accepted.

The local `swift-package` executable passed `codesign --verify --strict`, with an Apple Root CA certificate chain and identifier `com.apple.swift-package`. This verifies the Apple package manager, not the safety of the community package. The package manifest includes a checksum-pinned precompiled `SpeechCore.xcframework` dependency; it is outside the benchmark target's direct dependencies but was fetched during package resolution. A full dependency/binary audit has not been performed. The source scan of the benchmark and VoiceChat modules found no direct Keychain calls; that limited scan is not a safety certification.

Following the owner's safety question, the community benchmark was held. The owner subsequently explicitly approved installing the package. This authorizes the evaluation build; it does not establish package safety or make High available. Use a restricted execution environment with file fixtures, no provider credentials and no network access for runtime evaluation. Do not enter a password, grant Keychain access or weaken protections to fetch public dependencies. Retain credential-free build flags on retries.

## Dependency review before the approved retry

The candidate came from the community [soniqo/speech-swift repository](https://github.com/soniqo/speech-swift), introduced during the expanded search for native audio and tool-result handling on Apple Silicon. It is optional for High and unnecessary for Basic or Medium. The earlier build began before an adequate dependency review; future agents must follow the unfamiliar-dependency instructions in the worktree's `AGENTS.md`.

The inspected lockfile contains 39 source dependencies. An OSV batch query for their SwiftURL package names and exact versions returned 39 empty results; this means no matching database records, not complete coverage or a safety certification. The project's [security page](https://github.com/soniqo/speech-swift/security) reports no security policy or published advisories. Its contribution history is concentrated in one maintainer. No comprehensive source or binary audit has been performed.

The [SpeechCore v0.0.14 release](https://github.com/soniqo/speech-core/releases/tag/v0.0.14) reports a SHA-256 digest matching the manifest's pinned archive checksum. That supports artifact consistency, not safe behavior. Transitive manifests include build plugins and a Swift macro target: the inspected MLX CUDA plugin returns no build commands on macOS, ArgumentParser's plugins are manually invoked documentation commands, and the MLX Hugging Face macro target is outside this benchmark's direct target path. Keep the build restricted regardless.

## Approved installation result

The release build of `voicechat-bench` succeeded at the pinned revision on 2026-10-21. Its `--help` command exits successfully under the restricted launcher. The binary is arm64, its local code signature verifies, and the MLX Metal library was generated. Signature verification here checks the locally built artifact's integrity; it does not certify the community source. The upstream checkout and lockfile remain unchanged.

The evaluation binary is `.superpowers/sdd/voice-quality-handover/speech-swift/.build/release/voicechat-bench` in this worktree. The build directory occupies approximately 1.8 GB. No global speech CLI or Dot production dependency was installed. Binary SHA-256: `dc34ed637702feb7d29b20470375d448b62d4b2754bea383547c4aa0f3869621`.

Use `.superpowers/sdd/voice-quality-handover/restricted-swift.py` for this evaluation. It clears inherited credentials, disables Keychain/netrc/Git credential lookup, preserves resolved dependency versions and denies network access. The outer macOS sandbox blocks home-directory reads outside evaluation scratch and limits writes to scratch, named compiler temporary files and Apple's Metal module cache. Probes verified permitted scratch reads/writes, denied reads of a benign repository file outside scratch, and failed network access. This is a limited process sandbox, not a virtual machine or a complete security audit.

SwiftPM's inner sandbox is disabled only because it cannot nest inside the enforced outer sandbox. Do not reuse that flag without the outer restriction. macOS compiler temporary directories and Metal's system module cache need the explicit exceptions recorded in the launcher; the ordinary user credential directories remain inaccessible. The successful build log is `native-build-restricted.log`, and the startup check is `native-cli-help.log`, alongside the launcher.

GPU inference now also runs under this restriction. Kernel denials identified the two required GPU user clients (`IOSurfaceRootUserClient`, `AGXDeviceUserClient`), Apple's Metal compiler caches and scoped cache/artifact extensions. The Python runtime uses corresponding caches under `org.python.python`. Benchmark atomic report writes need its named temporary directory. These specific exceptions are recorded in the launcher; it still blocks network, Keychain and home reads outside evaluation scratch. Core Audio service lookup is also denied. File/network denial probes were repeated successfully. The evaluation launcher bounds inference time and terminates its process group on timeout.

The later Swift benchmark adds only an optional base prompt and a live-memory measurement before offline rendering. It leaves the model/runtime source and dependency lock unchanged. The instrumented binary SHA-256 is `75945542625bdedfa77977451d56a0ed0eb10870d3dd9832ad303f0303de3a51`; the original binary is retained separately in scratch.

## Measured capability gate

[Machine-readable results](native-voice-benchmark.json) retain model-file hashes, fixture hashes, configuration, generated text and measurements. These are small, synthetic acceptance probes, not a statistical accuracy benchmark. No real task was executed.

| Probe                                                                                   | Nemotron INT5 result                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “Hello. How are you today?”                                                             | Correct caption and a spoken conversational response; no tool call. A later one-step run reached first sustained audio about 856 ms after input ended.                    |
| “Delegate this task to my coding agent: fix the login bug.”                             | Correct `delegate_task` request with validated arguments; literal queued result injected and acknowledged. First sustained response audio about 3.74 seconds after input. |
| Known upstream-style reminders question                                                 | Correct `list_reminders` call and reply grounded in the fake umbrella reminder.                                                                                           |
| Ask the coding agent to explain a login bug; create a file; research and save a summary | All three miss delegation. Repeating all three with a stronger Dot prompt also misses delegation. A verbal promise to ask the agent is not an accepted task.              |
| Same “I am fine” words at two speaking rates                                            | Slower clip gets a reply; faster 0.66-second clip gets a caption but no reply within the probe. This does not demonstrate emotion understanding.                          |
| Silence and low-level noise                                                             | No caption, tool call or speech. The upstream reply-oriented harness labels this a timeout; abstention is the desired behavior for these fixtures.                        |
| 61.76-second input, mostly trailing silence                                             | Foreground RTF 0.968, frame p95 125.5 ms, maximum backlog about 3.39 seconds; live physical-footprint peak 16.165 GB. Not a long active-conversation acceptance pass.     |

Nemotron frame deadlines were inconsistent. Selected short runs had p95 approximately 84–148 ms against an 80 ms frame interval; later Dot-prompt samples were slower under varying concurrent app load. The latter are not a controlled prompt-performance comparison. One baseline research sample was disturbed by a `vmmap` diagnostic and must not be used as a clean latency sample. The sustained input contains 60 seconds of trailing silence, so its negative response times relative to _file end_ must not be quoted as response latency. Startup measurements include warm OS caches and do not establish cold-start p50/p95.

LFM's ordinary audio conversation produced a 4.96-second response in 2.57 seconds, including a probe decode of the first ten audio frames. First text arrived after approximately 58 ms; the first decoded chunk after 1.26 seconds. Peak MLX allocation was 2.163 GB and peak RSS 1.708 GB; neither is a measurement of total macOS physical footprint. The output WAV is finite and non-silent, but human listening acceptance remains unrun.

LFM's direct audio routing probe requested a strict JSON decision plus caption. Ordinary work requests instead produced conversational answers, and an explicit delegation request omitted the required caption field. A second probe used the [documented LFM tool format](https://docs.liquid.ai/lfm/key-concepts/tool-use): it produced prose, partial arguments or a bare function name, with no validated complete tool call. The documentation's worked model is the text Instruct checkpoint; it does not establish equivalent tool behavior in this audio checkpoint. A fake result was therefore not injected through an invalid call.

**Owner-approved direction (October 21):** use LFM for native audio conversation plus a separate small local task router. Neither standalone audio model passed the handoff gate. The combined path must retain original-audio conversation and prove routing, result grounding and history before High is enabled. Router evaluation uses `mlx-community/LFM2.5-1.2B-Instruct-4bit` at `dee2f8a2786e6648bb644a7ca40652842490034b`, with the already reviewed runtime, local safetensors/JSON only and strict output validation. No new package or real provider call is needed for this probe.

### Composed adapter checkpoint

The LFM **text** router also failed: three prompt variants misclassified ordinary requests or returned prose. The selected router candidate is now [Qwen/Qwen3-1.7B-MLX-4bit](https://huggingface.co/Qwen/Qwen3-1.7B-MLX-4bit), pinned to `21457c6f51ed54a7c16e988c0844db973815c137`. Its Qwen implementation was already present in the reviewed `mlx-audio` wheel. Four verified JSON/safetensors files add approximately 926 MB; no additional package was installed, no downloaded code/template was executed, and inference retained the same network/credential/audio-device restrictions. The audio plus router data totals **2,333,302,619 bytes**. The model manifest is [native-models.json](../../scripts/local-voice/native-models.json).

The actual TypeScript adapter and Python worker now pass these restricted synthetic tests:

- Original audio → LFM caption → Qwen routing accepts all four ordinary/explicit work fixtures. Warm caption-plus-route latency was roughly 0.35–0.37 s in the first adapter run. Host code creates the narrow `delegate_task` request from the unchanged caption; the model supplies no identity, permission or command fields.
- Casual audio receives native text/audio; a later run produced 4.8 s of speech in 1.46 s. Output is a complete bounded span, not a claimed streaming/full-duplex path.
- Job state in an LFM system prompt was ignored. Authoritative queued/completed/declined text instead uses LFM's local TTS mode. Generated speech transcribed back with the correct status and diagnostic label; this is a model round-trip check, not a human listening assessment.
- Prior separate turns were not recalled, even when retaining generated audio codes. Supplying the bounded authorized history as context in the **same user turn as the current original audio** passed the follow-up label test. The real adapter assertion failed before this change and passed afterward. This does not establish general memory or personality fidelity.
- Silence bypasses decoding. Raw noise can produce hallucinated captions; the existing call VAD must gate input. Qwen's negative and quoted-task controls did not delegate but sometimes asked for clarification unnecessarily. Wider routing, noisy speech, language and long-call acceptance remain pending.

Implementation lives in `native-contract.ts`, `native-worker.ts`, `scripts/local-voice/native_worker.py` and `native_launcher.py`. Fifteen subprocess contract tests and eleven standard-library Python tests cover protocol/input limits, strict output, credential isolation, startup failure, cancellation/deadlines, process reaping, asset tampering, cache symlinks and launching from a denied application directory. The actual adapter passes the same probes through the production sandbox launcher. An independent review found no important issues.

High call orchestration and SQLite-backed delegation are connected in source. Casual turns use original audio and canonical text persistence; delegated work uses a linked same-Dot conversation and existing approvals, with fenced leases, restart reconciliation and persisted parent receipts. High readiness requires its explicitly installed runtime/models, VAD and SQLite storage. After the owner requested setup, the built-in backup/upgrade flow activated a separate SQLite workspace and High was saved for the existing Dot. The original workspace and backup remain available.

## LFM dependency review and isolated installation

The alternative was reviewed before installation. `mlx-audio==0.6.1` matches source commit `4510ba631faf5676b2bf4633161756664d154e28`; its wheel's 866 Python files match that source. Its shipped lock contains advisory-affected versions of [AnyIO](https://github.com/agronholm/anyio/security/advisories/GHSA-82r6-8w77-94w6), [fsspec](https://github.com/fsspec/filesystem_spec/security/advisories/GHSA-27vj-qcqg-25rc), and [Pygments](https://github.com/advisories/GHSA-5239-wwwm-4pmq). The evaluation pins instead use AnyIO 4.14.2, fsspec 2026.6.0 and Pygments 2.20.0.

The resolved environment contains 36 pinned wheels for the already installed Python 3.14.3/macOS arm64. Archive hashes and 7,655 internal RECORD hashes were checked; no `.pth`, installed-script payloads, traversal paths or archive symlinks were found. Exact selected versions had no listed PyPI/OSV findings in the queries. The 144 native payloads in 13 packages are identified but not audited or reproducibly rebuilt; source matching and advisory checks do not establish safety.

Installation used the existing trusted `uv` tool, copied and checksum-verified inside scratch, under the same OS restrictions. It used only the reviewed local wheelhouse, `--offline --no-index --no-deps --require-hashes --only-binary :all:`, with credential lookup disabled. No package build backend, general model-server CLI, global installation or Dot production dependency was introduced. The interpreter/environment and all model data stay outside authoritative workspace storage and backups.

The runtime's default tokenizer enables remote code, so the probe explicitly injects a local tokenizer with `trust_remote_code=False` and `local_files_only=True`. Source review also found incomplete assistant-audio history forwarding and questionable concatenation of multiple input utterances in the port's helper; the measured probes use one input utterance each. Multi-turn history needs separate validation. The review, exact wheel manifest/lock, model manifest, scripts and logs remain under `.superpowers/sdd/voice-quality-handover/`.

MiniCPM-o 4.5 remains a source-reviewed fallback, not an installed runtime. Its [upstream discussion](https://github.com/OpenBMB/MiniCPM-V/issues/1110) describes application-managed JSON/tool orchestration rather than a native realtime tool protocol. It does not remove the required handoff experiment, so no additional MiniCPM package or weights were installed.

## Integrated High checkpoint

The production call service checks actual nested model paths, then loads only native audio/router and Silero VAD for High. A real synthetic High call passed through VAD, local native inference, trusted canonical persistence and PCM acknowledgement. Startup took 3.845 seconds; first generated PCM arrived 2.132 seconds after supplied input, with 5.6 seconds of output. No microphone or physical playback was used.

A separate actual `NativeVoiceRuntime` and SQLite run completed 25 turns in 75.12 seconds of processing, generating 213.2 seconds of audio. Median turn time was 3.021 seconds, p95 3.282 seconds and maximum 3.305 seconds; startup with warm filesystem caches took 3.837 seconds. Python RSS started at 2.255 GiB and ended at 2.566 GiB, peaking at 2.567 GiB. This measures RSS, not total physical footprint or unified GPU memory. The local model used bounded history and made zero task-provider calls. The test is a short sustained run, not hours of live conversation or acoustic latency acceptance.

Task integration review found and corrected nested-asset readiness, missing delegated parent context, generic-only completion receipts and expired lease settlement. Context projection is bounded, masked and guarded; unknown/revoked provenance is withheld. The actual installed Integrator fixture verifies prior discussion reaches the task and its result reaches parent history. A separate initial test mistakenly selected Codex, whose transport ignores `AGENT_COMMAND_JSON`; it timed out and was stopped. That attempt may have invoked the live CLI. The corrected test selects the fixture-compatible provider and blocks the real Codex executable explicitly. It is excluded from all no-provider measurement claims.

## Installer acceptance

The explicit installer completed a fresh offline installation in worktree scratch using the 36 reviewed wheel archives and pinned model files. It made no downloads or owner-configuration changes. Verification passed both before and after a real synthetic High call through the fresh environment. That call took 24.65 seconds to start, then generated its first PCM 2.09 seconds after supplied input and produced 5.28 seconds of speech. The task-provider entry point was prohibited. This first-use startup is materially slower than the earlier warm-environment measurements; it is not a controlled cold-system benchmark.

Actual installation exposed two issues that fixtures initially missed: `uv 0.11.6` rejects combining `--only-binary :all:` with `--no-build`, and its interpreter path resolution needs metadata access to parent directories. The installer now uses the wheel-only flag, which prohibits source builds, and permits metadata while retaining denied external file contents. Both fixes have real CLI/sandbox regressions. Eighteen standard-library setup tests pass. `--verify-only --offline` checks saved installed-file hashes without importing model packages.

## Remaining acceptance

Human listening and live microphone checks remain for speech quality, interruption, echo, noisy rooms, emotional delivery and task-routing mistakes. Only English is supported. Also measure cold startup, extended call memory growth and interaction with ordinary desktop load, low memory and storage maintenance. Existing synthetic measurements do not establish these results.

Keep model assets outside authoritative workspace storage and backups. Future runtime changes retain dependency review, exact pins, restricted execution and the governed Dot/Integrator task boundary.

Owner setup on October 21 reused the verified files offline in the default native runtime directory. Installed-file verification and production sandbox warmup passed. The normal desktop build was relaunched, the UI saved High, and the running API reports High ready. No microphone or live task was started during setup.
