# Voice Quality and Native Audio Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` when continuing this handover. Read the latest checkpoint first; the implementation plan and earlier verification counts below are historical. The owner approved a hybrid High implementation; fully audio-aware answer selection remains a future requirement.

**Goal:** Let users choose Basic, Medium, or High voice chat in Dot settings according to their machine's capability, while keeping conversation history, permissions, and task execution consistent.

**Architecture:** Basic and Medium use local speech recognition and the existing governed Dot agent through LLM Integrator; only Medium generates speech. High now uses local Qwen for conversation and task routing, with LFM for recognition and speech conditioned on the original waveform. Qwen receives text, so vocal emotion/background sounds do not determine the answer's words. Substantive work goes to the existing Dot runtime and subscription inference through LLM Integrator. Dot remains responsible for context, persistence, permissions, approvals, and job lifecycle.

**Tech stack:** Existing Electron, React, TypeScript, Zod, Hono, worker-owned SQLite storage with asynchronous repositories, the retained legacy PostgreSQL adapter, local speech workers, and installed `myown-llm-integrator`. High uses pinned LFM2.5 Audio and Qwen3 models through MLX Audio on Apple Silicon. Runtime database access stays behind the storage migration's repository interfaces.

**Spec:** The [product requirements](#product-requirements) and [implementation decisions](#implementation-decisions) below capture the owner's request and the proposed defaults needed to implement it.

**Updated:** October 21, 2026, after fetching and reinspecting merged `origin/main` at `fceb52a` (PR #7, storage tip `6a38f87`). This replaces the October 20 pre-merge compatibility baseline. Target evaluation machine: Apple M3 Max with 36 GB unified memory. Model findings below retain their October 20 research date; they are not a benchmark of an assembled High implementation.

**Implementation checkout:** `/Users/han/MyOwnStack/My-Own-Dots/.worktrees/voice-quality`, branch `feat/voice-quality`, based on `fceb52a`. Follow [AGENTS.md](../../AGENTS.md): implementation belongs in the primary checkout's `.worktrees/` directory. Dependencies and the Integrator Python environment are installed in this worktree. No application workspace, credentials, speech models, or voice feature code were changed during preparation. The primary checkout remains at `20d3285` with unrelated local changes and the original handover; use this updated worktree copy.

**Preparation outcome:** No storage architecture blocker was found for Basic/Medium. High now uses a worker-owned delegation repository and SQLite schema 3, with compatibility for known schema 2 archives. Storage merge completion does not mean every existing workspace has migrated or every platform/performance gate has passed.

## Latest checkpoint — tool access and folder approval latency

Basic, Medium and the owner-approved hybrid High implementation are ready for review on `feat/voice-quality`, based on merged main `fceb52a`. This checkpoint supersedes the historical preparation notes and task checklist below. The owner requested a PR to `main`; merging remains a separate step.

- High routes work, permission requests, capability questions and contextual follow-ups to the same governed agent used by chat. Local clock replies use host time; task status and spoken results come from authorized, same-conversation job records. Bounded history and token budgeting preserve current instructions, and forgotten result content is excluded from speech.
- Folder approvals appear beside the desktop Dot. Spoken folder hints are resolved against real directories before proposing a default; manual selection, saved decisions, reopening after close, and expiry recovery retain explicit owner consent.
- A saved folder request now pauses the model loop and emits the existing review tool directly. The prior measured request spent 16.557 seconds before saving the request and another 9.763 seconds waiting for a model decision to show approval. The latter call is removed; desktop polling still adds up to 1.5 seconds. The offline provider fixture rejects any extra decision before approval, then verifies actual file access and continuation after consent. No new live-provider timing has been measured.
- High remains an optional, explicitly installed Qwen/LFM runtime. Model revisions and wheel hashes are pinned; the setup audit and component licenses are documented separately from the application's license. No npm dependency was added for this work.

**Remaining work:** High chooses wording from text, so fully audio-aware answer selection remains open. The new 53-case routing corpus has not run against the real model because the evaluation environment's Metal service failed. Physical microphone/playback, echo, noisy rooms, multilingual input and extended calls need acceptance testing. The latest owner file task also hit the provider's context-capacity limit after approval, and recent calls recorded recognition/audio-delivery failures; these are unresolved, separate from approval latency. Page/connection approvals still use chat. Tasks remain limited to one active job per Dot and keep running after hangup.

**Verification limits:** Fixture tests exercise permissions, routing, persistence and audio protocol, without using the owner's folders or a live subscription. macOS launcher revalidation currently fails because `/usr/bin/getconf DARWIN_USER_CACHE_DIR` returns an input/output error; do not remove sandbox restrictions to bypass this. Earlier successful runtime benchmarks below are historical evidence, not proof of current OS readiness.

**Checkpoint checks:** 1,547 application tests passed; 93 environment-dependent tests were skipped, including PostgreSQL coverage without a test database. The final handoff tests also passed after correcting the decline-receipt fixture. Typecheck, lint, formatting, production build and staged desktop build passed. Python protocol checks passed (31 Basic/Medium and 17 native); CI now runs both without models or audio devices. Three of four macOS launcher checks failed at the OS cache-directory lookup described above; the cache-symlink rejection passed. Vitest discovery is restricted to project tests so ignored evaluation checkouts are not executed. Independent review verified multi-folder and mixed page/folder continuation through a strict offline OpenAI-compatible transport.

## Small-talk repair — October 21, 2026

**Subsequent task-voice repair:** the owner accepted conversation speed/quality, then found task speech changed from female to male. The separate receipt path explicitly requested a UK male TTS voice. Conversation and task receipts now share constrained interleaved speech generation; receipt wording still comes directly from the host. All 33 native Python checks and 22 focused adapter/runtime/call tests pass. Eight real synthetic receipts and a post-receipt conversational reply generated successfully; pitch measurements support removal of the mode mismatch, but automated transcription had word/timestamp errors and does not establish exact acoustic fidelity. See the [task-announcement evaluation](native-voice-evaluation.md#task-announcement-voice-repair--october-21-2026). The updated Python worker is installed for the next call without restarting the pending owner task/approval; a real probe through the bundled launcher passed.

The owner reported repeated refusals to ordinary bedtime conversation. Saved captions were correct; LFM's conversational generation was wrong and repeated earlier refusals. Prompt-only LFM changes and Qwen 1.7B correction attempts were unreliable. The owner explicitly chose **“Activate the tested local hybrid fix”** after being told that Qwen chooses the words from the transcript and original audio affects LFM speech generation only.

The current source uses Qwen3-4B-Instruct-2507 4-bit for both routing and concise conversational replies. Dot instructions occupy the system role; bounded canonical history retains actual user/assistant roles. LFM's pinned interleaved decoder receives the current original waveform, with its text lane constrained to the accepted Qwen reply. Uncertain routing uses contextual local clarification. Validated task delegation and authoritative spoken task receipts retain their existing governed paths. There is no hardcoded bedtime reply, refusal-substring rewrite, or hosted fallback.

Twenty actual-runtime synthetic checks passed, including bedtime, recovery from prior refusals, identity, history recall, ordinary conversation, three work requests, quoted/negative task controls, and a legitimate refusal control. The focused TypeScript suite passed 63 tests, all 32 native Python tests passed, and typecheck/lint passed. These checks do not establish general intelligence, emotion understanding, or exact acoustic fidelity. See [evaluation and the data-only model review](native-voice-evaluation.md#small-talk-repair--october-21-2026).

The replacement runtime is installed separately at `~/Library/Application Support/My Own Dots/native-voice-qwen4`; the previous runtime is retained. Activation is complete: the desktop build passed, the selected workspace points to this runtime, and the relaunched UI shows High selected and ready with the accurate hybrid description. All 20 installed-runtime checks passed; a full synthetic service call persisted the bedtime response and generated speech in 3.14 s after supplied input. No physical microphone, playback or task provider was used. The app is left idle with the call stopped. Do not delete the original storage workspace, backups, or evaluation evidence.

## Original implementation checkpoint — before the small-talk repair

Basic/Medium settings, mode-specific readiness, text-only Basic calls, desktop text visibility and quality-aware timing are implemented in this worktree. Legacy preference updates preserve saved quality; the existing SQLite schema and maintenance admission remain in use. Independent review found and corrected preview/settings races: settings writes cancel previews and block startup until persistence finishes; open settings views reload when the saved preference revision changes.

High is implemented in source with **LFM native audio plus Qwen local routing**, original waveform forwarding and governed asynchronous delegation. It requires Apple Silicon macOS, worker-owned SQLite and an explicitly installed native runtime. The local model never chooses owner/Dot/thread/job identities or permission settings. Tasks use separate same-Dot conversations, the existing approval tools, bounded authorized parent context, renewable fenced leases, durable result receipts and explicit Stop. Hangup/barge-in leave accepted tasks running; restart does not replay work or audio.

The actual production launcher/native runtime completed 25 synthetic local turns without invoking the task provider. A full synthetic High call used the real VAD, native worker, canonical storage and acknowledged PCM transport. Preserve the ignored execution ledger and evaluation artifacts; do not redo Tasks 1–5. Physical microphone/listening, noisy-room/emotion/multilingual and extended duration acceptance remain outstanding. Verification at this checkpoint passed: 1,438 tests, 93 skipped; typecheck, lint, production and desktop builds; 29 native Python checks; and a fresh offline installation followed by a real synthetic High call. The owner subsequently requested ready-to-test setup: the default native runtime was installed and High saved for the existing Dot. The built-in backed-up storage upgrade activated a separate SQLite workspace; the original is retained. See [native evaluation](native-voice-evaluation.md) and the explicit [runtime setup](../../scripts/local-voice/README.md).

## Product requirements

The owner wants a local conversational model that does not require another hosted voice API bill. It need not solve difficult tasks itself: it should understand the request and delegate task work through LLM Integrator to an existing AI subscription CLI such as Codex.

The current transcription pipeline loses information in the original audio, including vocal delivery and background sounds. High must provide the conversational model access to the audio itself. Producing expressive TTS from a transcript does not satisfy this requirement. Native audio access does not by itself establish accurate emotion or sound understanding; evaluate those capabilities.

**Approved interim exception:** the owner accepted the local hybrid repair described above. It improves conversation but does not fulfill the original requirement that audio cues determine what the model says. Preserve that distinction when considering future audio models; do not treat passing waveform data to constrained speech generation as proof of audio-aware reasoning.

The owner explicitly requested these three settings:

| Setting    | Input and processing                                                                                         | Reply                                                     | Resource intent                        |
| ---------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------- |
| **Basic**  | Local speech-to-text, then send the text through the existing Dot agent and configured LLM                   | **Text only; no voice generation**                        | Lowest local processing of the three   |
| **Medium** | Current local speech-to-text → Dot agent/LLM → local text-to-speech implementation                           | Text and generated speech                                 | Preserve today's voice behavior        |
| **High**   | Local audio-aware conversational model, with task delegation through Dot → LLM Integrator → subscription CLI | Native spoken response plus a durable text representation | Highest expected local resource demand |

These labels describe the voice experience and resource profile. They do not select a smarter subscription model, change tool access, or promise that High is faster on every machine.

## Implementation decisions

These are proposed defaults for the next agent, not additional owner-stated requirements:

1. **Persist quality per Dot**, alongside the existing voice and personality settings. All entry points for that Dot use the same preference. Do not add a second conflicting native preference or machine-wide override in this change.
2. **Default to Medium** for existing and newly created Dots, preserving current behavior. Missing quality in legacy records normalizes to `medium`; invalid explicit values are rejected. Quality alone must not enable microphone capture, downloads, or a previously disabled voice feature.
3. **Apply changes between calls.** Keep the current “End the call to change these settings” behavior. Snapshot quality at startup; reject changes to that Dot while starting or active. Do not change engines mid-utterance.
4. **Show all three choices in Dot settings even when models are absent.** A user can save a preference and see its setup/readiness status. Starting a call requires that selected mode to be ready. Selection is distinct from model installation.
5. **No silent fallback.** If High fails or is unsupported, preserve the selection, explain the problem, and offer explicit switching to Medium or Basic. Do not silently use a hosted voice service or relabel the existing cascade as High.
6. **Retain voice/personality preferences across modes.** Basic hides or disables synthesis-only controls and rejects voice preview without starting a worker. Medium keeps current voices. High exposes only voices its actual runtime supports; do not assume Kokoro voice IDs work in a native model.
7. **Basic must display its answer.** Launching Basic from companion Talk or the windowless shortcut opens/focuses the matching compact chat or workspace conversation. Do not leave the user in an invisible text-only call.
8. **Keep the microphone under existing lifecycle control.** Starting still needs an explicit user action. Ending, hiding/closing where existing policy ends calls, locking, sleeping, or losing the device releases capture. Restart never resumes recording automatically.

Suggested UI copy for **Voice chat quality**:

- **Basic — Speak to Dot; receive text replies. Lowest local processing.**
- **Medium — Speak to Dot; receive spoken replies. Current voice experience.**
- **High — Talk with a local audio model. Requires more memory and processing.**

Keep setup status adjacent to High, such as “Needs setup” or a concrete unavailable reason. Show measured or model-specific requirements rather than inventing a universal RAM threshold.

## Global constraints

- All three modes share the selected Dot, owner, conversation, authorized context, tool permissions, approval cards, memory scope, and audit trail.
- Basic must not create, warm, invoke, restart, or preview a synthesis worker, or require TTS model assets to be installed.
- Medium preserves existing streaming, recognition recovery, provider recovery, cancellation, and saved-before-audio behavior.
- High performs casual conversation locally. Do not send every recognized utterance to subscription inference as well.
- Provider CLI integration remains in `myown-llm-integrator`; do not spawn Codex directly from a voice worker or renderer.
- Dots currently pins registry package `myown-llm-integrator@0.2.0`. Changes to the sibling Integrator checkout do not update this app automatically.
- Raw microphone audio stays local by default and remains transient. Delegation sends scoped task text and permitted context to the existing provider; High is not a claim that delegated tasks are offline.
- No automatic paid fallback, model download, or simultaneous warming of all quality modes. Reuse the existing consented local-asset setup pattern.
- Native inference, audio transport, and synthesis must not block the renderer or Electron main process.
- Existing text chat and the separately configured paid Realtime path must remain usable; the three local quality settings do not implicitly select that paid path.
- Pin the selected runtime/model revision and artifact manifest before shipping. Record actual language support and resource measurements.
- Use the migration's asynchronous repositories for all runtime database access. Do not introduce direct SQLite/PostgreSQL connections, synchronous IPC, or separate JSON history/job files in voice components.
- Preserve storage maintenance admission through final call/job persistence and cleanup. A database transaction must never span audio processing, model inference, an approval wait, or an external task.
- Resolve storage readiness from the selected workspace manifest and initialized repositories. A SQLite workspace must not require Docker, a PostgreSQL URL, or a new database service to use voice.

## Compatibility with merged storage

The merged implementation follows the [approved storage design](storage-portability-design.md) and [ordered storage plan](storage-implementation-plan.md). This is broader than moving curated memory: unified storage consolidates conversations, events, evidence, checkpoints, jobs, settings, and existing workspace records into worker-owned SQLite. Core local files remain structured databases, not loose transcript or memory text files.

The fetched merge contains asynchronous runtime repositories, explicit legacy migration, native backup/recovery controls, portable workspace movement and host rebinding, and the final PostgreSQL disconnect fix. Its tree matches the clean storage worktree at `6a38f87`. Existing/default workspaces still use the legacy PostgreSQL path until explicitly upgraded. Select the implementation through `workspace.json` and initialized repository capabilities; do not infer SQLite from the app version or assume the owner's data has migrated.

The [storage verification ledger](storage-verification.md) retains platform, native acceptance, performance/default-activation, and individual Dot export/import gates. Those are separate from this focused compatibility review. Do not block Basic/Medium on future Dot transfer, or claim an unsupported import path is available.

### Integration order and file overlap

The three quality modes remain compatible with the storage direction. The prepared worktree already includes the completed storage merge; no cherry-pick or merge from the storage branch is needed. Do not replace asynchronous storage code with copies from the original `20d3285` voice implementation. Recheck `origin/main` and worktree status when implementation resumes.

| Overlap                                                                                    | Required reconciliation                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/server/local-voice/service.ts`, `routes.ts`, `live.ts`                                | Keep the migration's awaited settings, authorization, call receipts, delivery writes, and maintenance admission while adding quality branches.                     |
| `src/server/workspace.ts`, `platform.ts`, `local-runner.ts`, `dot-agent.ts`                | Consume repository contracts and initialize with `await Platform.create(...)`; keep fenced conversation leases and persisted-event ordering.                       |
| `src/client/WorkspaceDialog.tsx`, `settings-page.css`, desktop startup, and desktop README | Preserve the merged settings layout and **Backup & restore** tab while adding per-Dot voice controls; retain workspace selection, movement, and recovery behavior. |
| Existing voice tests and `tests/worker-runtime.test.ts`                                    | Extend asynchronous fixtures and real-worker coverage instead of reverting them to synchronous-only assumptions.                                                   |
| New High delegation state                                                                  | Coordinate its persistence, schema, archive validation, and recovery behavior with the storage subsystem before shipping it.                                       |

### Interfaces to preserve

- `src/server/storage/runtime-repositories.ts` defines `StoreRepository` and `WorkspaceRepository`; `repository-contract.ts` exposes typed, allowlisted asynchronous worker operations. Existing `workspace.voiceSettings`, `setVoiceSettings`, `createCall`, `setCall`, and `saveVoiceDelivery` operations are already exposed.
- `src/server/local-conversations.ts` defines `ConversationRepository`; `SQLiteConversations` implements it alongside `PostgresConversations`. Use `platform.localConversations` and `ThreadLease`, not a concrete PostgreSQL class or SQL locking primitive.
- `LocalVoiceService.settings`, `saveSettings`, and `require` are now asynchronous. `LiveVoiceCall.touch`, `played`, and `commitText` also require awaiting. `VoiceCallPort.requireThread`, `paused`, `receipt`, and `delivery` allow asynchronous implementations. Carry these semantics into Basic and the new native call adapter.
- `Platform.maintenance` owns backup/migration admission. Existing local calls hold `enterWrite` admission from startup until workers close and final delivery/receipt writes settle; `VoiceCallPort.closed` releases it. Preserve this even in Basic, which has no speech output, and in High, which may have no subscription turn.
- Detached delegation jobs must own their complete maintenance admission through final persisted outcome, independently of the originating call. Do not release job admission when an HTTP response returns or when the user hangs up. Reuse `MaintenanceGate.runWrite`/operation context where appropriate; avoid recursively acquiring a fresh outer gate while a snapshot waits for the existing operation.
- High must use the migrated context/recall contracts, including `WorkerContext` and current memory/access validation. Invalidate or rebuild local conversational context when its workspace, permissions, or memory generation changes; a model cache is never an authority for access to forgotten or revoked content.

### Backup, restore, and workspace portability

Keep `quality`, voice/personality, and durable delegation metadata in the existing workspace database. The established `dot_voice_settings` JSON can carry quality without a separate voice database. Test missing-quality normalization when an older workspace or archive is loaded.

For Basic/Medium, adding a JSON field needs no new table or storage-schema bump. The merged unified schema is version 2 (`src/shared/workspace-manifest.ts`). Avoid an unnecessary schema change merely to introduce the selector.

The existing `MemoryJobRepository` is specifically for `compact` and `dream`. Do not put arbitrary Codex tasks into that queue merely because it is durable. Reuse suitable general task/run records or introduce a narrowly scoped delegation repository behind the same storage worker.

If new tables or columns are necessary, update explicit migrations/schema versions, repository method allowlists, graph validation, migration coverage, and supported archive restoration together. `storage/restore-sqlite.ts` currently compares an exact schema inventory; casually adding a table can make existing archives fail validation. Implement supported version transitions without weakening rejection of unknown schemas. Recovery must preserve job results/idempotency evidence, mark active work interrupted or paused, and never replay external actions.

Retain stable workspace/owner/Dot/thread IDs across moves and recovery. Bind live callbacks to their original workspace session as well as call/generation; a late result must not write into whichever workspace is currently selected. End calls and drain or stop task work before restore/move switches database ownership, following the storage controller's maintenance policy. Hangup alone still follows the separate task policy below.

`storage/workspace-move.ts` deliberately preserves the workspace UUID but generates a fresh backend owner token for the destination, because the original copy remains intact. UUID equality alone therefore cannot authorize an old callback. Use the originating backend/session and cancellation lifetime, never expose the owner token to a model, and discard responses from a retired session. `storage/portable-binding.ts` also interrupts calls/runs, clears leases, and pauses automation when the host changes. Any new delegation persistence must participate in both restoration and portable-host rebinding.

Downloaded models, Python environments, executable runtimes, disposable caches, and backups remain **outside** the authoritative workspace tree under the approved storage design. Resolve asset locations through host configuration; do not bundle model weights into the workspace database, `.dotpack`, or a core recovery archive. After import/restore on another machine, preserve the requested quality but recalculate readiness and require compatible local assets. Apple-only High support must not prevent Basic/Medium configuration or access to stored data on other platforms; actual voice support on each OS still needs its own runtime acceptance.

### Verification evidence and remaining gates

Fresh preparation checks on `fceb52a` passed **164 tests across nine suites**, `npm run typecheck`, and `npm run build` in the new voice worktree. The production build retains the existing large-chunk warning. The tests use temporary stores, synthetic speech workers, and fixture inference; no microphone, live subscription completion, or model download was used:

```sh
MYOWN_LLM_PYTHON="$PWD/node_modules/myown-llm-integrator/python/.venv/bin/python" \
  npm test -- tests/local-voice-live.test.ts tests/local-voice-routes.test.ts \
  tests/storage/maintenance.test.ts tests/worker-runtime.test.ts \
  tests/voice-settings.test.ts tests/local-voice-settings-ui.test.tsx \
  tests/use-local-voice.test.ts tests/storage/workspace-move.test.ts \
  tests/desktop/workspace-backend.test.ts
```

The worker-runtime coverage includes a backup waiting for final voice delivery/receipt persistence; workspace-move coverage exercises the new identity/recovery boundary. The earlier pre-merge run passed 79 tests in the original four compatibility suites; this fresh run supersedes that baseline. This is evidence for existing storage/voice interfaces, not for the unimplemented quality modes, native model latency, live audio, or complete migration readiness.

Keep the storage agent's matched performance baseline fixed while measuring its migration: same model, prompt, context, voice, and provider-session configuration. The storage design gates foreground persistence at p95 ≤25 ms and permits first-text/first-playback regression only up to the larger of 5% or 50 ms at p50/p95, including backup/maintenance load. Evaluate Basic savings and High native-model latency separately; changing the voice engine cannot serve as proof that the storage migration met its gate.

## Current implementation and insertion map

Read the current checkout and the storage compatibility section before editing. In the primary checkout, `docs/desktop/local-voice-implementation-brief.md` and `vendor/` are pre-existing untracked paths; preserve them. They were not copied into this worktree. The older brief excludes native speech-to-speech from its scope. The owner's new High requirement explicitly reopens that scope; this handover carries forward the conversation and lifecycle safeguards.

| Files                                                                                                               | Current responsibility and change needed                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/voice-settings.ts`; `src/server/workspace.ts`                                                           | Strict voice/personality schema and per-Dot JSON in `dot_voice_settings`. Add quality and backward-compatible record normalization without losing existing selections.                                                                           |
| `src/shared/local-voice.ts`; `src/shared/voice-receipt.ts`                                                          | Call status, transport events, handles, and delivery metadata. Add selected mode/capabilities and distinguish text delivery from audio delivery.                                                                                                 |
| `src/server/local-voice/service.ts`; `routes.ts`                                                                    | Settings, preview, status, call startup, and scoped transport. Current `status()` requires Whisper, Kokoro, voices, and VAD for every call; current startup always constructs synthesis. Split requirements by mode.                             |
| `src/server/local-voice/live.ts`; `speech-output.ts`; `worker.ts`                                                   | Current call state machine, warm workers, generation cancellation, provider text commits, synthesis recovery, and output. Basic must work with no synthesis object; High needs a separate adapter rather than a forced transcript path.          |
| `scripts/local-voice/worker.py`; `runtime-lock.json`; `manifest.json`                                               | Engine-specific asset loading already exists, but runtime verification checks the full package lock. Ensure Basic setup/readiness works without TTS assets and does not load TTS engines; examine dependency grouping as well as model grouping. |
| `src/server/local-voice/context.ts`; `inference.ts`                                                                 | Scoped voice context and optional Integrator inference/provider sessions. Keep these working for Basic/Medium and reuse the Integrator boundary for High delegation.                                                                             |
| `src/server/dot-agent.ts`; `local-runner.ts`; `local-conversations.ts`; `platform.ts`                               | Governed execution, repository-backed fenced thread leases, persistence, approvals, cancellation, and memory. Use the migrated asynchronous interfaces for both SQLite and retained legacy storage.                                              |
| `src/client/local-voice/VoiceSettings.tsx`; `src/client/WorkspaceDialog.tsx`; `App.tsx`; `Chat.tsx`                 | Existing voice selector, Dot editing, and conversation entry points. Put quality in Dot settings and share it with the existing voice panel. Remove readiness gating that prevents choosing a lighter mode.                                      |
| `src/client/local-voice/useLocalVoice.ts`; `audio.ts`; `src/client/CallView.tsx`                                    | Microphone/SSE control, playback, approvals, call presentation. Startup currently initializes playback unconditionally. Basic needs capture and readable answers without output initialization or playback acknowledgements.                     |
| `src/desktop/host/voice-session.ts`; `src/desktop/shared/voice-contract.ts`; `src/desktop/renderer/voice-status.ts` | Companion Talk, shortcut, native call state, and lifecycle. Use mode-specific readiness and reveal text UI for Basic.                                                                                                                            |
| `src/server/local-voice/timing.ts`; `scripts/voice-timings.mjs`                                                     | Reuse timing diagnostics with mode labels and mode-appropriate milestones. Basic has no first-audio milestone.                                                                                                                                   |

Do not confuse speaker mute with Basic. The current call warms synthesis before speaking and can restart it after interruption. Turning down or suppressing playback does not remove that work.

## High candidate research

Keep the shortlist open until measured evidence supports a selection. The [owner's reference list](https://github.com/tleyden/awesome-llm-speech-to-speech) mixes models, applications, and orchestration frameworks; its capability labels are leads to verify.

| Candidate                                            | Fit and evidence                                                                                                                                                                                                                                                                                                                                                 | Decision for implementation                                                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NemotronLabs VoiceChat 11B with an Apple runtime** | Native audio input/output and a function channel. Community [MLX weights](https://huggingface.co/mlx-community/NemotronLabs-VoiceChat-11B-4bit) and [speech-swift](https://github.com/soniqo/speech-swift/blob/main/docs/models/voicechat.md) provide Apple paths; speech-swift documents native tool execution/result feedback.                                 | First candidate for delegation capability. Validate the precise runtime on M3 Max; upstream NVIDIA performance is not a Mac benchmark.                                                          |
| **LFM2.5-Audio-1.5B with MLX Audio**                 | Small audio-input/audio-output model; English-only model card. [Liquid model card](https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B) and [MLX Audio support](https://github.com/Blaizzy/mlx-audio).                                                                                                                                                             | First candidate for a lighter local conversation layer. Native structured delegation is not established by the research; prove it or explicitly evaluate an additional local routing component. |
| **MiniCPM-o 4.5**                                    | Native audio conversation. Published Mac requirements cover M3 with 16 GB for half-duplex, while full-duplex targets M4 Max with 24 GB. [Model/deployment documentation](https://huggingface.co/openbmb/MiniCPM-o-4_5).                                                                                                                                          | Keep as an alternative. Do not assume that 36 GB alone proves simultaneous listening/speaking performance on M3 Max. Validate tool handoff.                                                     |
| **Speaches**                                         | Local STT/TTS API with a text-LLM proxy. Incoming audio is replaced by text. Its Realtime docs list cancellation/truncation gaps and native speech-to-speech support as future work. [Voice chat](https://speaches.ai/usage/voice-chat/), [Realtime limitations](https://speaches.ai/usage/realtime-api/).                                                       | Possible Basic/Medium infrastructure; does not satisfy High as shipped. No need to replace the current pipeline merely to adopt this project.                                                   |
| **Vocalis**                                          | Faster-Whisper → local LM Studio → separate TTS application. The inspected LLM path reads only text content, and the main voice path waits for the complete reply and synthesized audio. [LLM code](https://github.com/Lex-au/Vocalis/blob/main/backend/services/llm.py), [voice code](https://github.com/Lex-au/Vocalis/blob/main/backend/routes/websocket.py). | UX reference, lower integration priority. Not a native-audio replacement or ready-made Integrator delegation layer.                                                                             |
| **Pipecat**                                          | Framework with [local Ollama](https://docs.pipecat.ai/api-reference/server/services/llm/ollama), [offline Kokoro](https://docs.pipecat.ai/api-reference/server/services/tts/kokoro), and [tool handlers](https://docs.pipecat.ai/pipecat/learn/function-calling).                                                                                                | Evaluate only if orchestration reuse earns its dependency cost. Preserving audio context still depends on the chosen model.                                                                     |

[Ultravox](https://github.com/fixie-ai/ultravox) accepts audio directly but outputs text and requires separate TTS; it is a partial alternative. [Unmute](https://github.com/kyutai-labs/unmute#setup) documents CUDA/x86 requirements and no Mac support, so exclude it from the initial Mac shortlist.

The speech-swift implementation reports measurements on an M5 Pro, not this M3 Max. It also keeps microphone processing alive while a tool is pending but pauses conversational generation until the result returns. For long subscription tasks, use the asynchronous job pattern below. Do not promise unrestricted concurrent conversation solely because a model says “full duplex.”

## Proposed contracts

These names define the intended seams; adapt them to current repository conventions if the checkout has changed, keeping equivalent behavior and tests.

### Settings and readiness

Extend `VoiceSettings` with `quality: 'basic' | 'medium' | 'high'`. Preserve `voiceId` and `personality`; default missing legacy quality to `medium`. Separate stored-record normalization from updates: a legacy request omitting quality must preserve the saved value, not reset a High user to Medium.

Use a distinct update schema with optional `quality` and no default. Both `routes.ts` and `LocalVoiceService.saveSettings` currently parse before calling `WorkspaceStore.setVoiceSettings`; neither may turn an omitted update into an explicit `medium`. Resolve omission and write the result inside one worker-owned `setVoiceSettings` operation, using the current stored value. Return normalized settings to the caller. This prevents a separate asynchronous read/write pair from overwriting a newer selection.

Add a pure helper in `src/shared/voice-settings.ts`:

```ts
export type VoiceQuality = 'basic' | 'medium' | 'high';
export function usesSpeechOutput(quality: VoiceQuality): boolean;
```

Extend `LocalVoiceStatus` with `selectedQuality` and a `modes` record keyed by quality. Each mode reports `ready`, `reason`, `audioInput`, `audioOutput`, and whether setup is needed. Existing top-level `ready`/`reason` describe the selected mode for compatibility.

- `LocalVoiceService.status(dotId?: string): Promise<LocalVoiceStatus>` uses the Dot's saved quality when supplied; when `dotId` is omitted, retain legacy Medium status semantics.
- `GET /api/local-voice/status?dotId=...` authenticates/validates the Dot and returns its mode-specific status.
- Settings GET/PUT remain usable without installed models. Preview checks the selected mode separately.
- `POST /api/local-voice/calls` resolves quality from server settings and snapshots it in the returned `LocalVoiceHandle`. The renderer cannot override readiness or routing with an arbitrary engine/model name.
- Basic requires recognition/VAD and existing text-inference readiness; Medium additionally requires synthesis. High checks its selected native runtime/assets and reports delegation availability separately.
- All settings/readiness/call checks await the migration's repositories. A resolved SQLite conversation backend is valid without `LOCAL_DATABASE_URL`; speech assets and subscription availability are separate checks.

`App.tsx` currently polls one unscoped status and hides `VoiceSettings` when local voice is disabled. Make readiness scoped to the selected Dot and workspace/backend session, invalidate it after a successful settings save, and ignore stale poll responses after either selection changes. Render the selector in the existing Dot settings as well as the shared chat controls, including before setup. For a newly created Dot, persist its voice preference only after its ID exists. Preserve the existing global settings categories and styles.

Native conversation should remain usable if the subscription provider becomes unavailable, with an honest “task delegation unavailable” response for work requests. Unsupported local inference or missing High assets must never appear as ready.

### Native session boundary

Define a provider-neutral contract in a proposed `src/server/local-voice/native-contract.ts` before connecting a chosen model:

```ts
interface NativeVoiceSession {
  start(signal: AbortSignal): Promise<void>;
  pushAudio(sequence: number, pcm: Buffer): Promise<void>;
  submitToolResult(callId: string, result: unknown): Promise<void>;
  interrupt(generation: number): Promise<void>;
  close(): Promise<void>;
}
```

The factory also accepts a host event sink for final user transcript, assistant text segment, audio segment, phase, structured tool request, and failure. Give every output a call/generation identity; text/audio alignment and sequence ordering must be explicit. Validate tool arguments in the host before execution.

Retain the existing client transport's normalized audio format where practical; resample and convert native model formats in the adapter. Bound incoming frames, output queues, and pending events. Negotiate any required format change explicitly rather than playing native bytes as the old PCM format.

High captions serve history and accessibility. The local model must still receive audio features; captions must not become a transcript-only replacement input. Native output may be buffered briefly to persist aligned text segments before playback. If a candidate cannot provide a durable text representation with acceptable latency, record that as a selection failure.

### Task delegation and conversation ownership

Expose one narrow model-facing operation initially:

```text
delegate_task({ request: string })
  -> { jobId: string, status: "queued" }
```

The host supplies owner/Dot/thread/call/utterance identifiers, scoped context, and a stable idempotency key. The model must not choose those identities, arbitrary shell commands, CLI flags, or permission grants. Route the request through the existing governed Dot task path and LLM Integrator.

1. Persist the user turn and validate the requested handoff.
2. Register a durable job correlated to the source turn, return its ID promptly, and let native conversation resume.
3. Execute via existing Dot permissions and approval UI. Request clarification when intent is unclear; do not make a task run from background noise or a partial transcript.
4. Deliver authoritative job status/results back into the correct conversation and local model. “Queued” is not “completed.” The spoken summary must reflect the actual result.
5. Deduplicate retries of the same tool call. A new intentional request receives a new identity.

This job coordinator is **new work**, not a capability established by finding a tool-calling model. Reconcile it with `LocalAgentRunner` and repository-backed fenced thread leases: never launch competing runs or write around the lease. Use a correlated worker conversation/job when needed, then serialize parent-thread updates through the governed persistence path. Each background task must retain independent maintenance admission through final persistence, as described above. Prove that continuing casual conversation cannot deadlock or corrupt the task run.

Default lifecycle policy: hangup stops capture and speech, while an already accepted task continues with its status visible in chat; explicit Stop task cancels that job. Interruption only stops the current spoken response unless the user explicitly requests task cancellation. After restart, recover job status from durable state and do not replay actions or audio automatically. Completed results for an ended call go to text history; do not reopen the microphone.

Local small talk must not launch the current client `onTranscript` subscription path as a side effect. Introduce one explicit owner for each turn: Basic/Medium use the existing agent response, High uses native conversation with optional scoped task delegation. Persist both through the established conversation infrastructure without duplicated user or assistant messages.

## Review focus

- Legacy settings and stale clients: preserve voice/personality and an explicitly saved High selection when quality is omitted from an older update.
- Partial installation: Basic remains usable with recognition assets even when Kokoro/voices are missing; all TTS entry points remain uncalled.
- Call identity races: mode changes, Dot switching, delayed native audio, and late job results never cross call/Dot boundaries.
- Task concurrency: native conversation, approvals, queued jobs, cancellation, reconnects, and thread leases do not duplicate actions or history.
- Resource pressure: High startup failure, worker crash, memory pressure, and teardown leave text chat usable and no hidden capture or retained model workers.
- Storage lifecycle: delayed worker writes, backup admission, restore/import, workspace switching, and old-schema archives preserve voice settings and durable outcomes without replaying jobs.

## Implementation tasks

Implement Basic/Medium independently of the High model decision. High is not complete until the real native path and delegation pass acceptance; a visible disabled option is only an intermediate milestone.

### Task 0: Adopt the storage integration baseline

**Files:** Read the current storage design, implementation/verification ledgers, `storage/runtime-repositories.ts`, `repository-contract.ts`, `maintenance.ts`, and the migrated voice files before changing them.

**Interfaces:** Consume asynchronous workspace repositories, `ConversationRepository`, `ThreadLease`, `Platform.create`, and `Platform.maintenance`. Do not create an alternate storage backend for voice.

- [x] Fetch and verify merged `origin/main` at `fceb52a`; confirm its tree matches clean storage tip `6a38f87`. Preserve primary-checkout changes.
- [x] Create `.worktrees/voice-quality` on `feat/voice-quality` from the merge, verify `.worktrees/` is ignored, and install Node/Integrator Python dependencies locally.
- [x] Run the nine focused compatibility suites above (164 passing tests), typecheck, and production build. Preserve asynchronous fixture callbacks and storage-worker initialization.
- [x] Confirm quality can use existing per-Dot JSON without changing storage schema; record exact-schema archive and portable-host constraints for High.
- [x] Before Task 5, choose the existing task/run records or a new worker repository that will own delegation. Reconcile any required schema/archive changes at that point.

### Task 1: Persist quality and expose mode-specific readiness

**Files:** Modify `src/shared/voice-settings.ts`, `src/shared/local-voice.ts`, `src/server/workspace.ts`, `src/server/local-voice/service.ts`, and `routes.ts`. Extend `tests/voice-settings.test.ts` and `tests/local-voice-routes.test.ts`; create `tests/local-voice-quality.test.ts`.

**Interfaces:** Produce `VoiceQuality`, `usesSpeechOutput`, normalized `VoiceSettings`, and the status/handle additions defined above. Preserve existing settings routes.

- [x] Add failing tests for missing-quality migration to Medium, per-Dot persistence across restart, invalid values, and legacy PUT preserving an already saved quality through both route/service parsing and the worker operation.
- [x] Add readiness tests: missing TTS assets blocks Medium but not Basic; absent native runtime blocks High; reading/saving preferences neither loads models nor enables recording.
- [x] Test the settings through `StorageClient.repositories`, including legacy JSON normalization and SQLite readiness with no PostgreSQL URL. Confirm quality survives a supported workspace backup/restore.
- [x] Run `npm test -- tests/voice-settings.test.ts tests/local-voice-routes.test.ts tests/local-voice-quality.test.ts` and confirm failures target the missing behavior.
- [x] Implement the schema, normalization, mode-specific asset/runtime checks, and immutable startup selection.
- [x] Re-run that command; require all tests to pass before proceeding.

### Task 2: Implement Basic without synthesis and preserve Medium

**Files:** Modify `src/server/local-voice/service.ts`, `live.ts`, `worker.ts`, `src/client/local-voice/useLocalVoice.ts`, and `audio.ts`. Update speech runtime setup/lock handling only where Basic needs it. Extend `tests/local-voice-live.test.ts`, `tests/use-local-voice.test.ts`, `tests/local-voice-worker.test.ts`, and the quality tests.

**Interfaces:** Consume the call's snapshotted `VoiceQuality`; allow the Basic worker set to contain recognition/VAD/inference with no synthesis. Keep the Medium transport and saved-text contract intact.

- [x] Add a Basic test worker factory that throws if synthesis is constructed, warmed, invoked, recovered, or previewed; run a full voice-input → canonical-text-reply turn with it.
- [x] Cover both buffered and persistent-provider text paths. Assert zero audio events/delivery acknowledgements, no `speaking` state, and no output-only browser initialization. Capture may still use an AudioContext.
- [x] Test interruption, errors, approvals, repeated turns, and hangup without synthesis. Test that a deliberately unmuted speaker control cannot enable speech in Basic.
- [x] Extend the worker-runtime receipt test to Basic: backup admission remains held until text/call persistence settles even though no synthesis or audio delivery occurs.
- [x] Run the targeted suites, implement the no-synthesis branch and text completion state, then re-run to green.
- [x] Run `npm test -- tests/local-voice-live.test.ts tests/local-voice-speech-output.test.ts tests/use-local-voice.test.ts tests/local-voice-worker.test.ts tests/voice-provider-call.test.ts tests/voice-provider-recovery-integration.test.ts tests/local-voice-quality.test.ts`; require unchanged Medium expectations to pass.

### Task 3: Add quality controls and reconcile every Talk entry point

**Files:** Modify `src/client/local-voice/VoiceSettings.tsx`, `src/client/WorkspaceDialog.tsx`, `App.tsx`, `Chat.tsx`, `CallView.tsx`, and relevant existing styles. Update desktop voice host/bridge/status code where needed. Extend `tests/local-voice-settings-ui.test.tsx`, `tests/local-voice-call-view.test.tsx`, and `tests/desktop/voice-session.test.ts`.

**Interfaces:** Consume shared settings/readiness and the returned call quality; produce the exact three labels/copy above. Reuse one persisted preference across settings, chat, compact chat, and companion Talk.

- [x] Add tests that the selector is available in Dot settings and chat before model setup, saves per Dot, preserves voice preferences, refreshes readiness after saving, and rejects in-call changes on both UI and server.
- [x] Test disabled Basic preview/output controls, visible unavailable-High reasons, and explicit fallback selection.
- [x] Test companion/shortcut Basic revealing the matching text conversation and refusing stale readiness from another Dot.
- [x] Preserve the **Backup & restore** settings tab and re-evaluate mode readiness after supported workspace switching, restore, or movement; never retain readiness from the previous workspace or machine. Include future Dot import when that feature exists.
- [x] Run the targeted tests, implement the settings and call presentation changes, then re-run to green.
- [x] Verify with `npm test -- tests/local-voice-settings-ui.test.tsx tests/local-voice-call-view.test.tsx tests/desktop/voice-session.test.ts tests/desktop/chat-window-voice.test.ts tests/desktop/voice-status.test.ts`.

### Task 4: Select and validate a native High runtime

**Files:** Create `docs/desktop/native-voice-evaluation.md` and `src/server/local-voice/native-contract.ts`. Add the smallest candidate adapter/manifest in clearly named files under `src/server/local-voice/` and `scripts/local-voice/` after selection. Create `tests/native-voice-adapter.test.ts`.

**Interfaces:** Produce `NativeVoiceSession` plus typed, validated host events. The evaluation record names exact model/runtime revisions, formats, languages, limits, and the selected adapter's files.

- [x] Compare Nemotron and LFM against the same audio fixtures. Neither standalone candidate reliably routed ordinary work. The owner approved LFM plus a separate local router; Qwen passed the tested routing cases. MiniCPM remains an uninstalled fallback. Keep Speaches/Vocalis as references.
- [x] Verify original audio reaches LFM, user/assistant text is available, and the composed audio/router/host path supports a structured delegation request and authoritative result.
- [x] Add fixture contract tests for bounded queues, malformed tool events, stale generations, startup failure, interruption, and teardown; run `npm test -- tests/native-voice-adapter.test.ts`.
- [ ] Where setup/live evaluation is authorized, measure cold startup, warmed first meaningful audio, sustained real-time factor, p50/p95 latency, peak unified memory, and long-call queue/memory growth on the M3 Max under normal app load.
- [ ] Evaluate identical words spoken with different delivery, non-speech sounds, silence/noise, code-switching, and task requests. Record actual behavior and unsupported languages; do not infer emotion understanding from expressive output.
- [x] Record the owner-approved composed selection and implement that production adapter. Require explicit setup and document outstanding live acceptance separately from source and synthetic-runtime checks.

### Task 5: Integrate High and asynchronous governed delegation

**Files:** Implemented in `native-runtime.ts`, `native-agent.ts` and `delegation.ts`, reusing the existing `live.ts` call state machine. Integration includes `service.ts`, `routes.ts`, `dot-agent.ts`, `local-runner.ts`, `useLocalVoice.ts` and `VoiceTasks.tsx`. Durable jobs live in `storage/voice-delegations.ts`, with schema, archive and portable-host handling. Tests are named `native-voice-runtime`, `native-voice-agent`, `native-voice-live`, `voice-delegation-coordinator` and `storage/voice-delegations`.

**Interfaces:** Consume Task 4's native adapter; expose `delegate_task` to the model and host-owned job identity/result delivery. Reuse current Dot/Integrator execution, not a direct CLI subprocess or new permission model.

- [x] Add fixtures proving casual conversation causes zero subscription calls and each accepted task causes one governed delegation.
- [ ] Cover clarification, approval pending/denied, provider unavailable, malformed arguments, duplicate tool events, completion after hangup, restart recovery, explicit cancellation, and no automatic action replay.
- [x] Cover concurrent small talk and job activity under thread leases, no duplicate transcript submission, cross-Dot result rejection, and text persistence before aligned audio release.
- [ ] Test a detached job continuing after hangup while a backup waits for its final outcome; test worker failure, restore/portable-host rebinding with pending jobs, and late completion after a workspace switch or move with the same UUID. Verify no action replay and no writes to the new workspace. Extend to Dot import when supported.
- [x] If schema changes are added, prove supported older archives remain restorable and new archives contain delegation outcomes/idempotency state; preserve unknown-schema rejection.
- [x] Implement the job coordinator and High call orchestration after the composed adapter passes its contract gates.
- [x] Run the actual integration suites listed above, the adapter, existing context/session tests and the full repository suite; require all tests to pass.

### Task 6: Resource lifecycle, acceptance, and operator documentation

**Files:** Extend mode-specific lifecycle tests and `timing.ts`/`scripts/voice-timings.mjs` as required. Update `docs/desktop/local-voice-calls.md`, `docs/desktop/README.md`, and the root README when the feature is actually available.

**Interfaces:** Report actual mode, selected runtime/revision, setup status, and mode-appropriate timings. Model cache lifetime must be explicit and bounded.

- [ ] Verify Medium → end → Basic releases the synthesis model and never warms High. High → end → Basic releases the native model; keep any idle-cache policy documented and bounded.
- [ ] Exercise lock/sleep, renderer disconnect, worker crash, low memory, permission denial, and repeated start/end. Require text chat recovery and no capture/worker leaks.
- [ ] Run the storage compatibility suites plus relevant restore/migration tests after integration. Measure voice under storage-worker queue pressure and backup/maintenance load without changing the storage migration's matched baseline.
- [x] Run `npm run typecheck`, `npm run lint`, production compilation, and the relevant desktop build when desktop files change. Builds use scratch output to preserve the running test app. Run the repository test suite with worktree discovery excluded as appropriate to the current configuration; distinguish existing failures from regressions.
- [ ] Perform authorized UI/audio acceptance across all entry points and modes, including an extended High call under ordinary desktop load. Record unexecuted live checks separately from fixture test results.
- [x] Update setup instructions, resource measurements, languages, fallback behavior, and task cancellation semantics. Never document High as shipped based only on a selector or a fixture adapter.

## Completion criteria

- Basic accepts speech and produces canonical text replies with **zero speech generation**, including startup, recovery, and preview.
- Medium preserves current user-visible voice behavior and its existing regression coverage.
- High receives original audio, converses locally, speaks through the selected native runtime, and delegates real work through governed Dot/Integrator execution.
- The quality setting persists, migrates safely, is accessible before setup, and is honored by chat, compact chat, companion Talk, and the shortcut.
- Missing assets, unavailable providers, and inadequate machine performance produce honest mode-specific status and explicit recovery choices.
- All modes maintain one coherent conversation and existing approval/memory boundaries. Long tasks have durable identity and cannot be replayed by reconnect/restart.
- Voice works through the migrated asynchronous storage interfaces, preserves backup admission, and requires no Docker/PostgreSQL for a SQLite workspace. Supported recovery/import/move flows retain settings and safe task outcomes without copying model runtimes.
- Verification distinguishes source/fixture evidence from actual microphone, listening, runtime, and subscription measurements.

## Next agent kickoff

> Continue from the latest checkpoint in the project-local `voice-quality` worktree, or from main after this branch is merged. Preserve the Basic/Medium/High implementation and evaluation evidence. Qwen-selected words with LFM speech is the owner's approved hybrid; do not restart candidate research or repeat completed implementation. Prioritize context-capacity and speech failures, the real-model routing corpus, then live acceptance. Preserve asynchronous repositories, fenced leases, maintenance admission, permissions, memory scope and canonical text. Runtime/model assets stay outside workspace backups. Distinguish fixture, real synthetic-runtime and physical audio evidence. Check the actual PR and running build state rather than assuming historical activation notes are current. Apply dependency review before unfamiliar installation. The owner authorized a PR to main, not a merge or replacement of unrelated work.
