import { Fragment, useEffect, useRef, useState } from 'react';
import {
  Check,
  ArrowLeft,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { Conversation, ConversationUpdate, Dot } from '../shared/types';
import { DeletedChatRow } from './DeletedChatRow';

type UpdateConversation = (
  id: string,
  patch: ConversationUpdate,
) => Promise<void>;

export function ThreadList({
  dots,
  local,
  selected,
  onSelect,
  onUpdate,
  deleted,
  onDelete,
  onRestore,
}: {
  dots: Dot[];
  local: Conversation[];
  selected?: string;
  onSelect: (id: string) => void;
  onUpdate: UpdateConversation;
  deleted: Conversation[];
  onDelete: (id: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [trash, setTrash] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusAfterRemoval = (row: HTMLElement | null) => {
    if (
      row &&
      (row.contains(document.activeElement) ||
        (!row.isConnected && document.activeElement === document.body))
    )
      searchRef.current?.focus();
  };
  const needle = query.trim().toLocaleLowerCase();
  const dotNames = new Map(dots.map((dot) => [dot.id, dot.name]));
  const matches = (trash ? deleted : local)
    .filter((thread) => thread.kind !== 'delegated-task')
    .filter((thread) =>
      `${thread.title} ${dotNames.get(thread.dotId) ?? ''}`
        .toLocaleLowerCase()
        .includes(needle),
    )
    .sort(
      (a, b) =>
        (trash ? (b.deletedAt ?? 0) - (a.deletedAt ?? 0) : 0) ||
        Number(b.pinnedAt != null) - Number(a.pinnedAt != null) ||
        (b.pinnedAt ?? b.createdAt) - (a.pinnedAt ?? a.createdAt) ||
        a.id.localeCompare(b.id),
    );

  return (
    <section className="thread-list" aria-label="Chats">
      <div className="chat-list-search">
        <Search size={15} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          aria-label="Search chats"
          placeholder={trash ? 'Search Trash…' : 'Search chats…'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.stopPropagation();
              setQuery('');
            }
          }}
        />
        {query && (
          <button
            type="button"
            aria-label="Clear chat search"
            onClick={() => {
              setQuery('');
              searchRef.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="chat-list-scroll">
        <ul className="chat-thread-list">
          {trash && <li className="chat-list-label">Trash</li>}
          {matches.map((thread, index) => {
            if (trash)
              return (
                <DeletedChatRow
                  key={thread.id}
                  thread={thread}
                  onRestore={async (id, row) => {
                    await onRestore(id);
                    focusAfterRemoval(row);
                  }}
                />
              );
            const pinned = thread.pinnedAt != null;
            const heading =
              index === 0 || pinned !== (matches[index - 1].pinnedAt != null);
            return (
              <Fragment key={thread.id}>
                {heading && (
                  <li className="chat-list-label">
                    {pinned ? (
                      <>
                        <Pin size={12} aria-hidden="true" /> Pinned
                      </>
                    ) : (
                      'Recent'
                    )}
                  </li>
                )}
                <ThreadRow
                  thread={thread}
                  dotName={dotNames.get(thread.dotId)}
                  selected={selected === thread.id}
                  onSelect={onSelect}
                  onUpdate={async (id, patch, row) => {
                    await onUpdate(id, patch);
                    if (query) focusAfterRemoval(row);
                  }}
                  onDelete={async (id, row) => {
                    await onDelete(id);
                    focusAfterRemoval(row);
                  }}
                />
              </Fragment>
            );
          })}
        </ul>
        {!matches.length && (
          <p className="chat-list-empty" role="status">
            {needle
              ? 'No chats found'
              : trash
                ? 'Trash is empty.'
                : 'Your chats will appear here.'}
          </p>
        )}
      </div>
      <button
        className="chat-trash-toggle"
        aria-label={trash ? 'Back to chats' : 'Open chat Trash'}
        onClick={() => {
          setTrash(!trash);
          setQuery('');
        }}
      >
        {trash ? <ArrowLeft size={14} /> : <Trash2 size={14} />}
        {trash ? 'Back to chats' : 'Trash'}
        {!trash &&
          deleted.some((thread) => thread.kind !== 'delegated-task') && (
            <span>
              {
                deleted.filter((thread) => thread.kind !== 'delegated-task')
                  .length
              }
            </span>
          )}
      </button>
    </section>
  );
}

function ThreadRow({
  thread,
  dotName,
  selected,
  onSelect,
  onUpdate,
  onDelete,
}: {
  thread: Conversation;
  dotName?: string;
  selected: boolean;
  onSelect: (id: string) => void;
  onUpdate: (
    id: string,
    patch: ConversationUpdate,
    row: HTMLElement | null,
  ) => Promise<void>;
  onDelete: (id: string, row: HTMLElement | null) => Promise<void>;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const restoreFocus = useRef(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const actionsRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  useEffect(() => {
    if (renaming) {
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [renaming]);
  useEffect(() => {
    if (!saving && !renaming && !deleting && restoreFocus.current) {
      restoreFocus.current = false;
      actionsRef.current?.focus();
    }
  }, [saving, renaming, deleting, menu]);
  const dismiss = () => {
    if (pending.current) return;
    restoreFocus.current = true;
    setMenu(false);
    setRenaming(false);
    setDeleting(false);
    setError('');
  };
  const remove = async () => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      await onDelete(thread.id, rowRef.current);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not delete this chat. Try again.',
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const save = async (patch: ConversationUpdate) => {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      await onUpdate(thread.id, patch, rowRef.current);
      restoreFocus.current =
        rowRef.current?.contains(document.activeElement) ?? false;
      setMenu(false);
      setRenaming(false);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not save this chat. Try again.',
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const pinned = thread.pinnedAt != null;
  return (
    <li
      ref={rowRef}
      className={`chat-thread${selected ? ' active' : ''}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && (menu || renaming || deleting)) {
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <div className="chat-thread-main">
        <button
          className="chat-thread-link"
          aria-label={thread.title}
          aria-current={selected ? 'page' : undefined}
          title={thread.title}
          onClick={() => onSelect(thread.id)}
        >
          <span className="chat-thread-title">{thread.title}</span>
          {dotName && <span className="chat-thread-dot">{dotName}</span>}
        </button>
        <button
          ref={actionsRef}
          className="chat-thread-actions"
          aria-label={`Chat actions for ${thread.title}`}
          title="Chat actions"
          aria-expanded={menu}
          disabled={saving || renaming || deleting}
          onClick={() => {
            setMenu(!menu);
            setError('');
          }}
        >
          <MoreHorizontal size={17} />
        </button>
      </div>
      {menu && !renaming && (
        <div
          className="chat-thread-menu"
          role="group"
          aria-label={`Actions for ${thread.title}`}
        >
          <button
            aria-label="Rename chat"
            aria-disabled={saving}
            onClick={() => {
              if (pending.current) return;
              setDraft(thread.title);
              setMenu(false);
              setRenaming(true);
              setError('');
            }}
          >
            <Pencil size={13} />
            Rename
          </button>
          <button
            aria-label={pinned ? 'Unpin chat' : 'Pin chat'}
            aria-disabled={saving}
            onClick={() => void save({ pinned: !pinned })}
          >
            {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            {pinned ? 'Unpin' : 'Pin chat'}
          </button>
          <button
            className="chat-delete-action"
            aria-label="Delete chat"
            aria-disabled={saving}
            onClick={() => {
              if (pending.current) return;
              setMenu(false);
              setDeleting(true);
              setError('');
            }}
          >
            <Trash2 size={13} />
            Delete chat
          </button>
        </div>
      )}
      {deleting && (
        <div
          className="chat-delete-confirm"
          role="group"
          aria-label={`Delete ${thread.title}`}
        >
          <p>Move this chat to Trash? You can restore it later.</p>
          <div className="chat-rename-buttons">
            <button
              aria-label="Cancel delete"
              aria-disabled={saving}
              onClick={dismiss}
              autoFocus
            >
              Cancel
            </button>
            <button
              className="chat-delete-action"
              aria-label="Move to Trash"
              aria-disabled={saving}
              onClick={() => void remove()}
            >
              {saving ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      )}
      {renaming && (
        <form
          className="chat-rename"
          aria-label="Rename chat"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) void save({ title: draft.trim() });
          }}
        >
          <input
            ref={nameRef}
            aria-label="Chat name"
            value={draft}
            maxLength={120}
            readOnly={saving}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="chat-rename-buttons">
            <button
              type="button"
              aria-label="Cancel rename"
              aria-disabled={saving}
              onClick={dismiss}
            >
              <X size={13} />
              Cancel
            </button>
            <button
              type="submit"
              aria-label="Save name"
              disabled={!draft.trim()}
              aria-disabled={saving}
            >
              <Check size={13} />
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="chat-list-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
