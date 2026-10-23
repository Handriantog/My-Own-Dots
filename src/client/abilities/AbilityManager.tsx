import { useEffect, useRef, useState } from 'react';
import type { DesktopAbilityOutput } from '../../shared/abilities/desktop';
import type { JsonValue } from '../../shared/abilities/types';
import { PermissionReview, type AbilityReview } from './PermissionReview';
import { AbilityHostStatus, unwrap } from './AbilityHostStatus';
import './abilities.css';
const loadError = 'Could not load Abilities. Try reconnecting.';

export function AbilityManager() {
  const [state, setState] = useState<DesktopAbilityOutput<'catalog'>>();
  const [url, setUrl] = useState(''),
    [review, setReview] = useState<AbilityReview>();
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const pending = useRef(false),
    live = useRef(true);
  const load = async () => {
    const next = unwrap(await window.dotAbilities?.catalog({}));
    if (live.current) {
      setState(next);
      setError((current) => (current === loadError ? '' : current));
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
  const reviewRelease = async () => {
    if (!state?.available || !url.trim()) return;
    const value = await run('review', async () =>
      unwrap(await window.dotAbilities?.reviewInstall({ url: url.trim() })),
    );
    if (value && live.current) setReview(value);
  };
  const reviewLocal = async () => {
    if (!state?.available) return;
    const value = await run('review-local', async () =>
      unwrap(await window.dotAbilities?.reviewInstallLocal({})),
    );
    if (value && live.current) setReview(value);
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
      setReview(undefined);
      setUrl('');
      await load();
    }
  };
  if (!window.dotAbilities)
    return (
      <p className="dot-config-empty">
        Open the Dot desktop app to install Abilities.
      </p>
    );
  return (
    <section
      className="abilities-section ability-manager"
      aria-label="Installed Abilities"
    >
      <div className="ability-add">
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
          disabled={!state?.available || !!busy || !url.trim()}
          onClick={reviewRelease}
        >
          {busy === 'review' ? 'Reviewing…' : 'Review'}
        </button>
        <button
          type="button"
          disabled={!state?.available || !!busy}
          onClick={reviewLocal}
        >
          Choose local Ability…
        </button>
      </div>
      <AbilityHostStatus
        available={state?.available ?? false}
        reason={state?.reason}
        busy={!!busy}
        onReconnect={() =>
          run('reconnect', async () => {
            unwrap(await window.dotAbilities?.reconnect({}));
            await load();
          })
        }
      />
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
      {state?.installations.map((ability) => (
        <article className="ability-binding" key={ability.digest}>
          <div className="ability-heading">
            <div>
              <strong>{ability.manifest.name}</strong>
              <span>
                {ability.manifest.version} · {ability.manifest.source.owner}/
                {ability.manifest.source.repository}
              </span>
            </div>
            <span role="status">
              {ability.restored
                ? 'Review needed'
                : ability.enabled
                  ? 'Enabled'
                  : 'Disabled'}
            </span>
          </div>
          {ability.restored && (
            <p className="muted">
              Review this Ability’s release again to restore access.
            </p>
          )}
          <div className="ability-actions">
            <button
              type="button"
              disabled={!!busy || !state.available || ability.restored}
              onClick={() =>
                run(ability.digest, async () => {
                  unwrap(
                    await window.dotAbilities?.master({
                      digest: ability.digest,
                      enabled: !ability.enabled,
                    }),
                  );
                  await load();
                })
              }
            >
              {ability.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              disabled={
                !!busy ||
                !state.available ||
                !ability.enabled ||
                ability.restored
              }
              onClick={() =>
                run(ability.digest, async () => {
                  unwrap(
                    await window.dotAbilities?.applyAll({
                      digest: ability.digest,
                    }),
                  );
                  await load();
                })
              }
            >
              Apply to all Dot
            </button>
            <span className="ability-count">
              {ability.enabledDots}{' '}
              {ability.enabledDots === 1 ? 'Dot selected' : 'Dots selected'}
            </span>
          </div>
        </article>
      ))}
      {state?.available && !state.installations.length && !review && (
        <p className="muted">
          Install an Ability, then enable it for your Dots.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
