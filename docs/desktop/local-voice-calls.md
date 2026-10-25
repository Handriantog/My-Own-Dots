# Local voice calls

Talk supports per-Dot **Basic**, **Medium** and **High** quality. Basic and Medium use local Whisper recognition and Silero speech detection around the existing Dot chat; the selected AI subscription still does the reasoning. Basic replies only in text. Medium also uses Kokoro speech generation. Voice messages use the same conversation, memory, tools and approval cards as typed messages. With the persistent-provider option, complete validated sentences are saved as the response arrives and Medium speaks those saved sentences.

## Choose voice quality

Starting Talk without opening chat shows a **Connecting…** bubble while Dot gently
adjusts its headphones. Reduced motion keeps the gesture steady. The cue changes
to the existing listening state when ready and clears if startup ends or fails.

During a local Basic, Medium or High call, say **“Dot, end the call”** or **“Hang
up”** to disconnect. The host handles the complete recognized request before chat
or task routing, stops microphone/playback and saves the call transcript. Existing
independent High tasks continue. Negated, quoted or instructional phrases such as
“Don't end the call” and “How do I end the call?” remain conversation. Bare “stop”
is not a hangup command. Recognition accuracy still depends on the captured speech.

Open an existing Dot's settings, or **Chat → Voice & personality**, choose **Voice chat quality**, and save. The selector works before speech setup. Create a new Dot before selecting its voice preference. End its active call before changing settings.

| Quality | Behavior                                                                                                                | Local prerequisites                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Basic   | Speak to Dot; read its answer in chat. No voice preview, synthesis worker, generated audio, or speaker control.         | Pinned recognition/VAD runtime and Whisper/Silero assets; existing text inference                |
| Medium  | Existing voice conversation with generated speech and captions. Default for older saved preferences.                    | Basic prerequisites plus Kokoro and its voices                                                   |
| High    | Codex replies and tasks with local LFM recognition and selectable Qwen3-TTS speech. Legacy retains the Qwen/LFM hybrid. | Apple Silicon macOS, SQLite workspace, Silero VAD and the separate pinned native runtime/models. |

Choosing High does not download models or start another mode. If its prerequisites are missing, it displays the setup reason. Basic and High never fall back to hosted voice. The legacy paid Realtime path remains eligible only for Medium when configured and local voice is disabled.

Readiness is checked per Dot. If settings change in another window just before startup, the call is rejected before workers start; retry with the refreshed preference. A running call keeps the quality it started with. Voice settings are included in the existing workspace backup; model/runtime paths remain host setup and readiness is checked again after reopening the restored workspace.

## High setup and task behavior

