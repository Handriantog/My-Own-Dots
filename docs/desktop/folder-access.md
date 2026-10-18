# Folder access from a conversation

In the desktop companion, ask your Dot to work with a local folder—for example, “Read the notes in my work folder.” If it needs access, it can open a folder-access request in the conversation.

1. Read the request and click **Choose folder**. The native chooser lets you select the actual folder; the model cannot choose it for you.
2. Review the selected path and choose **Read only** or **Read and write**. Read only is the default. Choosing a folder alone grants nothing.
3. Click **Approve folder access**, or decline. The same conversation continues with the saved decision. During a voice call, the call view minimizes for review and waits for the approval result.

Open **Folder access** in Chat to see approved folders and **Revoke** access. Grants are saved for the selected Dot and survive restarts. Other Dots do not inherit them. A pending request belongs to its original conversation and expires after one hour; an expired request can still be declined to continue the conversation. If the conversation response is interrupted after a decision was saved, **Continue conversation** rechecks that decision with the server without granting again. A revoked grant remains revoked.

## Scope

The first version supports listing up to 200 directory entries and reading or editing UTF-8 text files up to 64 KiB. Paths are relative to a grant. Reading a file returns its hash; edits check that hash before replacing it. Creating a file requires the `new` sentinel and fails if the name already exists. There are no folder tools for shell commands, deletion, directory creation, recursive scans, or binary files.

Dot writes coordinate across overlapping grants and helper processes, so competing Dot edits cannot both replace the same file using a stale hash. The hash check does not lock other applications: an external editor can still change a file between the final check and replacement. Avoid simultaneous edits to the same file in another application when asking the Dot to edit it.

The selected folder's filesystem identity is recorded. Operations use directory descriptors and refuse symlinks, hardlinks, special files, path traversal, and replacement of the approved root. Writes use temporary files and replacement within the selected directory. Revocation blocks subsequent operations and cancels running helpers. It does not undo a write that already completed or remove file content already included in conversation history. File text used for reasoning goes through the same selected AI provider as the rest of the conversation.

Selection and approval endpoints retain the workspace's owner-token and origin checks and require a loopback workspace. The native chooser is available only to the companion's trusted main chat frame after a user click. It accepts no model-supplied path or dialog options. Browser-only chat can decline an existing request but cannot open the native chooser. Folder tools are offered only in an interactive chat that advertises the approval card; channel and headless runs do not acquire host-folder tools.

## Runtime and operating-system permissions

The workspace uses a small standard-library Python helper; it installs no packages or models. Python 3.11+ is already required for the subscription setup. Set `DOTS_FOLDER_PYTHON` to an absolute Python interpreter path if `python3` is unavailable, and restart the workspace. The helper is `scripts/folder-access.py` in the workspace checkout; the desktop app still connects to that separately running workspace.

Folder approval is an application permission, not a bypass of macOS protections. Protected folders may also need permission for the process running the workspace. An inaccessible folder returns an error instead of silently widening access. Neither the model nor the approval endpoint grants itself macOS permissions.

## Verification

Automated checks use temporary folders, fixture provider replies, mocked native dialogs, and synthetic approval decisions. They cover request/selection/approval separation, replay and scope checks, denial, expiry, persistence, revocation, path boundaries, hash-checked edits, native frame validation, and continuation of a governed voice/chat turn. Agent checks do not open the owner's real folder chooser or read a real work folder.
