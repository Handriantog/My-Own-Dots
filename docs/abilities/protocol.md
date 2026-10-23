# Ability worker protocol — API 1

Optional manifest activities, package-owned icons and interactive-only tools are
additive API/format version 1 fields. Workers still initialize with API version 1.
These capabilities require an updated host: older hosts reject the unfamiliar
manifest fields rather than granting partial access. JSON Schema validates field
shapes; the host also validates path geometry, keyframe continuity and grants.

Use UTF-8, newline-delimited JSON-RPC 2.0 on stdin/stdout. Each frame is at most
1 MiB including all content; stdout is protocol only. Diagnostics on stderr are
bounded by the host. IDs are strings of 1–128 ASCII letters, digits, underscores,
or hyphens. Unknown fields/methods, malformed JSON, invalid responses, or repeated
IDs terminate the invocation. No dynamic tool discovery is supported.

The host first sends:

```json
{
  "jsonrpc": "2.0",
  "id": "init-1",
  "method": "initialize",
  "params": { "apiVersion": 1 }
}
```

Reply with `{"jsonrpc":"2.0","id":"init-1","result":{"apiVersion":1}}`.
An invocation then supplies only the manifest tool ID, validated arguments,
nonsecret settings, and optional private selection data resolved by the desktop:

```json
{
  "jsonrpc": "2.0",
  "id": "invoke-1",
  "method": "invoke",
  "params": {
    "tool": "search",
    "arguments": { "query": "a song" },
    "settings": { "clientId": "public-client-id" }
  }
}
```

Do not expect a transcript, owner environment, tokens, or access to the backend.
Workspace/session/Dot/binding/digest/grant revision/thread/invocation identity
remain host-bound authority. Worker-supplied identity fields are rejected. One
invocation runs per binding; up to eight wait, and four workers including helpers
may be active. Every helper shares the 60-second invocation deadline.

Each worker may have at most 16 capability requests outstanding and send at most
2,048 protocol frames during one invocation. Exceeding either ceiling closes the
worker; batch work or use another invocation. Cancellation and the main worker's
final result end helper authority immediately, before process shutdown finishes.

## Capability calls

While an invocation is active, a worker can send a request with a unique ID:

```json
{
  "jsonrpc": "2.0",
  "id": "http-1",
  "method": "capability",
  "params": {
    "kind": "https",
    "ruleId": "search",
    "pathValues": { "itemId": "item123" },
    "query": { "q": "a song" }
  }
}
```

HTTPS parameters are `kind`, `ruleId`, `pathValues`, `query`, and optional `body`.
All must satisfy the named manifest rule; there are no arbitrary URLs or headers.
A response has the same ID and a `result` of:

```json
{
  "ok": true,
  "kind": "https",
  "status": 200,
  "headers": { "contentType": "application/json" },
  "body": "{\"items\":[]}"
}
```

Only `contentType` and `retryAfter` headers are permitted. Body is a bounded UTF-8
string, at most 1 MiB; empty successful responses are valid. A broker failure is
`{"ok":false,"code":"permission_denied"}` (or another fixed code below).
HTTP calls have a 30-second limit and cannot outlive the invocation. Non-2xx
provider responses are still HTTP responses; never expose their raw bodies to AI
through an owner-only tool. Credentials are injected by the host, never returned.

Other requests use the same envelope:

- Companion activity: `{"kind":"companion-activity","ruleId":"motion","command":{"action":"start","activityId":"orbit"}}`.
  Actions are `start`, `stop` and `status`. A successful reply is
  `{"ok":true,"kind":"companion-activity","status":"running"}`; status is
  `inactive`, `approaching`, `running` or `paused`. The named permission must
  reference the manifest's bounded activity definition and grant its pointer and
  keep-awake effects. Desktop activity tools require an explicit owner turn;
  workers cannot supply trusted interactive authority or inline motion code.
  A start is provisional until the worker returns a valid successful result and
  authority is checked again. A successful activity then survives worker exit;
  failed or canceled activation releases it. Later status calls do not take
  ownership of an existing session. Stop waits for native pointer retirement.
  See [companion activities](companion-activities.md) for lifetime and limits.

- App control: `{"kind":"app-control","ruleId":"playback","command":{"action":"pause"}}`.
  The command must match the named permission's allowed actions. Result is
  `{"ok":true,"kind":"app-control","status":"success"}` or `status:"uncertain"`,
  with an optional private `result` using the owner presentation schema below.
  Failures use the fixed error envelope. See [Spotify Local](spotify-local.md)
  and the [strict command schema](../../src/shared/abilities/app-control.ts).
  App commands are serialized across Dots, with up to eight queued. Authority is
  checked again immediately before dispatch and after the reply. Cancellation
  kills owned helpers; a delivered mutation can still have happened.
- Account presence: `{"kind":"account","accountId":"account"}`. Result is
  `{"ok":true,"kind":"account","connected":true,"handle":"HOST-UUID"}`,
  or `connected:false` without a handle. This cannot start browser sign-in.
