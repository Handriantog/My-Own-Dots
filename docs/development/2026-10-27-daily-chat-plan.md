# Daily chats and grouped calls

User request: stop PR preparation while fixing the conversation list. Chat and Talk from the Dot should use the same date-named conversation for each local day. A voice task must not create another user-facing chat entry.

## Design

- Resolve a daily conversation at the Chat/Talk entry point, scoped to owner, Dot, and the server's local calendar date. Identity is independent of its editable title. Concurrent entry and restarts reuse it. Deleting it creates a new generation on the next entry; restoring an older generation does not replace the newest daily conversation.
- Preserve a live call in its original conversation across midnight. The next entry after the call ends uses the new day. Explicit history, task, page, and saved-message links retain their destinations.
- Keep delegated worker conversations for execution, permissions, history, and direct links. Mark them from durable delegation records and omit them only from conversation navigation/search.
- Render each new call as an expandable transcript item containing canonical messages and its tasks, including later results and approval links. Record host-owned message membership independently of playback. Unmapped historical messages stay visible; do not guess membership from text, timestamps, or ID prefixes, or render cached raw transcripts as fallback.
- Preserve original message IDs, bookmark destinations, worker approval identity, cancellation, suppression/model projection behavior, and custom chat names.
- Do not change the currently running owner test bundle during implementation. No new dependencies. PR preparation remains paused until this change is verified.

## Implementation and verification

1. Storage/API: daily get-or-create (atomic canonical thread and binding for SQLite), durable worker classification, host-only call membership and start anchor, compatible schema migration and archive import. First test date/owner/Dot scope, rename/restart/concurrency/delete/restore, invalid associations, and migrations.
2. Entry/navigation: explicit native Chat intent, daily resolution before Talk starts, stale-response/cancellation guards, active-call preservation, and navigation filtering. Test actual host/preload/React boundaries.
3. Call UI: a single polling task source, call-contained statuses/actions, canonical message grouping, saved-message reveal and existing legacy behavior. Test late results, multiple calls, arbitrary message IDs, empty/failed calls, and more than twenty tasks.
4. Runtime integration: capture host call start and every canonical voice message/receipt, including task receipts after hangup, muted and Basic paths. Test real storage/runtime boundaries, not only helpers.
5. Run focused suites, the full dedicated-database core suite, and macOS verification. Review the complete change, package separately, and launch the verified app for owner testing when computer access permits. Preserve logs and state limitations accurately.

Shared contracts: `Conversation.kind?: 'delegated-task'`; `CallReceipt.messageIds?: string[]` and `afterMessageId?: string | null`; `WorkspaceStore.recordCallMessages(callId, messageIds)` is host-only and append-only; `POST /conversations/daily` takes only `{dotId}`. Existing call records lacking membership keep the legacy receipt layout.

Ruling: this request authorizes implementing the stated daily default; no extra design approval is needed. Existing explicit New chat may still create a separate conversation, while Dot Chat/Talk always resolve the daily conversation.
