import { useEffect, useRef, useState } from 'react';
import type { MemoryItem, MemoryScope, SourceRef } from '../shared/memory';
import { api } from './api';
export interface MemoryScopes {
  dots?: { id: string; name: string }[];
  spaces?: { id: string; name: string }[];
}
export const scopeValue = (scope: MemoryScope) =>
  scope.kind === 'owner' ? 'owner' : `${scope.kind}:${scope.id}`;
export const parseScope = (value: string): MemoryScope =>
  value === 'owner'
    ? { kind: 'owner' }
    : {
        kind: value.startsWith('dot:') ? 'dot' : 'space',
        id: value.slice(value.indexOf(':') + 1),
      };
export function ScopeOptions({ dots = [], spaces = [] }: MemoryScopes) {
  return (
    <>
      <option value="owner">All permitted Dots</option>
      {dots.map((d) => (
        <option key={d.id} value={'dot:' + d.id}>
          {d.name} only
        </option>
      ))}
      {spaces.map((s) => (
        <option key={s.id} value={'space:' + s.id}>
          Space: {s.name}
        </option>
      ))}
    </>
  );
}
interface Details {
  item: MemoryItem;
  revisions: MemoryItem[];
  sources: { ref: SourceRef; text: string | null }[];
}
export function MemoryDetails({
  id,
  onChanged,
  onClose,
  dots,
  spaces,
}: { id: string; onChanged: () => void; onClose: () => void } & MemoryScopes) {
  const [details, setDetails] = useState<Details>(),
    [title, setTitle] = useState(''),
    [text, setText] = useState(''),
    [sharing, setSharing] = useState('owner'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<Details>(
      `/memory-items/${encodeURIComponent(id)}`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((d) => {
        if (controller.signal.aborted) return;
        setDetails(d);
        setTitle(d.item.title);
        setText(d.item.text);
        setSharing(scopeValue(d.item.scope));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [id]);
  useEffect(() => {
    if (details) heading.current?.focus();
  }, [!!details]);
  const change = async (path: string, method: string, patch: unknown) => {
    if (!details || busy) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api<MemoryItem>(
        `/memory-items/${encodeURIComponent(id)}${path}`,
        method,
        { expectedRevision: details.item.revision, ...(patch as object) },
      );
      if (updated.id)
        setDetails({
          ...details,
          item: updated,
          revisions: [...details.revisions, updated],
        });
      onChanged();
      if (path === '/forget') onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Memory could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  if (!details)
    return (
      <section className="memory-details">
        {error ? <p role="alert">{error}</p> : <p>Loading memory…</p>}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </section>
    );
  const item = details.item;
  return (
    <section className="memory-details" aria-label="Memory details">
      <div className="memory-actions">
        <h2 ref={heading} tabIndex={-1}>
          Memory details
        </h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted">
        {item.kind === 'skill' ? 'Procedure' : 'Fact'} · {item.status} ·
        Revision {item.revision}
      </p>
      <label>
        Title
        <input
          aria-label="Memory title"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Memory
        <textarea
          aria-label="Memory text"
          value={text}
          maxLength={
            item.kind === 'skill' ? 12000 : Math.max(2000, item.text.length)
          }
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="memory-actions">
        <button
          type="button"
          aria-label="Save memory correction"
          disabled={busy || !text.trim() || !title.trim()}
          onClick={() => void change('', 'PATCH', { patch: { title, text } })}
        >
          Save correction
        </button>
        <button
          type="button"
          aria-label={item.pinned ? 'Unpin memory' : 'Pin memory'}
          disabled={busy || item.status !== 'active'}
          onClick={() =>
            void change('', 'PATCH', { patch: { pinned: !item.pinned } })
          }
        >
          {item.pinned ? 'Unpin' : 'Pin as essential'}
        </button>
        {item.status === 'pending' && (
          <>
            <button
              type="button"
              aria-label="Approve memory"
              disabled={busy}
              onClick={() =>
                void change('/review', 'POST', { decision: 'approve' })
              }
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void change('/review', 'POST', { decision: 'reject' })
              }
            >
              Reject
            </button>
          </>
        )}
        {item.status !== 'forgotten' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void change('/forget', 'POST', {})}
          >
            Forget memory
          </button>
        )}
      </div>
      <p className="muted">
        Pinned memories are included by default. Other active memories are
        retrieved when needed. Forgetting excludes this memory and its evidence
        from future recall; your original conversation remains in history.
      </p>
      <label>
        Share selected memory
        <select
          aria-label="Memory sharing scope"
          value={sharing}
          onChange={(e) => setSharing(e.target.value)}
        >
          <ScopeOptions dots={dots} spaces={spaces} />
          {item.scope.kind !== 'owner' &&
            !(item.scope.kind === 'dot' ? dots : spaces)?.some(
              (s) => s.id === ('id' in item.scope ? item.scope.id : ''),
            ) && (
              <option value={scopeValue(item.scope)}>
                Current {item.scope.kind}
              </option>
            )}
        </select>
      </label>
      <button
        type="button"
        disabled={
          busy || sharing === scopeValue(item.scope) || item.status !== 'active'
        }
        onClick={() =>
          void change('/share', 'POST', { scope: parseScope(sharing) })
        }
      >
        Share memory and cited excerpts
      </button>
      <h3>Original evidence</h3>
      {details.sources.length ? (
        details.sources.map(({ ref, text: source }, i) => (
          <details key={i}>
            <summary>Conversation excerpt {i + 1}</summary>
            <p className="memory-source">
              {source ?? 'This source is no longer available.'}
            </p>
            <small>
              {ref.messageIds.length} cited message
              {ref.messageIds.length === 1 ? '' : 's'}
            </small>
          </details>
        ))
      ) : (
        <p>Added by you. No conversation evidence attached.</p>
      )}
      <details>
        <summary>Revision history ({details.revisions.length})</summary>
        {[...details.revisions].reverse().map((r) => (
          <article key={r.revision}>
            <strong>
              Revision {r.revision} · {r.status}
            </strong>
            <p className="memory-source">{r.text}</p>
          </article>
        ))}
      </details>
    </section>
  );
}
