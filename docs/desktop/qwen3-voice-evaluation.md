# Qwen3-TTS candidate evaluation

25 October 2026. Evaluation in `feat/qwen3-voice`; not activated in the owner's app.

## Review before execution

- Upstream model: Alibaba Qwen team's `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`, Apache-2.0. Candidate is the MLX Community conversion `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` at `41d3337e8b7f2843a75841595fc14e4b9a7a4b96`. Pin selected JSON, tokenizer vocabulary/merges and safetensors by bytes and SHA-256. No model-supplied Python, pickle, build script or chat template is executed.
- Runtime: existing `mlx-audio==0.6.1`, source `4510ba631faf5676b2bf4633161756664d154e28`, maintained by Prince Canuma and contributors. Reuse the previously reviewed 36-wheel CPython 3.14/macOS arm64 environment and its installed-file inventory. No new package or precompiled binary is required. See `native-voice-evaluation.md` for the prior source/wheel review and native-binary limitations.
- Inspected Qwen model loading, speaker validation, token generation, stop condition, PCM decoding, and local tokenizer initialization. The stock loader can download when supplied a repository string; use a verified local Path, offline environment and a network-denied OS sandbox. The stock generation result does not distinguish token-cap exhaustion from normal completion; admission must check this explicitly.
- Public GitHub advisory pages for Qwen3-TTS and MLX Audio were checked. Absence of published findings is not a security certification. Previously reviewed native binaries and transitive dependencies have not been independently rebuilt or fully audited.
- New data is about 3.08 GB. The evaluation uses a private artifact/cache directory, denies unrelated home reads, network, Keychain and direct audio services, and generates files only. No microphone, speaker, provider credentials or owner conversation data is needed.

## Evidence

- Existing native runtime inventory verified offline, including installed-file hashes. OSV exact-version queries for all 36 distributions returned no listed vulnerabilities at evaluation time; this is not a full security audit.
- Initial isolated evaluation: 12 samples passed, covering all nine speakers, previously failing technical text, a failed-task/negation sentence and a bedtime reply. Every sample terminated before the token limit, with finite non-silent 24 kHz mono audio. Synthesis took 1.24–4.18 seconds. Peak MLX allocation was 7.33 GB; this is not total process/system memory or combined call memory.
- Production launcher/TypeScript transport: 11 samples passed across all nine voices plus technical and failed-task text. Cold worker verification/load took 4.09–4.53 seconds; synthesis took 1.08–2.88 seconds for the tested short sentences. These are measurements on this Mac, not guaranteed latency.
- Real cancellation: after aborting Qwen synthesis, the still-warm LFM recognizer transcribed “The test failed. I did not save your changes.” correctly. A replacement speech worker then produced “Ready again.” The processes ran offline without microphone, playback or provider access.
- Explicit offline model setup and verification passed. An actual redirected 245-byte model-config download passed after correcting curl's redirect-body size bound; exact final byte count and SHA-256 verification remain required.
- Browser component check: nine High options; Ryan saved and retained after reload; Medium selection preserved; no browser script errors. Inspected the rendered settings screenshot. HTTP/storage, preview and worker boundary tests exercise persistence, cancellation, separate recognition and canonical words.
- Final core verification passed: formatting, lint, typecheck, 2,503 TypeScript tests, 84 Python tests and the production build. Tests used the dedicated `dots_qwen_test` PostgreSQL database, not owner application data. One certificate-signing compatibility test was skipped because no release-signing identity is configured.
- macOS Ability acceptance, desktop packaging and packaged Ability smoke passed. The final UI corrections were followed by a fresh core run and rebuilt candidate. The bundle uses ad-hoc signing; notarization and certificate-based permission continuity are not verified.
- Final packaged worker qualification passed all 11 samples/all nine voices, speech cancellation with recognition preserved, and a new speech worker after cancellation. Packaged worker/launcher/manifest bytes match the source files. Results: `artifacts/qwen3-voice/packaged/report.json`. The comparison page is `artifacts/qwen3-voice/production/voices.html`; the candidate is `release/My Own Dots-darwin-arm64/My Own Dots.app`.
- Independent review found no Critical or Important issues. Its two small UI/documentation observations had already been identified during final verification and were corrected: legacy High displays “Model voice”, and setup documentation no longer claims absent accent labels. The High-readiness preview cancellation regression was reproduced and fixed before the final core run.

No human listening preference, physical microphone/speaker interaction, or live Codex call is established by these file tests. Vocal-tone/background perception is deferred. The owner's installed application has not been replaced. The candidate uses the existing reviewed runtime and separate TTS data; both are external prerequisites, not bundled model downloads.

## Reproduce file qualification

After explicit setup, from the repository root:

```sh
node --import tsx scripts/evaluate-qwen-voice.mjs \
  --runtime-root "/absolute/path/to/native-voice-qwen4" \
  --tts-root "/absolute/path/to/qwen3-tts" \
  --output "/absolute/path/to/new-results-directory"
```

`--scripts /absolute/path/to/packaged/app/app/scripts/local-voice` runs the same
qualification against a packaged script directory. The output directory must
be new. It contains WAV samples and a JSON report, including failures. No
microphone, playback or provider request is made.

The candidate's High settings require `DOTS_AGENT_ENGINE=codex`,
`LOCAL_VOICE_ENABLED=1`, the native/VAD runtimes, and `LOCAL_VOICE_TTS_ROOT`
pointing to the verified speech installation. The normal default is
`~/Library/Application Support/My Own Dots/qwen3-tts`; the isolated evaluation
uses `artifacts/qwen3-voice/runtime`. Select High, choose a voice, preview and
save. Changes apply to the next call.

## Owner launch preparation

The owner requested app launch and standing automatic launch after future implementations. The verified model was installed offline at the default `~/Library/Application Support/My Own Dots/qwen3-tts` location. The existing selected workspace and its configured `native-voice` runtime were preserved. Packaged LFM/Qwen warmup and generated speech passed using those exact runtime paths (`artifacts/qwen3-voice/owner-launch-speech.log`). Launch was blocked by the computer-access gate: “Computer Use was not approved to use My Own Dots.” App access has been requested; no successful owner-app launch is claimed yet.
