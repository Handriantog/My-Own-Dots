# Local voice calls

Talk uses local Whisper recognition, Silero speech detection and Kokoro speech generation around the existing Dot chat. The selected AI subscription still does the reasoning. Voice messages use the same conversation, memory, tools and approval cards as typed messages. With the persistent-provider option, complete validated sentences are saved and spoken while the response is still arriving. The call shows **Working on it** until the first approved sentence is available.

## Start a call

1. Start PostgreSQL and the workspace: `npm run conversations:up`, `npm run build`, then `npm start`.
2. Use a desktop build that includes local voice. Click Dot → **Talk**. It opens the call and connects automatically to your selected conversation (or creates one if needed). No preliminary Chat visit or second Start call click is required. Sign in with the owner token if your workspace requires one, then choose Talk again.
3. The call shows **Connecting** while checking setup and warming local speech. You can also start a call with the phone button in the chat header.
4. Allow microphone access when macOS asks. Speak, then pause for about 700 ms. Your final transcript appears in the ordinary conversation; the answer appears there and is read using the current English voice.
5. Speak again to interrupt. **Interrupt** also stops the current voice response. **Mute** releases the microphone; **Speaker** stops playback. **End** releases the call. Minimize the call view to continue viewing chat. Actions needing approval appear in the existing chat cards.

Closing or hiding chat, minimizing its native window, hiding the app, locking/sleeping, navigating away, losing the microphone, or losing the call connection ends capture. It never resumes automatically. The desktop's sound effects are reduced during the call; movement and physics are unchanged. A pending text draft stays intact.

## Voice and personality

Open **Chat → Voice & personality**, choose a voice and personality, then **Save**. There are 28 installed English voices: 20 American and 8 British, with female and male options. No extra model download is needed. **Preview** speaks a fixed example using the draft selection without saving, opening the microphone, or contacting an AI provider.

Natural, Cheerful, Calm, and Serious affect response wording and local speech speed and pauses. They do not replace the reasoning model or bypass approvals. These are pacing and wording presets, not an emotion-trained voice model. Settings persist separately for each Dot. Personality applies to future replies, including typed chat; voice applies to the next call. End an active call before changing its settings. Starting a call stops any preview.

## Configuration

### Persistent provider and incremental speech

