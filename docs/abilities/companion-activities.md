# Companion activities

An Ability can supply Dot's movement and body poses as bounded manifest data.
It can optionally attach the real cursor to one hand and hold a scoped system
or display sleep blocker. The package owns its animation and icon; the desktop
owns interpolation, presentation, native input and authority. No Ability ID is
hardcoded into the activity runtime.

This is an additive API-1 capability requiring the updated desktop host. Older
hosts reject the new manifest fields. Current native execution targets macOS
Apple Silicon; fixture verification does not establish live cursor alignment,
hardware sleep behavior or support for other platforms.

## Declare access and animation

Add 1–8 `activities` to the manifest. The
[generated schema](manifest.schema.json) describes the exact fields; the
[host validator](../../src/shared/abilities/activity.ts) also enforces continuity.

| Field        | Meaning                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `id`         | Package-local activity identifier                                                             |
| `durationMs` | One traversal, 1,000–120,000 ms                                                               |
| `approachMs` | Smooth pickup/entry, 250–10,000 ms                                                            |
| `loop`       | Repeat after reaching the final keyframe                                                      |
| `motion`     | Travel width 0–1,200 and height 0–800 logical pixels                                          |
| `keyframes`  | 2–32 ordered frames: `at` from 0 to 1, normalized `x`/`y` from −1 to 1, and a complete `pose` |
| `pointer`    | Optional `{ "hand": "left" or "right", "idleMs": 1000–60000 }`                                |
| `keepAwake`  | Optional `system` or `display`; display also prevents system idle sleep                       |

A pose supplies arm angles (`leftArm`, `rightArm`, −3.2–3.2 radians), arm lengths
(`leftArmLength`, `rightArmLength`, 20–70 logical pixels), `lean` (−0.35–0.35),
`bodyY` (−10–10), and `leftFootY`/`rightFootY` (−12–12). Dot retains its normal
face, speech, gaze and breathing. Reduced motion limits travel. The first frame
must be at 0, the last at 1, and times must increase strictly. Looping endpoints
must have identical position and pose.

Reference the activity from an explicit permission:

```json
{
  "id": "carry",
  "kind": "companion-activity",
  "purpose": "Carry the cursor and keep the screen awake when asked.",
  "activities": ["cursor-carry"],
  "pointer": true,
  "keepAwake": "display"
}
```

The permission must cover every referenced definition's effects. All tools in
the package must declare `execution: "interactive"`; `channels` can allow text,
voice or both. Descriptions should say when the owner must explicitly request
start or stop. Installation and enabling only grant access; they do not activate it.

## Start, inspect and stop

Use short worker calls with the normal [protocol](protocol.md) envelope:

```json
{
  "kind": "companion-activity",
  "ruleId": "carry",
  "command": { "action": "start", "activityId": "cursor-carry" }
}
```

Use `status` or `stop` for the other actions. Replies contain only `ok`, `kind`
and one status: `inactive`, `approaching`, `running` or `paused`. Failures use the
standard fixed error envelope. Workers cannot supply cursor coordinates, inline
code or alternate animation definitions. Keep the successful tool output within
its declared schema; invalid output rolls back a new activation.

There is one active desktop activity. The requesting Dot must be selected on
the desktop, and competing bindings receive `busy`. A start remains provisional
until its worker succeeds with current authority. Once committed, it outlives
that short invocation; a later status call does not acquire its ownership.
Cancellation during activation or result settlement releases the new session.
Repeated start/stop requests are safe and do not create additional sleep blockers.

The session binds the workspace, desktop connection, Dot, package digest and
grant revision. Renewal checks both the workspace installation and per-Dot grant.
Disable, uninstall, disconnect, workspace replacement and Quit stop it. Hiding
or replacing the desktop Dot, locking/suspending, losing the renderer/helper or
changing displays also releases it. There is no automatic replay after reconnect.

## Cursor behavior

Pointer activities require macOS Accessibility permission for the desktop app.
Dot approaches the existing cursor and attaches it to the rendered palm. Native
movement is bounded to the display and checks fresh physical input immediately
before moving. It never emits clicks or key presses. At an extreme display edge,
part of Dot can briefly clip while its hand reaches the cursor, then move inward.

Physical mouse movement, scrolling or a held button releases the cursor. Dot
resumes with a new approach after the package's `idleMs`; Mouse Mover uses 5,000 ms.
The sleep blocker remains active during that temporary pause. Stop releases the
blocker and retires pending movement before reporting completion. It does not
rewind the cursor or change the owner's persistent power settings.

The separate [Ability collection](https://github.com/Handriantog/My-Own-Dot-Abilities)
owns Mouse Mover's worker, path, carrying pose and icons. Future packages using
this contract can be installed without another host-specific animation change.
