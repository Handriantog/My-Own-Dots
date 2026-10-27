# Voice and chat regression repair

This candidate follows the owner’s reports after PR #15. Source fixes, automated
checks, live-provider measurements and physical-device acceptance are separate.
The current candidate’s final package and verification record belongs in
`artifacts/voice-live-regressions/`; earlier package results do not qualify it.

## Confirmed failures and changes

| Boundary                                   | Cause                                                                                                                                                                                    | Repair                                                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task transcript → ordinary text chat       | A visible queued-task thread accepted fresh composer input, while its server correctly required the original immutable delegated request.                                                | The host resolves its parent conversation. New text is sent there; task identity and approval cards remain attached to the worker. Failed transfers preserve drafts.                              |
| Voice conversation → task execution        | Every ordinary utterance joined the same serialized execution queue. A contextual first message could not arrive until the task started.                                                 | A separate effect-free Codex conversation turn answers casual speech or gives a contextual handoff before the unchanged request enters the task queue. It cannot perform actions or grant access. |
| Worker approval → live call                | Delayed approval receipts were spoken but did not emit the call’s review hint or approval phase. The desktop poller was independent, so this alone does not explain every missing panel. | Validated approval metadata notifies the existing review flow independently of speech and preserves the current input’s approval phase. Older task updates cannot overwrite a newer turn’s phase. |
| Microphone VAD → interruption              | One 32 ms negative VAD frame erased all accumulated speech during playback; a four-second paused correction never reached 1.5 seconds of consecutive speech.                             | Preserve the existing 1.5-second voiced threshold, allow gaps up to 256 ms, and bound the confirmation window to 2.016 seconds.                                                                   |
| Packaged backend → diagnostics             | Voice timing output went to stdout, which the packaged backend discarded.                                                                                                                | Save bounded, content-free phase timings to the private daily diagnostic log. Execution preparation, provider start, first event, completion and cleanup have separate markers.                   |
| Codex configuration → conversation latency | The new execution adapter inherited the owner’s `xhigh` coding preference, whereas the earlier restricted voice adapter explicitly restored a voice reasoning default.                   | The short conversation session explicitly requests `low` reasoning, with verified effective configuration. The task engine and owner’s global configuration retain their existing settings.       |

The historical eight-minute task delay has not been assigned a definitive cause.
A disposable 64-predecessor context preparation probe reached provider creation
in 30 ms. Initial worker requests and approval continuations could not invoke
foreground compaction inference because their last user input was at index zero.
Neither fact proves that the owner’s long run was healthy; the new stage logs are
needed to distinguish host preparation from provider delay in a future occurrence.

## Conversation admission boundaries

The call warms and owns a Codex process through the installed Integrator. Each
utterance uses a new ephemeral provider thread with fresh, bounded input. The
process has no project scope, native execution or tools. Its completed JSON
response is strictly validated for a short reply, a task handoff decision and
whether the reply uses host task status. Personal/project facts and results missing from this
limited context go to the full task agent.

Only currently visible owner-authored history and host lifecycle metadata enter
this short turn. Copied task captions are not used after their canonical source
is forgotten or hidden. Pending replies carry their acceptance-time suppression
generation; forgetting invalidates replay and delayed mirroring of derived prose.
Task status is rechecked after reasoning, including cancelled pending inputs.

The recognized caption is saved to the call transcript before inference. The
decision is persisted before speech or dispatch. Retry reuses the saved decision;
it does not repeat inference or mutate the accepted request. A quick-inference
failure is explicit and preserves the original request for the ordinary task
agent. Conversation-only receipts cannot convert into tasks. Task execution
remains serialized, while conversation and approval waits do not own that slot.

Live qualification also caught an incorrect capability statement: the quick
reply said Dot could not request write access, while the same unchanged request
subsequently opened the correct read/write approval. The original contract
conflated the restricted composing process with the full companion. Intake now
explicitly composes speech on behalf of Dot, using host-advertised capabilities.
Its empty tool list does not establish a product limitation. Missing permission
remains distinct from inability to request permission, and only the owner can
grant access. The failed run remains recorded; this change requires a new live
semantic review, including that permission still gates the actual effect.

## Dependency delta

The candidate pins the owner-maintained `myown-llm-integrator@0.3.0-rc.2` archive,
built from the existing project-local Integrator worktree. Its execution source
matched the installed rc.1 source before editing. The additive change accepts
`reasoningEffort`, validates its enum, sets the verified process configuration,
and explicitly sends it on `turn/start`. Omitting it retains existing behavior.

No new third-party dependency, precompiled download, credential copy or global
CLI configuration change is involved. The existing build script only copies
reviewed source into `dist`; lockfile generation ran offline with scripts
disabled. The archive was overlaid into the installed package to preserve its
existing Python environment. All 74 Integrator JavaScript tests passed, including
new real-process cases for inherited effort, mismatched effective configuration
and invalid input. The Python implementation and its dependency lock are unchanged.

Archive SHA-256:
`8319a1511d2d1d9c30b5f335a06a5c6bc51a3223787ca40ba46d7a2e7b5d6556`.
The npm lockfile pins its SHA-512. Public registry publication remains a separate
release action. This is a local source patch to the existing reviewed package,
not a security reassessment of every upstream component.

## Verification limits and handoff

