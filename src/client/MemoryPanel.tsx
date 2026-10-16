import { useEffect, useState } from 'react';
import type { MemoryPage, MemoryStatus } from '../shared/memory';
import { api } from './api';
import {
  MemoryDetails,
  ScopeOptions,
  parseScope,
  type MemoryScopes,
} from './MemoryDetails';
export function MemoryPanel({
  dotId,
  onChanged,
  dots,
  spaces,
}: { dotId?: string; onChanged: () => void } & MemoryScopes) {
  const [page, setPage] = useState<MemoryPage>({ items: [] }),
    [status, setStatus] = useState('active'),
    [scope, setScope] = useState('all'),
    [kind, setKind] = useState(''),
    [selected, setSelected] = useState<string>(),
    [version, setVersion] = useState(0),
    [text, setText] = useState(''),
    [title, setTitle] = useState(''),
    [destination, setDestination] = useState(dotId ? 'dot:' + dotId : 'owner'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const query = new URLSearchParams({
    ...(status ? { status: status as MemoryStatus } : {}),
    ...(kind ? { kind } : {}),
    ...(scope !== 'all'
      ? {
          scopeKind: parseScope(scope).kind,
          ...(parseScope(scope).kind !== 'owner'
            ? { scopeId: scope.slice(scope.indexOf(':') + 1) }
            : {}),
        }
      : {}),
  }).toString();
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<MemoryPage>(
      '/memory-items?' + query,
      'GET',
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [query, version]);
  const changed = () => {
    setVersion((v) => v + 1);
    onChanged();
  };
  const add = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/memory-items', 'POST', {
        scope: parseScope(destination),
        title: title.trim() || text.slice(0, 120),
        text,
      });
      setText('');
      setTitle('');
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Memory could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="memory-panel" aria-label="Saved memories">
      <p className="muted">
        Essentials stay close. Facts, procedures, and conversation evidence can
        be recalled when needed.
      </p>
      <div className="memory-filters">
        <label>
          Status
          <select
            aria-label="Memory status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {['active', 'pending', 'superseded', 'rejected', 'forgotten'].map(
              (s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          Scope
          <select
            aria-label="Memory scope filter"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="all">All scopes</option>
            <ScopeOptions dots={dots} spaces={spaces} />
          </select>
        </label>
        <label>
          Type
          <select
            aria-label="Memory type"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">Facts and procedures</option>
            <option value="fact">Facts</option>
            <option value="skill">Procedures</option>
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="memory-grid">
        {page.items.map((item) => (
          <article className="memory-card" key={item.id}>
            <strong>{item.title}</strong>
            <p>
              {item.text.length > 300
                ? item.text.slice(0, 300) + '…'
                : item.text}
            </p>
            <small>
              {item.pinned ? 'Essential · ' : ''}
              {item.kind === 'skill' ? 'Procedure' : 'Fact'} · {item.status} ·{' '}
              {item.scope.kind === 'owner'
                ? 'All permitted Dots'
                : item.scope.kind === 'dot'
                  ? (dots?.find(
                      (d) => d.id === ('id' in item.scope ? item.scope.id : ''),
                    )?.name ?? 'One Dot')
                  : (spaces?.find(
                      (s) => s.id === ('id' in item.scope ? item.scope.id : ''),
                    )?.name ?? 'One Space')}
            </small>
            <button type="button" onClick={() => setSelected(item.id)}>
              Inspect memory
            </button>
          </article>
        ))}
      </div>
      {!page.items.length && <p>No memories in this view.</p>}
      {page.nextCursor && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api<MemoryPage>(
              '/memory-items?' +
                query +
                '&cursor=' +
                encodeURIComponent(page.nextCursor!),
            )
              .then((next) =>
                setPage((current) => ({
                  items: [...current.items, ...next.items],
                  nextCursor: next.nextCursor,
                })),
              )
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          Load more memories
        </button>
      )}
      {selected && (
        <MemoryDetails
          key={selected}
          id={selected}
          dots={dots}
          spaces={spaces}
          onChanged={changed}
          onClose={() => setSelected(undefined)}
        />
      )}
      <form
        aria-label="Add memory"
        className="memory-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <h2>Add a memory</h2>
        <label>
          Title (optional)
          <input
            aria-label="New memory title"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Preference or fact
          <textarea
            aria-label="New memory text"
            required
            maxLength={2000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <label>
          Available to
          <select
            aria-label="New memory scope"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          >
            <ScopeOptions dots={dots} spaces={spaces} />
            {dotId && !dots?.some((d) => d.id === dotId) && (
              <option value={'dot:' + dotId}>This Dot</option>
            )}
          </select>
        </label>
        <button className="primary" disabled={busy || !text.trim()}>
          Save memory
        </button>
      </form>
    </section>
  );
}