- Helper: `{"kind":"helper","helperId":"parser","arguments":{}}`. Result is
  `{"ok":true,"kind":"helper","value":null}` with validated helper data, or
  the fixed failure envelope. It cannot choose a runtime/system executable.

A helper uses the same `initialize` and `invoke` handshake. Its `tool` is the
declared helper ID, `arguments` must match the helper schema, and `settings` are
the current binding's nonsecret settings. The host returns its bounded JSON
`value` to the requesting worker. Helpers receive no owner selection or tokens.

## Worker results and owner-only data

HTTPS replies must be UTF-8 and fit both the 1 MiB response ceiling and the
protocol frame ceiling after JSON encoding. The host requests identity encoding
and rejects compressed responses before decompression. Query strings are URL
encoded; nonstring query values use their JSON representation. Request bodies
use JSON and are unavailable for GET rules. Redirects are never followed, and
cookies, authorization, and unrecognized response headers are not forwarded.

Reply to `invoke` with `result` containing exactly one of these shapes:

| Status             | Fields beyond `status`                  |
| ------------------ | --------------------------------------- |
| `success`          | optional `owner`, optional `value`      |
| `selection_needed` | required `owner`                        |
| `uncertain`        | optional `owner`                        |
| `error`            | required fixed `code`, optional `owner` |

`owner` is either `{ "kind":"text", "text":"...", "attribution":"Spotify" }`
or `{ "kind":"list", "title":"...", "items":[...], "attribution":"Spotify" }`.
Attribution is optional. List items contain `label`, optional `detail`, optional
HTTPS `url`, and optional private JSON-object `action`. There are at most 100 items;
text is at most 16,384 characters, labels 1,000, details 2,000, title 1,000, and
attribution 100. HTML/scripts are never rendered. URLs are separately validated;
credentials, fragments, non-HTTPS URLs, and literal-IP links are rejected.

For `owner-only` tools, `value` never reaches the model. Display data and action
data remain in desktop memory for at most ten minutes, are cleared on disconnect,
and are excluded from history, logs, backups, memory, embeddings, AI speech, and
inference. The host replaces them with fixed status and optional UUID `resultRef`;
selection-needed requires that reference. Only the host mints references and binds
them to source/digest/Dot/account/revision/expiry. A later model call can supply an
opaque selection reference, but receives none of the action or display metadata.

For explicitly `model-visible` tools, the host validates `value` against the tool's
output schema before returning `{ "status":"success", "visibility":"model-visible",
"value":... }`. This is separate from the owner-only envelope. The worker cannot
change a tool's declared visibility in its response.

## Errors, cancellation, and shutdown

Fixed codes are `permission_denied`, `setup_needed`, `host_unavailable`,
`unsupported_platform`, `timeout`, `invalid_response`, `rate_limited`,
`provider_error`, `busy`, and `cancelled`. No author-defined error codes or
model-facing error messages are accepted. A JSON-RPC failure may return
`{"jsonrpc":"2.0","id":"invoke-1","error":{"code":"provider_error"}}`.

Cancel notification: `{"jsonrpc":"2.0","method":"cancel","params":{"id":"invoke-1"}}`.
Shutdown notification: `{"jsonrpc":"2.0","method":"shutdown","params":{}}`.
Neither needs an acknowledgment. Authority is revoked before delivery; cooperating
with shutdown does not grant extra time or capabilities. After two seconds the
host kills and reaps remaining workers. Desktop death, disconnect, disable, and
workspace replacement also revoke authority. Closing/hiding a workspace window
does not end ordinary workers. Companion activities additionally stop when the
desktop Dot is hidden or replaced, on lock/suspend, and on renderer/helper loss.
Native watchdog leases expire after three seconds without an authorized renewal;
they still work when the desktop event loop is frozen. Expiry starts the same
two-second TERM/KILL cleanup. The native watchdog also caps execution at sixty
seconds; helpers cannot extend their parent's deadline.

After an unexpected connection loss, the desktop makes one delayed attempt to
establish a fresh host session. Recovery identifies its previous session and
cannot replace a different active desktop. Suspend or Quit cancels the attempt;
further failures require explicit reconnection. No invocation is replayed.

Do not automatically retry a mutation after a timeout/disconnect: it may have
reached the provider. Return `uncertain` when the effect cannot be established.
An external player such as Spotify is not an Ability-owned process; stopping the
Ability does not stop that player or its music.

Host authentication refresh is not a worker capability. The host may refresh an
expired credential proactively or refresh once after a confirmed HTTP 401 and
retry the same approved request once. It rechecks current authority and keeps
both credentials private. It does not retry timeout, unknown delivery or 5xx
mutations. A second 401 is returned for the worker to request reconnection.

Optional tool `channels` and manifest `notices` are declared in the reviewed
manifest. Channel identity and required notice acceptance are host-owned; neither
is a worker-supplied protocol field.

Spotify app-control permissions require every tool in the Ability to be
`owner-only`. The host rejects mixed visibility during review and execution,
including previously bound packages, because workers can retain private results
between calls. This boundary covers model tool results; separately approved HTTPS
grants still authorize their declared network requests.