Focused tests cover storage-worker RPC, immutable handoff, input deduplication,
busy parent conversations, interrupted inference, forgetting races, stale status,
delayed approvals, UI transfer and manual retry. The interruption harness uses
the actual browser capture/worklet/HTTP/Silero/SSE/Web Audio path with synthetic
input. Physical Mac-speaker echo cancellation and real double talk remain unverified.
One intermittent browser audio-start failure is retained in its report.

Cold and warmed real-provider conversation runs exposed multi-second delays and
12-second timeouts. Their reports remain in the candidate artifacts; the short
conversation lane is not evidence of a guaranteed five-second audible response.
A two-call comparison found tool-decision confirmation added about 1 ms after
the decision; strict JSON final output was slower in that pair. However, targeted
comparisons on the two repeatedly failing action requests completed in 4.246 and
5.084 seconds with strict JSON, versus twelve-second tool-decision timeouts.
The final implementation therefore uses completed, validated JSON with no tools.
Local synthesis/playback adds separate latency.

The final provider set returned valid decisions for all nine known regressions
and two of three fresh cases. Successful responses took 3.183–8.784 seconds;
one fresh explanation request reached the 12-second deadline. This is not a
complete latency pass. Failed attempts remain in the reports.

Schema 8 adds conversation-only receipts and suppression provenance, preserving
existing rows, ordering, indexes and foreign keys. Schemas 2–7 remain importable.
Startup does not create a pre-migration backup automatically. Before launching
this candidate on the owner’s workspace, preserve a private, consistent schema-7
backup and manifest, and quit the old app. Older builds need that backup to roll
back; they cannot open schema 8. Tests must use disposable databases throughout.
The recorded owner backup used SQLite’s online backup API from a read-only
connection, plus copied workspace files and selection preferences; the running
app was not stopped or modified. Its database passed integrity and foreign-key
checks. The backup records its capture time and does not include later changes.

## Earlier owner test candidate record

This section preserves the earlier candidate's evidence and launch limitation.
The current combined candidate, including daily conversation grouping and the
restart correction below, is recorded in [Daily conversations and call history](2026-10-27-daily-chats.md).

Source SHA-256:
`7d70c84ebe600c5e7adeb4e61bee3dbd77eb94c59b48fe0cd7f28a8ab70cc8e9`.
This package matches the source used for the owner test handoff. `verify:core` passed with
2,733 tests and 84 Python checks against the dedicated test database, plus
formatting, lint, types and build. One certificate-signing test was skipped
because no signing identity was configured. `verify:macos` passed 636 tests,
28 native sandbox probes, packaging, signing verification and the relocated
offline runtime smoke test.

The exact package passed 46 functional journey checks in
`artifacts/voice-live-regressions/candidate-final-20261027-retry2/`.
Independent review compared current replies and task transcripts with the
disposable database and actual files. It confirmed truthful permission wording,
denial, the selected replacement folder, conversation during approval, a
contextual reply while work was queued, one exact file write, unchanged existing
files, no observed replay, prerecorded spoken hangup and clean product shutdown.
Two fresh effect-free conversation cases also passed independent semantic review.
Earlier failed runs remain preserved.

Reply preparation in the packaged journey took 4.796–10.559 seconds, including
local synthesis; the fresh text-only cases took 4.006 and 6.498 seconds. This
does not meet a consistent five-second target. Task captions were injected after
real VAD; only the prerecorded hangup used actual recognition. Software playback
acknowledgements do not establish audibility. Browser interruption with synthetic
microphone input passed; physical Mac-speaker double talk and the OS folder
picker remain unverified.

Automatic restart was blocked at that handoff: computer control returned
`Computer Use server error -10005: timeoutReached`, including after a fresh client
reset. The owner app was not stopped or upgraded by this session, so connection
of the new build to the owner workspace is not verified. The verified app is in
`artifacts/voice-live-regressions/release/My Own Dots-darwin-arm64/My Own Dots.app`;
quit the existing copy before opening it. The private pre-upgrade backup record
is `artifacts/voice-live-regressions/owner-backup.json`.

## Pull request preparation

The final review found a restart edge case after that handoff: recovery treated
an already answered conversation receipt as unfinished task input when its
parent chat was still busy. It replaced the accepted reply with an interruption
message. Recovery now preserves conversation-only decisions and their suppression
generation; unfinished action requests still become interrupted. Regression
tests reproduced the loss before the fix through a real storage-worker restart
and deferred canonical delivery, then verified no inference, speech or task
replay and continued redaction after forgetting.

The PR also includes the complete rc.2 source patch and refreshed vendor
provenance. Reconstruction from the documented upstream base matched all 32
shipped files byte-for-byte, and all 74 reconstructed-package JavaScript tests
passed using the existing pinned Python environment. The npm archive and lock
integrity are unchanged.

The earlier owner test bundle was kept unchanged and does not contain the
additional restart correction. Intermediate PR checks and a separate package
are recorded under `artifacts/voice-live-regressions/pr/`. The earlier 46 live
journey checks apply to the recorded owner candidate; the PR separately verifies
the changed restart boundary and does not present those earlier results as a
new full live run. The subsequently launched daily-chat package includes the
restart correction and passed the packaged recovery probe; its current handoff
and verification record are linked above.