With `DOTS_AGENT_ENGINE=codex`, High uses LFM recognition and the existing Codex
agent for replies and tasks, with Qwen3-TTS for speech. Install the separate
[Qwen speech model](../../scripts/local-voice/README.md#explicit-native-high-setup)
as well as the native and VAD runtimes. `LOCAL_VOICE_TTS_ROOT` overrides its
default location. The 8-bit model adds about 3.08 GB of data; it reuses the
reviewed native Python environment. It does not replace the chat/task model.

Choose **High → Voice → Preview**, then **Save**. Vivian is the default; nine
voices are available. Each Dot keeps separate High and Medium selections.
Personality adjusts delivery through fixed instructions; it does not infer your
vocal tone. The next call uses the saved voice for replies and task announcements.
Preview uses the unsaved selection and opens only the speech worker. Missing or
corrupt assets fail explicitly; there is no Samantha fallback. See the
[evaluation record](qwen3-voice-evaluation.md) for measurements and listening limits.

Codex keeps approval waits separate from execution. Leaving a dialog undecided
pauses only that task; you can keep talking or ask for something else. Approving
while another task runs queues the continuation. The agent mentions an existing
approval when your request needs it. Before substantial work or an approved
continuation, it gives a brief, specific next step in its own words. High speaks
that saved message and then the result, without adding a canned acknowledgment
to casual replies. Muting queues updates; interruption suppresses stale speech.

The following hybrid description applies to the **legacy engine**:

Follow the explicit [native setup command](../../scripts/local-voice/README.md) after reviewing the [dependency evaluation](native-voice-evaluation.md). The pinned runtime requires Apple Silicon, macOS 26 or later, and a separate CPython 3.14 environment. It uses LFM2.5 Audio 1.5B and Qwen3-4B-Instruct-2507, both quantized to 4 bits; model data totals 3.682 GB. Keep the existing VAD runtime/assets installed. High does not load Whisper or Kokoro and does not use call-scoped provider-session flags. Set `LOCAL_VOICE_ENABLED=1` in the selected workspace and restart the app after setup. `LOCAL_VOICE_NATIVE_ROOT` and `LOCAL_VOICE_NATIVE_PYTHON` override the default native runtime location. Upgrades from Qwen 1.7B need a fresh runtime directory; retain the previous installation and point these settings at the verified replacement. The native process is offline and sandboxed; task inference remains the normal Integrator subscription path.

Qwen receives the recognized caption, bounded canonical history, Dot instructions and authorized preferences. It handles casual conversation and contextual clarification locally. LFM receives the current original audio while generating speech constrained to Qwen's wording. This owner-approved hybrid fixes ordinary small-talk refusals, but vocal emotion and background sounds do not guide what Qwen says. High currently supports English and its model's voice; Medium voice presets do not change the native voice.

Task announcements use the same speech generator as conversation. Their words come directly from saved task status; they do not switch to the earlier separate male TTS voice.

Routing uses bounded, authorized conversation history and the current task state. File/action requests, permission questions such as “Do you have access now?”, and task follow-ups go to the same Dot agent and tools used by chat. Current local time/date questions use the computer's clock. Task-status questions use saved job state and results; pending folder approvals can reopen the desktop panel. Completed task answers are retained even when tool messages follow the assistant's text, and new results can be spoken in a restarted call on the same Dot and conversation.

An accepted task gets a separate conversation belonging to the same Dot. The parent chat shows a task card with **Open task conversation**, **Review approval** or **Stop task**. The task agent receives bounded permitted context from the parent, and uses the existing folder, page and connection approval cards. Folder requests also open a panel beside the desktop Dot, so the owner can choose and approve the folder without opening the task chat; page and connection approvals stay in chat. Local conversation can continue during that work. In the legacy engine, one task may remain active per Dot, including approval waits. Codex allows multiple pending approvals and one executing task. Results and status return to the parent; short spoken summaries use the actual saved result, while full details remain in the task conversation.

Hangup stops capture and speech; accepted tasks continue. Barge-in stops playback and suppresses stale audio; it does not cancel work. Use **Stop task** to cancel a job. Restart recovery never retries actions or resumes audio automatically. Approval waits need an explicit decision. Restore/move invalidates executable work so an old callback cannot act on the restored workspace. These records now use SQLite schema 7; known schema 2–6 archives remain readable and upgrade on restore/open. Runtime/model files stay outside backups.

While Dot is speaking, automatic interruption waits for 1.5 seconds of sustained detected speech. Brief detections leave the reply playing, and the confirmation audio is retained so the beginning of your interruption reaches recognition. Normal listening keeps its short speech-start threshold; manual interruption stays immediate. This detects speech activity, not speaker identity, so sustained background speech or speaker echo can still trigger it.

High currently generates bounded whole utterances before playback. It is not continuous full-duplex audio. On the M3 Max with 36 GB memory, the updated hybrid passed 20 synthetic conversation/routing checks. Bedtime and follow-up replies took about 2.98 and 3.21 seconds including recognition, routing and whole-response generation; these exclude real-time microphone and acoustic timing. Earlier 1.7B measurements are historical and do not describe the updated runtime's memory use. Live microphone, speaker/echo, noisy room, emotional delivery, other languages and extended call acceptance remain user/device checks. See the [measurement record](native-voice-evaluation.md).

The later context-aware routing repair has fixture/protocol coverage separately from those measurements. Its 53-case installed-model routing corpus could not run on the October 21 development session: macOS cache lookup returned EIO and Metal compiler service lookup failed with error 141. That model-level evaluation remains pending; it must not be counted as a passing routing benchmark.

## Start a call

1. Start the configured workspace: `npm run build`, then `npm start`. A legacy PostgreSQL workspace also needs `npm run conversations:up`; an upgraded SQLite workspace does not need PostgreSQL or Docker for voice.
2. Use a desktop build that includes local voice. Click Dot → **Talk**. It opens the call and connects automatically to your selected conversation (or creates one if needed). No preliminary Chat visit or second Start call click is required. Sign in with the owner token if your workspace requires one, then choose Talk again.
3. The call shows **Connecting** while checking setup and warming local speech. You can also start a call with the phone button in the chat header.
4. Allow microphone access when macOS asks. Speak, then pause for about 700 ms. Your final transcript and the answer appear in the ordinary conversation. Medium reads the answer using the selected English voice; High generates a local native audio reply.
5. Speak again to interrupt. **Interrupt** also stops the current voice response. **Mute** releases the microphone; **Speaker** stops playback. **End** releases the call. Minimize the call view to continue viewing chat. Actions needing approval appear in the existing chat cards.

For windowless talk, press **Command + Shift + Space**. The same shortcut ends the call, even while it is connecting. Change or disable it in **Customize Dot → Windowless talk**. Dot stays in place, with **Listening** and **Thinking** bubbles beside its headphones. Bubbles appear on the right, or the left when the screen edge leaves no room. Speaking gently opens and closes Dot's original textured smile, with a still expression when reduced motion is enabled. The mouth is a stylized speaking cue, not audio-synchronized lip movement. The menu bar reports the phase and offers **End talk**. Open Chat explicitly when you need captions, mute controls or approval cards. An approval raises Dot's hand and adds an **open Chat** reminder in the menu bar. Setup failures are reported outside the hidden window.

Basic reveals the matching chat window, including when started through the shortcut, so its text replies are visible. Its compact call controls keep the conversation readable and offer microphone mute, interruption and hangup. Medium retains windowless speech and speaker controls.

Closing or minimizing visible call controls, hiding Dot, locking/sleeping, navigating away, losing the microphone, or losing the call connection ends capture. Ordinary calls also end when their chat window is hidden. Windowless calls intentionally keep that window hidden and end if the companion renderer fails. Calls never resume automatically. The desktop's sound effects are reduced during a call and roaming resumes when it ends. A pending text draft stays intact. macOS may still show its first-use microphone permission dialog.

## Open websites and references

Say **“Open Wikipedia,” “Show me the reference,”** or **“Open all the references.”** Dot uses the default browser and reports the result. References use the actual source links from the conversation or research results. It asks when the destination is unclear; clear requests need no extra confirmation. Merely mentioning a link does not open it.

This works in Basic, Medium, High, and configured Realtime calls when the desktop app starts the workspace backend. The same tool is available in ordinary desktop chat. High uses its existing task conversation and keeps the result there. Attached external backends and standalone web servers do not receive desktop browser access. Research/search permissions and setup are unchanged.

Only HTTP(S) website links are accepted. Each request handles up to ten links, with repeated links opened once per owner message while the backend remains running. Scheduled tasks and automatic call receipts cannot use the tool. Success means the operating system accepted opening the browser; it does not verify that the page loaded. Missing acknowledgements are reported as uncertain and are never retried automatically.

## Voice and personality

For Medium, open **Chat → Voice & personality**, choose a voice and personality, then **Save**. There are 28 installed English voices: 20 American and 8 British, with female and male options. No extra model download is needed when Medium's assets are installed. **Preview** speaks a fixed example using the draft selection without saving, opening the microphone, or contacting an AI provider. Basic and High disable voice preview and the Kokoro voice picker while retaining the saved voice for a later switch back to Medium.

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

Quality-mode fixtures additionally cover Basic turns through the installed persistent-provider package, zero synthesis/audio, repeated turns, interruption and approval paths, Dot-scoped readiness, desktop text visibility, legacy settings updates and SQLite backup/restore. Basic retains maintenance admission until its final text/call persistence completes. These tests do not establish live microphone quality or lower measured latency.

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

New traces identify the snapshotted quality. Basic reports `text_reply_complete` and a `text_reply` summary instead of playback latency; no first-audio or synthesis measurement is fabricated. Logs without a quality field are treated as legacy Medium.

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
