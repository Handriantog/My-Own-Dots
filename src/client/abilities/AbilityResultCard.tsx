import { useEffect, useRef, useState } from 'react';
import {
  ownerViewSchema,
  type OwnerView,
} from '../../shared/abilities/desktop';
import { ownerOutcomeSchema } from '../../shared/abilities/protocol';
import './abilities.css';
export function OwnerResultView({
  result,
  onChoose,
  disabled = false,
}: {
  result: OwnerView;
  onChoose?(itemId: string): void;
  disabled?: boolean;
}) {
  return (
    <>
      {result.kind === 'text' ? (
        <p>{result.text}</p>
      ) : (
        <>
          <strong>{result.title}</strong>
          <ul>
            {result.items.map((item) => (
              <li key={item.id}>
                <div>
                  <span>{item.label}</span>
                  {item.detail && <small>{item.detail}</small>}
                  {item.url && (
                    <a href={item.url} target="_blank" rel="noreferrer">
                      Open ↗
                    </a>
                  )}
                </div>
                {item.selectable && onChoose && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChoose(item.id)}
                  >
                    Choose
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {result.attribution && <small>{result.attribution}</small>}
    </>
  );
}
export function AbilityResultCard({
  dotId,
  handle,
  onSelect,
}: {
  dotId: string;
  handle: string;
  onSelect?(selectionRef: string): void | Promise<void>;
}) {
  const [result, setResult] = useState<OwnerView | null>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const active = useRef(false);
  useEffect(() => {
    let live = true;
    setResult(undefined);
    setError('');
    const load = async () => {
      try {
        const reply = await window.dotAbilities?.results({ dotId, handle });
        if (live)
          setResult(
            reply?.ok && reply.value
              ? ownerViewSchema.parse(reply.value)
              : null,
          );
      } catch {
        if (live) setResult(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [dotId, handle]);
  const choose = async (itemId: string) => {
    if (active.current || !onSelect) return;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      const reply = await window.dotAbilities?.select({
        dotId,
        handle,
        itemId,
      });
      if (!reply?.ok) throw new Error();
      await onSelect(reply.value.selectionRef);
    } catch {
      setError('This choice is unavailable. Refresh the result and try again.');
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return (
    <aside className="ability-result" aria-label="Private Ability result">
      {result === undefined ? (
        <p role="status">Loading result…</p>
      ) : result === null ? (
        <p>This result expired or is unavailable. Ask Dot to refresh it.</p>
      ) : (
        <OwnerResultView
          result={result}
          onChoose={onSelect ? choose : undefined}
          disabled={busy}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}
export function AbilityToolCard({
  dotId,
  status,
  result: raw,
  onSelect,
}: {
  dotId: string;
  status: string;
  result?: unknown;
  onSelect?(selectionRef: string): void | Promise<void>;
}) {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const parsed = ownerOutcomeSchema.safeParse(value);
  if (parsed.success && parsed.data.resultRef)
    return (
      <AbilityResultCard
        dotId={dotId}
        handle={parsed.data.resultRef}
        onSelect={onSelect}
      />
    );
  const label = !parsed.success
    ? status === 'complete'
      ? 'Ability finished.'
      : 'Using Ability…'
    : parsed.data.status === 'success'
      ? 'Done.'
      : parsed.data.status === 'uncertain'
        ? 'The outcome is uncertain. Check before trying again.'
        : parsed.data.status === 'selection_needed'
          ? 'Choose an item to continue.'
          : 'This Ability could not complete the action.';
  return (
    <div className="ability-result" role="status">
      {label}
    </div>
  );
}

/** Voice delegations return private cards via desktop memory, never conversation text. */
export function RecentAbilityResults({
  dotId,
  threadId,
  hiddenHandles,
  onSelect,
}: {
  dotId: string;
  threadId: string;
  hiddenHandles: Set<string>;
  onSelect(selectionRef: string): Promise<void>;
}) {
  const [handles, setHandles] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setHandles([]);
    const load = async () => {
      try {
        const result = await window.dotAbilities?.recent({ dotId, threadId });
        if (live) setHandles(result?.ok ? result.value : []);
      } catch {
        if (live) setHandles([]);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [dotId, threadId]);
  return (
    <>
      {handles
        .filter((handle) => !hiddenHandles.has(handle))
        .map((handle) => (
          <AbilityResultCard
            key={handle}
            dotId={dotId}
            handle={handle}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}
