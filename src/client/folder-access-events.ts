export const folderAccessChangedEvent = 'dot-folder-access-changed';

// This notification carries no authority or grant data. Listeners reload the
// authenticated server record before displaying updated permissions.
export function notifyFolderAccessChanged(dotId: string) {
  window.dispatchEvent?.(
    new CustomEvent(folderAccessChangedEvent, { detail: { dotId } }),
  );
}
