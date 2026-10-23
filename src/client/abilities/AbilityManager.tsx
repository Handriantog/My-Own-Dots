import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import type { DesktopAbilityOutput } from '../../shared/abilities/desktop';
import type { AbilityLibrary } from '../../shared/abilities/library';
import type { JsonValue } from '../../shared/abilities/types';
import { PermissionReview, type AbilityReview } from './PermissionReview';
import { AbilityHostStatus, unwrap } from './AbilityHostStatus';
import {
  AbilityDetails,
  AbilityIcon,
  abilitySummary,
  type AbilitySelection,
} from './AbilityDetails';
import './abilities.css';
import './ability-browser.css';
const loadError = 'Could not load Abilities. Try reconnecting.';

export function AbilityManager() {
  const [state, setState] = useState<DesktopAbilityOutput<'catalog'>>();
  const [library, setLibrary] = useState<AbilityLibrary>();
  const [libraryError, setLibraryError] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<AbilityReview>();
  const [review, setReview] = useState<AbilityReview>();
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const pending = useRef(false),
    live = useRef(true),
    browsePending = useRef(false);
  const load = async () => {
    const next = unwrap(await window.dotAbilities?.catalog({}));
    if (live.current) {
      setState(next);
      setError((current) => (current === loadError ? '' : current));
    }
  };
  const browse = async (refresh = false) => {
    if (browsePending.current) return;
    browsePending.current = true;
    setBrowsing(true);
    try {
      const next = unwrap(await window.dotAbilities?.browse({ refresh }));
      if (live.current) {
        setLibrary(next);
        setLibraryError('');
      }
    } catch {
      if (live.current)
        setLibraryError('Could not load the GitHub collection.');
    } finally {
      browsePending.current = false;
      if (live.current) setBrowsing(false);
    }
  };
  useEffect(() => {
    live.current = true;
    if (!window.dotAbilities) return;
    const reload = () =>
      void load().catch(() => {
        if (live.current) setError(loadError);
      });
    reload();
    void browse();
    const timer = setInterval(reload, 3000);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, []);
  const run = async <T,>(key: string, operation: () => Promise<T>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(key);
    setError('');
    try {
      return await operation();
    } catch {
      if (live.current)
        setError(
          'The action could not be completed. Check setup and try again.',
        );
    } finally {
      pending.current = false;
      if (live.current) setBusy('');
    }
  };
  const select = (key: string) => {
    if (pending.current) return;
    setSelected(key);
    setReview(undefined);
    setRemoving(false);
    setError('');
  };
  const reviewRelease = async (releaseUrl = url.trim(), consent = false) => {
    if (!state?.available || !releaseUrl) return;
    const value = await run('review', async () =>
      unwrap(await window.dotAbilities?.reviewInstall({ url: releaseUrl })),
    );
    if (value && live.current) {
      setPreview(value);
      setSelected(`preview:${value.id}`);
      setAdding(false);
      setRemoving(false);
      setReview(consent ? value : undefined);
    }
  };
  const reviewLocal = async () => {
    if (!state?.available) return;
    const value = await run('review-local', async () =>
      unwrap(await window.dotAbilities?.reviewInstallLocal({})),
    );
    if (value && live.current) {
      setPreview(value);
      setSelected(`preview:${value.id}`);
      setAdding(false);
      setRemoving(false);
      setReview(undefined);
    }
  };
  const install = async (
    settings: Record<string, JsonValue>,
    acceptedNotices?: string[],
  ) => {
    if (!review) return;
    const value = await run('install', async () =>
      unwrap(
        await window.dotAbilities?.install({
          reviewId: review.id,
          settings,
          ...(acceptedNotices?.length ? { acceptedNotices } : {}),
        }),
      ),
    );
    if (value && live.current) {
      // Show the newly installed (disabled) package even before the next poll.
      setState(
        (current) =>
          current && {
            ...current,
            installations: [
              ...current.installations.filter(
                (item) => item.digest !== value.digest,
              ),
              value,
            ],
          },
      );
      setReview(undefined);
      setPreview(undefined);
      setUrl('');
      setSelected(`installed:${value.digest}`);
      await load().catch(() => {
        if (live.current) setError(loadError);
      });
    }
  };
  const installed = state?.installations.find(
    (item) => `installed:${item.digest}` === selected,
  );
  const entry = library?.entries.find(
    (item) => `library:${item.id}` === selected,
  );
  const selection: AbilitySelection | undefined = installed
    ? { kind: 'installed', ability: installed }
    : entry && library
      ? { kind: 'library', entry, sourceCommit: library.sourceCommit }
      : preview && selected === `preview:${preview.id}`
        ? { kind: 'preview', review: preview }
        : undefined;
  const locked = !!busy || !state?.available;
  const matches = (...values: string[]) =>
    values
      .join(' ')
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
  const installations =
    state?.installations.filter((item) =>
      matches(
        item.manifest.name,
        item.manifest.id,
        item.manifest.publisher,
        abilitySummary(item.manifest.description),
      ),
    ) ?? [];
  const available =
    library?.entries.filter(
      (item) =>
        !state?.installations.some(
          (pkg) =>
            pkg.manifest.id === item.id &&
            pkg.manifest.source.owner.toLowerCase() === 'handriantog' &&
            pkg.manifest.source.repository.toLowerCase() ===
              'my-own-dot-abilities',
        ) && matches(item.name, item.id, item.publisher),
    ) ?? [];
  if (!window.dotAbilities)
    return (
      <p className="dot-config-empty">
        Open the Dot desktop app to install Abilities.
      </p>
    );
  return (
    <section
      className={`ability-browser${selection ? ' has-selection' : ''}`}
      aria-label="Abilities"
    >
      {(error || (state && !state.available)) && (
        <div className="ability-browser-notices">
          {state && (
            <AbilityHostStatus
              available={state.available}
              reason={state.reason}
              busy={!!busy}
              onReconnect={() =>
                run('reconnect', async () => {
                  unwrap(await window.dotAbilities?.reconnect({}));
                  await load();
                })
              }
            />
          )}
          {error && (
            <div className="ability-browser-error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                aria-label="Dismiss Ability error"
                onClick={() => setError('')}
              >
                <X size={16} />
              </button>
            </div>
          )}
        </div>
      )}
      <aside className="ability-list-panel" aria-label="Ability list">
        <div className="ability-list-heading">
          <h1>Abilities</h1>
          <div>
            <button
              type="button"
              aria-label="Refresh GitHub collection"
              title="Refresh GitHub collection"
              disabled={browsing}
              onClick={() => void browse(true)}
            >
              <RefreshCw size={16} />
            </button>
            <button
              type="button"
              aria-label="Add Ability"
              title="Add Ability"
              aria-expanded={adding}
              disabled={!!busy}
              onClick={() => setAdding((value) => !value)}
            >
              <Plus size={18} />
            </button>
          </div>
        </div>
        <label className="ability-search">
          <Search size={16} />
          <input
            aria-label="Search Abilities"
            placeholder="Search Abilities"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {adding && (
          <div className="ability-import">
            <label>
              GitHub release descriptor
              <input
                aria-label="GitHub release descriptor"
                placeholder="https://github.com/…/ability.release.json"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void reviewRelease();
                  }
                }}
              />
            </label>
            <button
              type="button"
              disabled={locked || !url.trim()}
              onClick={() => reviewRelease()}
            >
              {busy === 'review' ? 'Reviewing…' : 'Review'}
            </button>
            <button type="button" disabled={locked} onClick={reviewLocal}>
              Choose local Ability…
            </button>
          </div>
        )}
        <div className="ability-list-scroll">
          <section
            className="ability-list-group"
            aria-label="Installed Abilities"
          >
            <h2>
              Installed <span>{installations.length}</span>
            </h2>
            {installations.map((ability) => (
              <button
                type="button"
                className="ability-list-row"
                key={ability.digest}
                aria-label={`Open ${ability.manifest.name}`}
                aria-current={
                  selected === `installed:${ability.digest}`
                    ? 'true'
                    : undefined
                }
                disabled={!!busy}
                onClick={() => select(`installed:${ability.digest}`)}
              >
                <AbilityIcon />
                <span className="ability-row-copy">
                  <strong>{ability.manifest.name}</strong>
                  <span className="ability-row-summary">
                    {abilitySummary(ability.manifest.description)}
                  </span>
                  <span className="ability-row-meta">
                    <span>{ability.manifest.publisher}</span>
                    <span>
                      {ability.restored
                        ? 'Review needed'
                        : ability.enabled
                          ? 'Enabled'
                          : 'Disabled'}
                    </span>
                  </span>
                </span>
              </button>
            ))}
            {!installations.length && (
              <p className="ability-list-empty">
                {query
                  ? 'No matches.'
                  : state
                    ? 'No Abilities installed.'
                    : 'Loading…'}
              </p>
            )}
          </section>
          <section className="ability-list-group" aria-label="GitHub Abilities">
            <h2>
              Available on GitHub <span>{available.length}</span>
            </h2>
            {available.map((ability) => (
              <button
                type="button"
                className="ability-list-row"
                key={ability.id}
                aria-label={`Open ${ability.name}`}
                aria-current={
                  selected === `library:${ability.id}` ? 'true' : undefined
                }
                disabled={!!busy}
                onClick={() => select(`library:${ability.id}`)}
              >
                <AbilityIcon />
                <span className="ability-row-copy">
                  <strong>{ability.name}</strong>
                  <span className="ability-row-summary">
                    {ability.publisher}
                  </span>
                  <span className="ability-row-meta">
                    {ability.status === 'released'
                      ? `v${ability.version}`
                      : ability.status === 'planned'
                        ? 'Planned'
                        : 'In development'}
                  </span>
                </span>
              </button>
            ))}
            {browsing && (
              <p className="ability-list-empty" role="status">
                Loading collection…
              </p>
            )}
            {libraryError && (
              <div className="ability-library-error">
                <p role="status">{libraryError}</p>
                <button
                  type="button"
                  disabled={browsing}
                  onClick={() => void browse(true)}
                >
                  Retry
                </button>
              </div>
            )}
            {!browsing && !libraryError && !available.length && (
              <p className="ability-list-empty">
                {query ? 'No matches.' : 'No other Abilities available.'}
              </p>
            )}
          </section>
        </div>
      </aside>
      <div className="ability-detail-panel">
        {selection ? (
          <AbilityDetails
            key={
              selected +
              (selection.kind === 'library' ? selection.sourceCommit : '')
            }
            selection={selection}
            onBack={() => select('')}
            actions={
              review ? undefined : installed ? (
                <>
                  <button
                    type="button"
                    className={installed.enabled ? '' : 'primary'}
                    disabled={locked || installed.restored}
                    onClick={() =>
                      run('master', async () => {
                        unwrap(
                          await window.dotAbilities?.master({
                            digest: installed.digest,
                            enabled: !installed.enabled,
                          }),
                        );
                        await load();
                      })
                    }
                  >
                    {installed.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    disabled={
                      locked || !installed.enabled || installed.restored
                    }
                    onClick={() =>
                      run('apply', async () => {
                        unwrap(
                          await window.dotAbilities?.applyAll({
                            digest: installed.digest,
                          }),
                        );
                        await load();
                      })
                    }
                  >
                    Apply to all Dot
                  </button>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => setRemoving(true)}
                  >
                    Uninstall
                  </button>
                </>
              ) : selection.kind === 'preview' ? (
                <button
                  type="button"
                  className="primary"
                  disabled={locked}
                  onClick={() => setReview(selection.review)}
                >
                  Install
                </button>
              ) : entry?.descriptorUrl ? (
                <button
                  type="button"
                  className="primary"
                  disabled={locked}
                  onClick={() => reviewRelease(entry.descriptorUrl, true)}
                >
                  {busy === 'review' ? 'Reviewing…' : 'Install'}
                </button>
              ) : undefined
            }
          >
            {review && (
              <PermissionReview
                key={review.id}
                review={review}
                mode="install"
                dotName="workspace"
                onTeach={install}
                onCancel={() => setReview(undefined)}
              />
            )}
            {removing && installed && (
              <section
                className="ability-uninstall-confirm"
                aria-label="Confirm uninstall"
              >
                <strong>
                  Uninstall {installed.manifest.name} v
                  {installed.manifest.version}?
                </strong>
                <p>
                  This stops the Ability and removes it from all Dots. Its
                  private data is kept.
                </p>
                <div className="ability-actions">
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() =>
                      run('uninstall', async () => {
                        unwrap(
                          await window.dotAbilities?.uninstall({
                            digest: installed.digest,
                            removeFromDots: true,
                          }),
                        );
                        setSelected('');
                        setRemoving(false);
                        await load();
                      })
                    }
                  >
                    {busy === 'uninstall'
                      ? 'Uninstalling…'
                      : 'Uninstall from all Dots'}
                  </button>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => setRemoving(false)}
                  >
                    Cancel
                  </button>
                </div>
              </section>
            )}
          </AbilityDetails>
        ) : (
          <div className="ability-detail-empty">
            <Sparkles size={36} strokeWidth={1.2} />
            <h2>Give Dot a new Ability</h2>
            <p>Select an Ability to explore its details.</p>
          </div>
        )}
      </div>
    </section>
  );
}