Set `LOCAL_VOICE_PROVIDER_SESSION=1` and restart the workspace. This is enabled and the workspace has been restarted in the owner’s current installation. This voice-only Codex option takes precedence over the older warm-Python option below. It uses the installed [Integrator 0.2.0 package](https://www.npmjs.com/package/myown-llm-integrator/v/0.2.0), preserving typed chat, model selection, context, tools and approval cards. No paid speech API or model download is introduced. The exact reviewed Codex version is 0.157.1; incompatible versions or configuration fail with a setup error rather than relaxing restrictions.

One provider process stays alive for a call. Every decision gets a fresh ephemeral thread containing the complete current application context once; the thread unloads after completion. This avoids accumulating duplicate conversation snapshots. The model and its catalog default reasoning effort match the previous Dot inference path, rather than inheriting coding-session overrides. Validated text records are bound to the chat framework's assistant ID, durably appended by the conversation runner, then queued for local speech. Tool decisions stay buffered until the whole decision succeeds and are executed by Dot under its existing permissions. Text and tools cannot mix in one decision. Failure stops queued speech and retains already saved partial text; cancellation discards provider state. A final snapshot never replays streamed text.

`/api/local-voice/status` reports `inferenceRuntime: "persistent-provider"`. Timing logs add `reusedProvider`, `firstTextMs`, and `delivery` (`incremental` or `buffered`). Reuse means the local provider process; it does not prove a remote network connection stayed open. First-text timing includes provider preparation and model thinking. Models that do not positively identify final-answer deltas use completion-gated delivery. Owner calls and four authorized text-only comparisons have now shown incremental final-answer delivery with the current model. No end-to-end voice latency target has been established.

To compare with the previous call path, end the call, set `LOCAL_VOICE_PROVIDER_SESSION=0`, leave `LOCAL_VOICE_INTEGRATOR_SESSION=1`, and restart. The main remaining delay can still be the model's initial reasoning, local recognition and speech generation. This provides incremental local speech around subscription text reasoning, not a native speech-to-speech model or offline reasoning.

### Integrator session evaluation

This checkout pins [Integrator 0.2.0](https://www.npmjs.com/package/myown-llm-integrator/v/0.2.0), which contains the optional session API. Set `LOCAL_VOICE_INTEGRATOR_SESSION=1` in `.env` and restart the workspace to use it in Talk. This setting is enabled in the owner's current local installation. One Python runtime warms alongside the speech models and is reused for that call's replies and tool steps, then closed on hangup, startup failure or shutdown. Typed chat and background work continue to use the existing `runAgent` API. Failed requests are not silently retried.

The readiness endpoint `/api/local-voice/status` reports `inferenceRuntime: "warm-session"` when selected. Each completed inference writes a `[voice-inference]` timing record to the workspace log, containing startup, engine and total durations plus `reusedRuntime`; it contains no prompt, transcript, answer or tool input. A warmed request should report `startupMs: 0` and `reusedRuntime: true`. Cancellation can discard the runtime; a later explicit turn then starts a fresh one.

To compare, end the call, set the flag to `0`, restart the workspace, and repeat the same questions with the same Dot/model. This optimization removes Python startup/import overhead only. The provider CLI and complete structured-answer validation still run each turn, so it does not provide token streaming or promise a multi-second speedup. First-call speech model warmup remains part of Connecting.

### Speech setup

Set `LOCAL_VOICE_ENABLED=1` in `.env` and restart the workspace. Local conversations and the subscription backend must already work. The paid Realtime configuration is separate and is never used as a fallback for local speech.

The current evaluation installation is macOS Apple Silicon, Python 3.12, and these default paths:

```text
~/Library/Application Support/My Own Dots/local-voice/venv/bin/python
~/Library/Application Support/My Own Dots/local-voice/assets/
```

Override them with `LOCAL_VOICE_PYTHON` and `LOCAL_VOICE_ASSETS` if needed. Install only the pinned runtime and model files described in [the worker setup guide](../../scripts/local-voice/README.md), with the owner's download consent. Opening Chat or Talk never installs anything. All model hashes and package versions are verified during startup. Readiness checks the configured local files; the first call also imports and warms the models before acquiring the microphone.

The four required assets are `ggml-base.bin`, `kokoro-v1.0.onnx`, `voices-v1.0.bin`, and `silero_vad.onnx`. Silero adds 2,327,524 bytes and uses the already installed ONNX runtime. Its approved download and checksum verification are recorded in the manifest. The installed multilingual Whisper model is explicitly set to English for live calls; the Dot also receives a server-bound English-only voice instruction. Live calls currently support English only. Typed chat language behavior is unchanged. Spoken output defaults to Kokoro's English Heart voice; each Dot can select another installed English voice.

English recognition supplies only a fixed decoder hint identifying the assistant as Dot. Automatic conversation-prose hints were removed from live calls after the installed model repeatedly produced invalid timestamps with them. The normal Dot agent still receives the full canonical conversation and memory, and its voice instructions use topic and corrections to interpret clear low-risk intent while asking for clarification on consequential ambiguity. Recognition does not rewrite words or infer consent. The worker disables implicit decoder history and explicitly resets its prompt on each utterance. The optional bounded context field remains available in the file-worker protocol for diagnostic comparison; live calls send an empty context. An earlier fixed-Dot-hint generated-audio comparison improved exact word matches from 16/18 to 18/18 across three voices; synthetic results do not measure accuracy on the owner's speech or accent.

If setup is unavailable, Talk shows the reason without opening the microphone. A disabled phone button's tooltip also explains setup status. If microphone access was denied, enable **My Own Dots** under macOS System Settings → Privacy & Security → Microphone, then start a fresh call. The app does not reset OS permissions.

## Boundaries and limits

The speech service is a loopback-only transport behind the workspace's owner and origin checks. A short-lived random call token, sent in a header, binds controls to the selected thread and Dot. The browser submits each final transcript with its server-issued message ID through the existing chat agent. The service accepts only server-bound validated text after durable persistence, or a completed canonical answer on the older path; tool arguments, approval payloads, code blocks and structured envelopes are not spoken. A call holds foreground memory scheduling through silence and ends after 15 minutes or a lost heartbeat. Input is bounded to 30 seconds per utterance; calls are limited to 100 turns.

Capture uses 16 kHz mono PCM16 frames of 512 samples; the browser audio graph performs rate conversion and verifies its context rate. Recognition, synthesis and VAD run in separate processes. Generation changes discard old output immediately, and cancelling synthesis preserves warm recognition. Output uses bounded 24 kHz PCM frames and at most four pending playback acknowledgements. Long answers retain their complete text in chat, with a bounded spoken excerpt for answers over 6,000 characters.

Short-clip timestamp padding is clamped within a 200 ms tolerance. Invalid English recognition triggers one fresh decode of the same uncommitted audio: live calls retry without the fixed hint; diagnostic requests with optional prose retry with only the fixed hint. Both attempts keep the same timestamp/text validation, and the first rejected text is never forwarded. A second invalid result discards only that utterance and asks the user to repeat. An actual recognizer failure permits one supervised worker replacement per call and retries only uncommitted audio. Repeated engine failures still end the call. A failed readiness poll alone does not end an established call.

Voice answers prefer a short useful opening sentence or phrase (about 120 characters when natural), followed by the full answer without filler or a shorter answer limit. Speech starts with a complete sentence; an opening over 160 characters may split at a natural clause boundary between 60 and 160 characters. Later chunks retain the 350-character bound and at most one synthesis ahead during playback. All text still validates and saves before speech; this does not speak partial provider JSON. The browser checks the canonical answer immediately when the governed agent run completes; 500 ms polling remains for approval continuations. The same reasoning model, tools, validation and selected Kokoro voice remain in use. The older subscription path waits for a complete validated response; the persistent path starts after the first validated, saved record. Initial provider latency can still dominate the wait.

Raw microphone and generated PCM are transient. Canonical messages and call receipts persist. Delivery records distinguish generated, queued and browser-reported software-played samples; these are not proof that sound was physically audible. Interrupting does not erase generated chat messages or undo completed tools. The native renderer receives only a narrow voice lifecycle bridge, with audio-only permission limited to its trusted active main frame.

## Verification scope

Automated checks cover per-Dot persistence, all 28 allowlisted voices, four personality profiles, preview cancellation, call settings, and fake capture/playback with fixture recognition and conversation results. Network-denied file synthesis verified George/Calm, Michael/Cheerful, and legacy Heart with finite, nonzero, distinct PCM; no speaker playback was performed. The installed Silero worker passed a network-denied generated-PCM/reset smoke. Earlier real Whisper/Kokoro file checks remain documented in [the prototype report](local-voice-prototype.md).

Automated call checks use generated/file audio and fixture replies, without microphone capture, speaker listening or subscription inference. The separately authorized four-request text comparison below uses the existing subscription. The owner has tested calls and reported the issues addressed here; agent-run hardware/listening checks still need separate consent. Echo behavior, physical interruption latency, sustained resource use and real English speech quality remain to be assessed. Installed-package fixture tests verify incremental delivery before provider completion through the real LocalVoiceService, DotAgent and LocalAgentRunner, process/thread reuse, saved-before-audio ordering and process cleanup. They do not establish live model compliance or a measured conversational latency target.

## October 18 latency regression investigation

Owner-call first-text timings after the initial persistent update were 9.254, 5.527 and 8.809 seconds, despite zero runtime startup and successful provider reuse. Streaming saved only about 0.3–0.4 seconds on these short responses. Two regressions were found: inherited `xhigh` coding-session reasoning instead of the model’s normal `medium` effort, and repeated full snapshots accumulating inside the persistent thread. Recorded input usage grew from 8,180 to 12,499 to 16,779 tokens over three turns.

The v2 candidate restores catalog defaults and keeps only the provider process persistent. Four owner-authorized fixed-question comparisons on the same gpt-6-astra model measured first text at 9.216/9.907 seconds with xhigh and 5.050/5.480 seconds with medium. The greeting pair had no cached input in either run; the second medium run had cached input, so this is a small diagnostic sample, not a guaranteed speedup or answer-quality evaluation. These times precede local speech synthesis and playback. Fresh thread creation and unloading took about 66–77 ms in three no-inference checks.

No microphone, speaker playback, separate API or additional model download was used. The ordinary text API is unchanged. The exact four-request results are in the sibling Integrator's local `artifacts/voice-effort-comparison.json`.

## Per-turn latency trace

Set `LOCAL_VOICE_TIMING_LOG=1` in `.env`, restart the workspace, and start a fresh Talk call. Each utterance gets a server-generated message ID shared by recognition, the governed agent run and playback. Server stdout contains one JSON record per `[voice-timing]` line. The owner's workspace writes stdout to `artifacts/voice-session-workspace.log`; with a different launch command, redirect stdout to a local file and pass that path below.

```sh
npm run voice:timings
npm run voice:timings -- --last 3
npm run voice:timings -- --file /path/to/server.log --last 5
```

The report shows elapsed milestones and the wait to the first software playback acknowledgement, with recognition, client submission, conversation storage, context preparation, scheduler queue, provider, text persistence, first speech generation and audio dispatch intervals. Each provider step also includes the installed Integrator's startup/first-text/total timings, reuse flag, delivery mode and available token counts in the JSON. Failures, recognition recovery, interruptions and approval waits leave partial traces instead of fabricated successful latencies. Provider completion can occur after speech starts, so it is not added to the first-playback total. Multiple tool steps have separate step numbers; the summary's provider-to-first-text interval includes intervening tool rounds and later context/queue work. The first context and first scheduler intervals describe only the first step.

The origin is when the server last classified a frame as voiced, not the physical end of microphone speech. Audio capture/upload delays before that point are not measured. The last milestone is receipt of a browser playback acknowledgement, including transport, scheduling and the first small audio frame; it is not a physical-device audible-onset measurement. Provider-to-first-text includes Integrator preparation, its internal lock, remote provider/model work and validated record delivery. Integrator 0.2.0 splits the local portions and first-delta/first-record milestones as described below; remote queueing versus model compute remains opaque. Ordinary text generation and model/voice settings are unchanged.

The new trace is opt-in, has at most 256 rows per turn and records only IDs, dates, fixed phase labels, durations and allowlisted numeric/boolean provider metadata. It does not log audio, transcripts, prompts, answer text, tool arguments, credentials or raw errors. This does not alter existing transcript storage or unrelated server logs. Disable with `LOCAL_VOICE_TIMING_LOG=0` and restart. No new database or client telemetry endpoint is added. The report retains recent turns by their `speech_end_detected` start record; give it a complete log file, since a truncated prefix without that record is ignored.

Verification uses a monotonic simulated timeline with hand-calculated intervals, two turns through the installed provider package with fixture inference and synthetic audio, failure/recovery/cancellation checks, and a report-reader fixture. These checks use no real-provider requests, microphone or speaker playback. A new owner call is needed to collect the complete real-world breakdown; older `[voice-inference]` logs cannot reconstruct the missing phases.

### Internal provider phases (Integrator 0.2.0)

Each successful `provider_result` row now includes `timings.phases`, and `npm run voice:timings` prints it per provider step. `lockWaitMs` measures the Integrator's shared cross-process lock, separately from Dots' scheduler. `preparationMs` covers account/config checks and fresh thread creation. `turnStartAckMs`, `firstDeltaMs`, `firstValidatedTextMs` and `turnCompletedMs` are milestones from turn/start dispatch. The difference between first delta and first validated text reveals the wait for a complete acceptable text record. `textCallbackMs` measures accumulated acknowledgement/backpressure; `cleanupMs` measures thread unload; `totalMs` covers the Python decision. Null text milestones mean absent, not zero.

The fields `accountReadMs`, `requirementsReadMs`, `configReadMs`, `threadConfigReadMs` and `threadCreateMs` divide readiness checks and fresh thread setup. All five are already inside `preparationMs`, including local response validation. Existing calls and restrictions are unchanged.

Milestones overlap; do not add them. These are locally observed events, not remote server timestamps. Callback backpressure can defer reading later events. Raw provider text is never logged or spoken by this measurement. Unknown-phase replies remain buffered and tool-only replies have no validated text milestone. Failed/cancelled requests retain the outer partial trace but do not return a final internal phase object. See the [Integrator contract](https://github.com/Handriantog/My-Own-LLM-Integrator/blob/feat/voice-latency-api/docs/provider-sessions.md#internal-phase-timings). Existing logs from v2 naturally lack the additional fields.

### Speech recovery after interruption

Interrupting active speech still cancels queued audio and closes its synthesis worker. The replacement now starts warming immediately after that worker closes, concurrently with agent cleanup, recognition and inference. It does not wait for the next answer. One call-scoped warmup is shared across further reply interruptions and speaker mute; a reply waits only for any remaining warmup time before synthesizing. Model, voice, personality, text validation and generation checks are unchanged.

Hangup aborts warmup and closes the owned replacement, including during races with old-worker shutdown. A warmup failure is handled immediately, closes the call with a recoverable message, and does not loop through model reloads. No microphone or speaker is activated by warming the synthesis model.

The interrupted turn records `synthesis_restarting`, followed by `synthesis_ready` or `synthesis_recovery_failed`. A later turn records `synthesis_wait_started`/`synthesis_wait_finished` only if it actually waits for recovery; its `recoveryWaitMs` is a subset of saved-text-to-synthesis time, not additional latency to sum. A ready replacement therefore adds no recovery-wait interval. Fixture tests verify readiness before the next answer, continued transcription while warming, waiting when needed, repeated interruption/mute, shutdown during closing/warming and failure cleanup. The earlier owner call had a 0.84-second late reload. The subsequent 22:38–22:42 owner call showed three replacements ready in 0.897–0.961 seconds before the next output, with no remaining speech-recovery wait. Its nine played replies still averaged 7.40 seconds; provider-to-usable-text averaged 5.40 seconds. Different utterances and interruptions prevent a controlled overall speedup claim.

### Provider recovery after interruption

Cancelling an active provider decision still terminates and reaps its process group, including a blocked text callback. Dots now immediately calls the installed session's existing `warm()` while the owner is speaking or being transcribed. This performs local provider readiness work, not another inference request. The next reply shares that warmup and reuses the ready replacement; another interrupted waiter does not cancel or duplicate it. Hangup aborts warmup and closes the session. Ordinary provider failures are not automatically retried. A failed replacement warmup is reported to the next explicit request and then cleared so a later explicit request can recover; cancelling only a waiter retains the shared warmup.

Content-free `[voice-inference-recovery]` entries contain only call ID, outcome and warmup duration. A replacement changes local process identity; no persistent remote connection is promised. Fixture tests show zero startup on the next request after recovery and no extra turn/start during warmup. The owner's preceding call paid 0.82–1.12 seconds for late provider restarts; actual savings from overlapping them require another call.

### Recognition reliability checks

The previous 600-character prose-hint policy was tested against the pinned local model using 36 generated English clips: nine phrases, two installed voices, and normal/quiet levels. First-attempt timestamp validation accepted 0/36 with the long synthetic hint, 32/36 with a shorter 120-character hint, and 35/36 with the fixed Dot-name hint. This is evidence against feeding conversation prose to this installed decoder, not a general statement about all Whisper models.

The updated production path accepted all 36 clips; one needed the unprompted retry. Exactly 33/36 matched the expected words: the remaining errors were “No” becoming “Now” and “Sapa” becoming “Sampa.” Silence at 800 ms and 3 seconds, plus a 3-second white-noise control, produced no accepted transcript. These are small synthetic checks, not owner-accent accuracy or long-call stability measurements. No microphone, speaker playback, model download or live subscription was used; OS networking was denied. Reproduction scripts and JSON results are under `artifacts/local-voice/recognition-{context-matrix,unprompted-matrix,reliability-check}.*`.

With timing enabled, `recognition_result` rows distinguish decoded text, empty output, validation rejection, superseded input, engine failure, and a failure elsewhere in transcript processing. Interrupted recovery is counted as superseded, and storage failures after a successful decode are counted as `pipeline_failed`. Numeric fields contain only input duration and optional-hint length. Allowlisted reasons identify invalid timestamps, invalid segment text, segment limits, text limits or an unknown legacy cause; `fallbackReason` records why the one retry happened. Neither audio nor recognized words enter these diagnostics. `npm run voice:timings` displays the outcome/retry beside the turn timeline. Older logs cannot retroactively identify why an input was discarded.

Fixture tests cover the one-retry limit, unchanged words and validation, prompt reset, native failures, protocol compatibility, diagnostic filtering, cancellation, phrase boundaries and durable text before playback. The full conversation remains with the governed agent; ordinary typed chat and subscription inference are unchanged. A workspace restart loads the updated TypeScript diagnostics and live hint policy. After that, start a fresh Talk call; the native companion does not need rebuilding.
