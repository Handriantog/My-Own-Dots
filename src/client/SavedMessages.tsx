import { Bookmark, Pin, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { MessageMark, MessageMarkKind } from '../shared/message-marks';

export function SavedMessages({
  threadId,
  marks,
  kind,
  onKind,
  onClose,
  onOpen,
  onRemove,
  busy,
  loading,
}: {
  threadId: string;
  marks: MessageMark[];
  kind: MessageMarkKind;
  onKind(kind: MessageMarkKind): void;
  onClose(): void;
  onOpen(mark: MessageMark): void;
  onRemove(mark: MessageMark, kind: MessageMarkKind): void;
  busy: boolean;
  loading: boolean;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  const pins = marks.filter(
    (mark) => mark.threadId === threadId && mark.pinnedAt !== null,
  );
  const bookmarks = marks.filter((mark) => mark.bookmarkedAt !== null);
  const items = [...(kind === 'pin' ? pins : bookmarks)].sort((a, b) =>
    kind === 'pin'
      ? b.pinnedAt! - a.pinnedAt!
      : b.bookmarkedAt! - a.bookmarkedAt!,
  );
  return (
    <aside className="saved-messages" aria-label="Saved messages">
      <header>
        <strong>Saved messages</strong>
        <button
          className="icon-button"
          ref={closeButton}
          aria-label="Close saved messages"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="saved-message-tabs" aria-label="Message collections">
        <button aria-pressed={kind === 'pin'} onClick={() => onKind('pin')}>
          <Pin size={14} /> Pins <span>{pins.length}</span>
        </button>
        <button
          aria-pressed={kind === 'bookmark'}
          onClick={() => onKind('bookmark')}
        >
          <Bookmark size={14} /> Bookmarks <span>{bookmarks.length}</span>
        </button>
      </div>
      <p className="saved-message-scope">
        {kind === 'pin' ? 'This conversation' : 'All conversations'}
      </p>
      <div className="saved-message-list">
        {loading ? (
          <p role="status">Loading…</p>
        ) : !items.length ? (
          <p className="saved-message-empty">
            {kind === 'pin'
              ? 'No pins yet. Pin a message to keep it handy here.'
              : 'No bookmarks yet. Bookmark a message to find it here later.'}
          </p>
        ) : (
          items.map((mark) => (
            <article key={`${mark.threadId}:${mark.messageId}`}>
              <button
                className="saved-message-link"
                onClick={() => onOpen(mark)}
                title="Jump to message"
              >
                <span>{mark.role === 'user' ? 'You' : mark.dotName}</span>
                <p>{mark.content}</p>
                {kind === 'bookmark' && <small>{mark.threadTitle}</small>}
                <span className="saved-message-jump">Jump to message →</span>
              </button>
              <button
                className="icon-button saved-message-remove"
                disabled={busy}
                aria-label={
                  kind === 'pin' ? 'Unpin message' : 'Remove bookmark'
                }
                title={kind === 'pin' ? 'Unpin message' : 'Remove bookmark'}
                onClick={() => onRemove(mark, kind)}
              >
                <X size={14} />
              </button>
            </article>
          ))
        )}
      </div>
    </aside>
  );
}
