import { useEffect, useRef, useState } from 'react';
import type { Binding } from '../../shared/abilities/types';
import type { DesktopAbilityOutput } from '../../shared/abilities/desktop';
import { AbilityHostStatus, unwrap } from './AbilityHostStatus';
import './abilities.css';
function AccountSetup({
  dotId,
  binding,
  account,
  disabled,
  connected,
  onChange,
}: {
  dotId: string;
  binding: Binding;
  account: Extract<
    Binding['manifest']['permissions'][number],
    { kind: 'oauth' }
  >;
  disabled: boolean;
  connected: boolean;
  onChange(): Promise<void>;
}) {
  const [clientId, setClientId] = useState(
      String(binding.settings[account.clientIdSetting] ?? ''),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false);
  const connect = async () => {
    if (pending.current || disabled || !clientId.trim()) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      unwrap(
        await window.dotAbilities?.connect({
          dotId,
          bindingId: binding.id,
          accountId: account.id,
          clientId: clientId.trim(),
        }),
      );
      await onChange();
    } catch {
      setError(
        'Could not connect. Check the client ID and setup guide, then try again.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="ability-account">
      <a
        href={`https://github.com/${binding.manifest.source.owner}/${binding.manifest.source.repository}/tree/main/abilities/${binding.manifest.id}`}
        target="_blank"
        rel="noreferrer"
      >
        Setup guide
      </a>
      {connected ? (
        <span>Account connected</span>
      ) : (
        <>
          <label>
            Client ID
            <input
              aria-label="Client ID"
              value={clientId}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setClientId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void connect();
                }
              }}
            />
          </label>
          <button
            type="button"
            disabled={disabled || busy || !clientId.trim()}
            onClick={connect}
          >
            {busy ? 'Connecting…' : 'Connect account'}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function AbilitySettings({
  dotId,
  binding,
  disabled,
  onChange,
}: {
  dotId: string;
  binding: Binding;
  disabled: boolean;
  onChange(): Promise<void>;
}) {
  const [settings, setSettings] = useState(
      JSON.stringify(binding.settings, null, 2),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false);
  const accountKeys = new Set(
    binding.manifest.permissions.flatMap((p) =>
      p.kind === 'oauth' ? [p.clientIdSetting] : [],
    ),
  );
  if (
    !Object.keys(binding.manifest.settings.properties).some(
      (key) => !accountKeys.has(key),
    )
  )
    return null;
  const save = async () => {
    if (disabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      unwrap(
        await window.dotAbilities?.configure({
          dotId,
          bindingId: binding.id,
          settings: JSON.parse(settings),
        }),
      );
      await onChange();
    } catch {
      setError('Settings could not be saved. Check the values and try again.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <details className="ability-settings">
      <summary>Settings</summary>
      <label>
        Ability settings
        <textarea
          value={settings}
          onChange={(event) => setSettings(event.target.value)}
          spellCheck={false}
        />
      </label>
      <small>Settings are not secret storage.</small>
      <button type="button" disabled={disabled || busy} onClick={save}>
        Save settings
      </button>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
export function AbilitiesSection({
  dotId,
  dotName = 'this Dot',
}: {
  dotId: string;
  dotName?: string;
}) {
  const [state, setState] = useState<DesktopAbilityOutput<'list'>>(),
    [accounts, setAccounts] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const [forgetting, setForgetting] = useState<string>(),
    [erase, setErase] = useState(false);
  const pending = useRef(false),
    current = useRef<string | undefined>(dotId);
  const load = async () => {
    const next = unwrap(await window.dotAbilities?.list({ dotId }));
    if (current.current !== dotId) return;
    setState(next);
    setError((current) =>
      current === 'Abilities are unavailable. Reconnect the desktop workspace.'
        ? ''
        : current,
    );
    const pairs = await Promise.all(
      next.bindings.flatMap((binding) =>
        binding.manifest.permissions
          .filter((p) => p.kind === 'oauth')
          .map(async (account) => {
            const result = await window.dotAbilities?.account({
              dotId,
              bindingId: binding.id,
              accountId: account.id,
            });
            return [
              binding.id + ':' + account.id,
              result?.ok ? result.value.connected : false,
            ] as const;
          }),
      ),
    );
    if (current.current === dotId) setAccounts(Object.fromEntries(pairs));
  };
  useEffect(() => {
    current.current = dotId;
    setState(undefined);
    setAccounts({});
    setError('');
    pending.current = false;
    setBusy('');
    if (!window.dotAbilities) return;
    let live = true;
    const reload = () => {
      if (live)
        void load().catch(
          () =>
            live &&
            setError(
              'Abilities are unavailable. Reconnect the desktop workspace.',
            ),
        );
    };
    reload();
    const timer = setInterval(reload, 3000);
    return () => {
      live = false;
      current.current = undefined;
      clearInterval(timer);
    };
    // load reads this selected Dot; the timer is replaced when that identity changes.
  }, [dotId]);
  const run = async <T,>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(key);
    setError('');
    try {
      const result = await operation();
      if (current.current !== dotId) return;
      return result;
    } catch {
      if (current.current === dotId)
        setError(
          'The action could not be completed. Check setup and try again.',
        );
    } finally {
      if (current.current === dotId) {
        pending.current = false;
        setBusy('');
      }
    }
  };
  if (!window.dotAbilities)
    return (
      <p className="dot-config-empty">
        Open the Dot desktop app to enable Abilities.
      </p>
    );
  return (
    <section className="abilities-section" aria-label={`${dotName} Abilities`}>
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
      {(
        state?.installed ??
        state?.bindings.map((binding) => ({
          digest: binding.digest,
          manifest: binding.manifest,
          enabled: true,
          restored: binding.restored,
          settings: binding.settings,
          enabledDots: 1,
        })) ??
        []
      ).map((ability) => {
        const binding = state?.bindings.find(
          (item) => item.digest === ability.digest,
        );
        const blocked =
          !!busy || !state?.available || ability.restored || !ability.enabled;
        const assign = async () =>
          run(ability.digest, async () => {
            unwrap(
              await window.dotAbilities?.assign({
                dotId,
                digest: ability.digest,
                enabled: !binding?.enabled,
              }),
            );
            await load();
          });
        if (!binding)
          return (
            <article className="ability-binding" key={ability.digest}>
              <div className="ability-heading">
                <div>
                  <strong>{ability.manifest.name}</strong>
                  <span>{ability.manifest.version}</span>
                </div>
                <span role="status">
                  {ability.restored
                    ? 'Review needed'
                    : !ability.enabled
                      ? 'Disabled in workspace'
                      : 'Disabled'}
                </span>
              </div>
              <div className="ability-actions">
                <button type="button" disabled={blocked} onClick={assign}>
                  Enable
                </button>
              </div>
            </article>
          );

        const requiredAccounts = binding.manifest.permissions.filter(
          (p): p is Extract<typeof p, { kind: 'oauth' }> => p.kind === 'oauth',
        );
        const connected = requiredAccounts.every(
          (account) => accounts[binding.id + ':' + account.id],
        );
        const needsPython = [
          binding.manifest.entrypoint,
          ...binding.manifest.helpers.map((helper) => helper.entrypoint),
        ].some((entry) => entry.runtime === 'python');
        const phase =
          ability.restored || binding.restored
            ? 'Review needed'
            : !ability.enabled
              ? 'Disabled in workspace'
              : !binding.enabled
                ? 'Disabled'
                : !state?.available
                  ? 'Blocked'
                  : state?.activity?.[binding.id]
                    ? 'Running'
                    : connected && (!needsPython || !!state?.python)
                      ? 'Ready'
                      : 'Setup needed';
        const change = async (method: 'disconnect') => {
          await run(binding.id, async () => {
            unwrap<unknown>(
              await window.dotAbilities?.[method]({
                dotId,
                bindingId: binding.id,
              }),
            );
            await load();
          });
        };
        return (
          <article className="ability-binding" key={binding.id}>
            <div className="ability-heading">
              <div>
                <strong>{binding.manifest.name}</strong>
                <span>
                  {binding.manifest.version} · {binding.manifest.source.owner}/
                  {binding.manifest.source.repository}
                </span>
              </div>
              <span className="ability-phase" role="status">
                {phase}
              </span>
            </div>
            {ability.restored && (
              <p>
                Review this release in Abilities to restore access.{' '}
                <a
                  href={`https://github.com/${binding.manifest.source.owner}/${binding.manifest.source.repository}/releases`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Find its release
                </a>
              </p>
            )}
            <div className="ability-actions">
              <button type="button" disabled={blocked} onClick={assign}>
                {binding.enabled ? 'Disable' : 'Enable'}
              </button>
              {requiredAccounts.length > 0 && connected && (
                <button
                  type="button"
                  disabled={!!busy || !state?.available}
                  onClick={() => change('disconnect')}
                >
                  Disconnect
                </button>
              )}
              <button
                type="button"
                disabled={!!busy || !state?.available}
                onClick={() => {
                  setForgetting(binding.id);
                  setErase(false);
                }}
              >
                Forget…
              </button>
            </div>
            {needsPython && (
              <div className="ability-python">
                {state?.python && (
                  <small>Python: {state?.python.executable}</small>
                )}
                <button
                  type="button"
                  disabled={!!busy || !state?.available}
                  onClick={() =>
                    run('python', async () => {
                      unwrap(
                        await window.dotAbilities?.choosePython({ dotId }),
                      );
                      await load();
                    })
                  }
                >
                  {state?.python ? 'Change Python…' : 'Choose Python…'}
                </button>
              </div>
            )}
            <AbilitySettings
              key={binding.id + ':' + binding.revision}
              dotId={dotId}
              binding={binding}
              disabled={!!busy || !state?.available}
              onChange={load}
            />
            {requiredAccounts.map((account) => (
              <AccountSetup
                key={account.id}
                dotId={dotId}
                binding={binding}
                account={account}
                disabled={blocked || !binding.enabled}
                connected={!!accounts[binding.id + ':' + account.id]}
                onChange={load}
              />
            ))}
            {forgetting === binding.id && (
              <div className="ability-forget">
                <label>
                  <input
                    type="checkbox"
                    checked={erase}
                    onChange={(event) => setErase(event.target.checked)}
                  />
                  Delete this Dot’s private Ability data
                </label>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() =>
                    run('forget', async () => {
                      unwrap(
                        await window.dotAbilities?.forget({
                          dotId,
                          bindingId: binding.id,
                          eraseState: erase,
                        }),
                      );
                      setForgetting(undefined);
                      await load();
                    })
                  }
                >
                  Forget Ability
                </button>
                <button type="button" onClick={() => setForgetting(undefined)}>
                  Cancel
                </button>
              </div>
            )}
          </article>
        );
      })}
      {state?.available && !(state.installed ?? state.bindings).length && (
        <p className="muted">
          Install Abilities from the sidebar, then enable them here.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
