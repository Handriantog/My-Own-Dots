# Codex reliability test handoff

The final app is open with the existing owner workspace, selected Dot and installed Abilities preserved. This is a local candidate for owner acceptance, not a public release.

## What changed

- Text and High voice use the same Codex task engine, permissions and saved outcomes.
- Choosing another folder during approval changes the target. Running project commands requires the explicit **Read, edit and run commands** grant.
- Voice requests can queue while a typed task is busy. Status and task cancellation remain available; interrupting speech does not silently cancel work.
- High speech stays local: LFM recognition and the installed macOS Samantha voice. Reasoning uses the existing Codex subscription; no paid API fallback was added.
- Interrupted or disconnected execution is reported honestly and is not automatically replayed. Runtime diagnostics identify the build and permitted capabilities.

## Candidate

App: `release-codex-20261025-natural/My Own Dots-darwin-arm64/My Own Dots.app` in the reliability worktree. Source SHA-256: `42628d354b4462c4194376eb82339659dc012ff3a8f66d0629ae0bd23004ab4d`. Codex CLI `0.163.0`; installed Integrator `0.3.0-rc.1` from the pinned vendored archive. The final owner launch verified High voice readiness, schema 6, both installed Ability bindings and a healthy renderer.

Automated verification: 2,497 core tests passed (one existing signing-identity skip), 77 Python tests, formatting/lint/types/build, and native macOS acceptance (635 tests plus two 14-probe Python profiles). The final package passed relocated signature/Ability smoke and two clean startup/shutdown cycles with SQLite persistence. Live qualification includes 60/60 folder checks, 30/30 stronger debugging-contract checks, cross-channel continuation and final full-call interruption/recovery. Ability blocker retests passed after a retained test-oracle correction. The qualification record separates the original matrix, failed fixture attempts and retests; these are not an independent universal success-rate estimate.

The owner-discovered schema conversion failure is corrected in this build. Six affected packaged task cases passed with the desktop browser tool enabled, covering text and local voice. The original package probe failed on the unchanged offline Spotify helper; its unchanged rerun passed. Exact evidence is in `artifacts/codex-execution/schema-fix-handoff.json`. You can retry the message that failed schema conversion: that error occurred before provider/task execution.

## Voice correction in this build

Automatic “Received” acknowledgements are removed, including when a request queues behind typed work. Dot waits for the actual answer and includes it in the call transcript. Updates wait for native warmup, and interrupting while a reply is saved cannot restart stale speech. The packaged three-turn local call passed, including thanks and a follow-up after interruption. No physical microphone or speaker was used in that check.

Start with a greeting, a simple question and “Thank you.” Expect substantive answers without a repeated acknowledgement. Speech remains local and uses Samantha; emotional delivery is not restored by this change. The isolated live run took 4.5–5.9 seconds from transcript to first audio, so conversational response speed still needs improvement.

## Start testing

Use a **new conversation** with your selected desktop Dot, with voice quality set to **High**. Existing chat history is preserved; historical result cards may have expired and are not evidence of the new build's state.

1. Ask by voice: “Turn on Mouse Mover.” Check the pointer itself, then ask whether it is running and tell it to stop. Manual mouse use can pause it until you leave the mouse idle. A missing OS permission must produce a blocker, not a success claim.
2. Ask: “Inspect a project; let me choose the folder.” Verify the exact path and access before approval. Change the proposed folder and confirm Dot continues with your selection.
3. Use the disposable debugging project at `.worktrees/dot-runtime-reliability/artifacts/codex-execution/owner-test-project` under the primary Dots checkout. Ask: “Read this project's README, reproduce the failing check, fix the whole-minutes calculation, and rerun the unchanged check.” Grant that folder **Read, edit and run commands**. It intentionally returns two minutes for 119 seconds; the corrected check must pass all three cases.
4. Follow up in text: “What did you change and what tests passed?” Then continue by voice. Try another request while a task runs, “Are you still working?”, and “Please stop the current task.” A stop can leave completed actions in place; inspect the recorded result before retrying.
5. Interrupt a spoken answer, then ask another question. Old audio should not resume, and the next utterance should still work.

## macOS permission step

The locally signed rebuild currently lacks **Accessibility** permission. macOS can require consent again when an ad-hoc signed app changes. Mouse Mover cannot run until **System Settings → Privacy & Security → Accessibility** allows this newly opened My Own Dots build. An older allowed entry does not establish permission for the new code. Do not mistake installation or an enabled Ability switch for this OS permission.

The candidate reports this prerequisite through a fixed host-owned reason. It does not alter macOS permissions or grant project access automatically. A stable signing identity is a separate development/distribution task that can reduce rebuild-related consent resets.

## Practical limits

Ordinary conversation and tasks consume the existing Codex allowance and need its network connection. The qualified CLI is 0.163.0; incompatible upgrades stop explicitly. Native project commands are restricted to approved scope and have no network access, so projects needing downloads or unavailable system files can be blocked. Long tasks queue ordinary conversation on the same Dot.

Recognition can mishear exact names. Review the displayed folder, and correct the transcript or target when necessary. The complete answer and technical details remain in chat; speech uses a bounded excerpt. The provisional microphone-to-speaker latency targets are not yet established.

Automated checks use synthetic speech and disposable projects. Physical microphone/speaker quality, Mouse Mover effects, Spotify effects and macOS permission attribution need this owner test. Other providers, legacy local conversation, wake words and automatic self-deployment are outside this candidate's qualification.

## Recovery

The pre-upgrade app, complete schema-5 workspace and profile settings are saved privately at `artifacts/codex-execution/owner-recovery-20261025` in the reliability worktree. Its `recovery.json` records the exact original paths, and the backup database passed a read-only integrity check. The old app also remains at the original `release/` path.

To return: quit Dot; preserve the upgraded workspace by renaming it; restore the backup workspace to its original path; restore the saved profile JSON; launch the old app. Do not open the upgraded schema-6 database with the old app. Preserving the upgraded folder keeps any conversations created during testing available for later recovery.

See [qualification](codex-execution-qualification.md) for evidence, failed attempts and limitations, and [development rules](agent-reliability.md) for future changes. Exact build, archive checksum, evidence paths and owner startup results are retained in `artifacts/codex-execution/handoff-manifest.json`.
