# Dot Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the linked plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect existing Dot data, remove Docker from core local storage, support individual Dot transfer, and verify normal and portable desktop distributions on macOS, Windows, and Linux.

**Architecture:** Deliver four ordered stages, each with its own implementation plan and acceptance gate. Back up the current stores before migrating into a SQLite worker; reuse the archive and storage boundaries for Dot transfer and native distributions.

**Tech Stack:** Existing Node 24+, TypeScript, Electron, React, Hono, Vitest, PostgreSQL migration adapter, and Node SQLite; streaming archive/encryption libraries specified in stage 1.

**Spec:** [Approved storage and portability design](storage-portability-design.md).

## Global Constraints

- Preserve selected workspaces and all original databases/volumes during migration.
- Use WAL, foreign-key enforcement, explicit migrations, and `synchronous=FULL` for authoritative writes.
- Preserve event persistence before visible text or speech; imported/restored actions never replay automatically.
- Normal installations use OS data directories; portable distributions keep `workspace/` beside program files, outside bundles and updater-version directories.
- Keep model, prompt, context, voice, and provider-session settings fixed in matched benchmarks.
- Reference workload: at least 10,000 memories and 100,000 messages over 100 threads, including a 1,000-message active conversation.
- Recall/context p95 at most 100/200 ms; foreground persistence p95 at most 25 ms on the reference local SSD.
- First-text/first-playback p50 and p95 increase must not exceed the larger of 5% or 50 ms against the matched baseline, including scheduled backup/maintenance load.
- Measure at least 100 warm turns per case after warmup and repeat in independent processes; hardware audio acceptance is separate.
- Retain seven daily and four weekly successful backups; never delete the only verified backup or user-managed exports.
- Tests use disposable stores and fixture inference. A macOS result cannot establish Windows/Linux or live-provider acceptance.

## Review Focus

- A backup made while an external tool finishes must include both its durable result and associated workspace changes: stage 1, tasks 2–3.
- A live volume disappearing must not cause a new empty workspace to replace the selected one: stage 2, tasks 1 and 7.
- A crash between staged restore and selection switching must preserve a bootable recovery point: stage 1, task 4; stage 2, task 7.
- A memory referencing omitted private evidence must remain unavailable after transfer: stage 3, tasks 1–2.
- A portable application moved across OSes must retain content but require new local permissions and compatible runtimes: stages 3–4.

## Ordered implementation plans

| Stage | Plan                                                                                                     | Independently usable result                                                     |
| ----- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1     | [Backup and recovery](storage-plan-01-backup-recovery.md)                                                | Encrypted, verified recovery of current SQLite/PostgreSQL workspaces            |
| 2     | [Unified storage and migration](storage-plan-02-unified-workspace.md)                                    | Docker-free new workspaces, preserved legacy data, measured chat/voice behavior |
| 3     | [Dot export and import requirements](storage-portability-design.md#individual-dot-transfer)              | Previewed, scoped `.dotpack` transfer into a new Dot                            |
| 4     | [Native platform acceptance requirements](storage-portability-design.md#cross-platform-release-boundary) | Normal and portable builds with native storage/voice evidence per OS            |

Each stage runs its focused tests before the repository checks. Stages 1 and 2 have executable task plans; later task plans will build on their tested interfaces without changing the approved scope. Stage 2 must not flip existing users automatically or ship as default until its migration and performance gates pass. Stage 4 may prepare platform adapters earlier, but it cannot claim product support before native checks pass.

## Execution and integration

- [x] Owner approved continuing with implementation on 2026-10-19. Proceed with native execution and a fresh whole-branch review.
- [ ] At execution time use an isolated worktree/branch; preserve the unrelated `docs/desktop/local-voice-implementation-brief.md` and `vendor/` work in the current checkout.
- [ ] Complete each stage's tasks in order, keeping one independently reviewable commit per task.
- [ ] Run `npm run typecheck`, `npm run lint`, `npm run check-format`, `npm test`, and `npm run build` after each stage. PostgreSQL integration tests must use a dedicated `LOCAL_TEST_DATABASE_URL`; skipped integration suites are not passing evidence.
- [ ] Build the desktop package for the current platform after a stage changes desktop/runtime code. Do not overwrite a running packaged application.
- [ ] Record test counts, commands, platform, benchmark artifacts, and remaining native acceptance in `docs/desktop/storage-verification.md` as implementation proceeds.

Implementation proceeds natively with sequential tasks and one independent whole-branch review. Persist decisions and test evidence in the execution ledger so later stages can resume without repeating completed work.
