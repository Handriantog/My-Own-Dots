# Spotify Local

Spotify Local is a separate Ability from the Spotify Web API worker. It uses the
Spotify desktop app signed in on this Mac. No developer app, client ID, OAuth
connection or Web API request is needed. The first supported target is macOS 26
Apple Silicon with Spotify in English. There is no published release yet.

## Install a local package

In **Abilities** in the sidebar below Memory, open **+ (Add Ability) → Choose local Ability…** and select the
JSON descriptor beside its matching archive. Select **Install** in its detail
header, then review the publisher, permissions
and actual package/private-state folders, then choose **Install**. Choosing a file
reads and hashes a bounded snapshot; it does not extract or execute the archive.
Install uses those reviewed bytes even if the original files later change. The
local limit is 16 MiB compressed; reviews expire after ten minutes. The host keeps
at most four local snapshots and clears them when its session ends.

After installation, choose **Enable**, then **Apply to all Dot** or enable it for
one Dot in that Dot’s settings. The master switch preserves individual selections;
“Apply to all Dot” affects existing Dots only. If the host disconnects, use
**Reconnect**. Recovery never retries an interrupted Spotify action.

For GitHub distribution, publish the same descriptor and archive as release
assets and use the release link. A development descriptor is for local testing;
its placeholder asset ID does not identify a published download.

## Access and behavior

Playback requires macOS **Automation → My Own Dots → Spotify**. Search and library
operations also require **Accessibility → My Own Dots**. These OS permissions are
separate from each Dot's Ability consent. Source builds may appear under Electron
or their development app name; ad-hoc re-signing can invalidate previous grants.
A missing grant blocks control. Use System Settings to enable only the app you
intend to run; the host does not change OS permissions itself.

The host accepts only `com.spotify.client` and the enumerated actions in
[the command schema](../../src/shared/abilities/app-control.ts). Workers cannot
supply scripts, keyboard shortcuts, screen coordinates, app IDs or executables.
UI operations use short-lived, host-owned Accessibility sessions. They can bring
Spotify forward, reject ambiguous controls, and stop when the app/window changes.
The private helper protocol never reaches Ability workers.

- Playback: play, pause, next, previous, volume, seek, shuffle, repeat and a
  supplied track/album/playlist link.
- Search: track or playlist choices shown in private owner cards. Link/URI search
  queries are rejected because Spotify may interpret them as immediate playback.
- Library: currently loaded/visible playlists, save the current song, create a
  private playlist, and add a privately selected recording to a named playlist.
  Duplicate destination names are rejected. Playlist listing is not a full
  account inventory and does not expose playlist IDs.

Creating a playlist first creates Spotify's empty default-named playlist with
its default visibility, then sets its name and makes it private. An interrupted
operation can leave that empty playlist behind. Check Spotify before retrying.
The host does not automatically retry mutations. An uncertain outcome means the
change may have happened without a confirmed receipt.

While a Dot with approved Spotify volume control speaks in a local voice call,
Spotify temporarily drops to 25% of its current app volume. The original level
returns after speech, interruption, speaker mute, call end or Dot quitting. A
short pause between audio frames does not repeatedly lower it. Manual Spotify
volume changes detected while lowered take precedence. System volume stays unchanged. This requires
existing Automation access; automatic ducking never asks for new OS permission.
The lease tracks Spotify's confirmed lowered level and corrects a one-point
restore difference only when it matches the rounding observed while lowering.
Spotify volume reads and writes are separate operations; a simultaneous manual
adjustment during that brief readback window cannot always be distinguished from
rounding.
If Spotify stops responding or access is revoked, restoration is best effort.

All Dots share the currently signed-in Spotify account and player. Disable and
Quit stop owned work; they do not quit Spotify or undo completed changes. Avoid
manually changing Spotify's view while a command is running. Unsupported locales
or changed layouts produce a blocked/uncertain result rather than a guessed click.

Provider metadata stays in private owner cards; only status and opaque references
reach inference and chat history. Your own requests still follow your configured
AI provider and storage. Text and voice are technically admitted for this local
Ability; this is not a claim of exemption from Spotify terms or of Spotify
approval. The separate Web API Ability remains text-only.

See [verification](../desktop/abilities-verification.md) for fixture and live
coverage. The host implementation does not grant general desktop control to
third-party workers.

Spotify app-control permissions require every tool in the Ability to be
`owner-only`. The host rejects mixed visibility during review and execution,
including previously bound packages, because workers can retain private results
between calls. This boundary covers model tool results; separately approved HTTPS
grants still authorize their declared network requests.
