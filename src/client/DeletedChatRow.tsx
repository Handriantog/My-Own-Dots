import { useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { Conversation } from '../shared/types';

export function DeletedChatRow({
  thread,
  onRestore,
}: {
  thread: Conversation;
  onRestore: (id: string, row: HTMLElement | null) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const rowRef = useRef<HTMLLIElement>(null);
  const restore = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await onRestore(thread.id, rowRef.current);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not restore this chat. Try again.',
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <li ref={rowRef} className="chat-thread chat-deleted-thread">
      <div className="chat-thread-main">
        <span className="chat-thread-link" title={thread.title}>
          <span className="chat-thread-title">{thread.title}</span>
        </span>
        <button
          className="chat-thread-actions"
          aria-label={`Restore ${thread.title}`}
          title="Restore chat"
          aria-disabled={saving}
          onClick={() => void restore()}
        >
          <RotateCcw size={15} />
        </button>
      </div>
      {error && (
        <p className="chat-list-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
