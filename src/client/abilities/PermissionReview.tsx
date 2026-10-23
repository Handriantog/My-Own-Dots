import { useRef, useState } from 'react';
import type { DesktopAbilityOutput } from '../../shared/abilities/desktop';
import type {
  AbilityPermission,
  JsonValue,
} from '../../shared/abilities/types';
import { validateValue } from '../../shared/abilities/manifest';
import './abilities.css';
import {
  appActionLabels,
  uiAppActions,
} from '../../shared/abilities/app-control';
export type AbilityReview = DesktopAbilityOutput<'review'>;
export function permissionSummary(permission: AbilityPermission): string {
  switch (permission.kind) {
    case 'app-control': {
      const access = [
        permission.actions.some((action) => !uiAppActions.has(action))
          ? 'Automation'
          : '',
        permission.actions.some((action) => uiAppActions.has(action))
          ? 'Accessibility'
          : '',
      ]
        .filter(Boolean)
        .join(' and ');
      return `Spotify only: ${permission.actions.map((action) => appActionLabels[action]).join(', ')}. macOS ${access} access required.`;
    }
    case 'https':
      return `${permission.method} ${permission.origin}/${permission.path.map((part) => (typeof part === 'string' ? part : `{${part.param}}`)).join('/')}`;
    case 'oauth':
      return `Account at ${new URL(permission.authorizationUrl).hostname}`;
    case 'helper':
      return `Run bundled helper: ${permission.helperId}`;
  }
}
export function PermissionReview({
  review,
  dotName,
  onTeach,
  onCancel,
  initialSettings = {},
  mode = 'teach',
}: {
  mode?: 'teach' | 'install';
  initialSettings?: Record<string, JsonValue>;
  review: AbilityReview;
  dotName: string;
  onTeach(
    settings: Record<string, JsonValue>,
    acceptedNotices?: string[],
  ): Promise<void>;
  onCancel(): void;
}) {
  const manifest = review.descriptor.manifest,
    active = useRef(false);
  const [busy, setBusy] = useState(false),
    [settings, setSettings] = useState(
      JSON.stringify(initialSettings, null, 2),
    ),
    [error, setError] = useState('');
  const [consent, setConsent] = useState({
    reviewId: review.id,
    ids: [] as string[],
  });
  const accepted = consent.reviewId === review.id ? consent.ids : [];
  const missingConsent = (manifest.notices ?? []).some(
    (notice) => notice.required && !accepted.includes(notice.id),
  );
  const runtimes = [
    ...new Set([
      manifest.entrypoint.runtime,
      ...manifest.helpers.map((helper) => helper.entrypoint.runtime),
    ]),
  ].map(
    (runtime) =>
      ({
        javascript: 'JavaScript',
        python: 'Python',
        native: 'Native executable',
      })[runtime],
  );
  const submit = async () => {
    if (active.current || missingConsent) return;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      const value = validateValue(
        manifest.settings,
        JSON.parse(settings),
      ) as Record<string, JsonValue>;
      if (accepted.length) await onTeach(value, accepted);
      else await onTeach(value);
    } catch {
      setError(
        'Could not approve this Ability. Check the settings or review the release again.',
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="ability-review" aria-label="Review Ability permissions">
      <div className="ability-heading">
        <div>
          <strong>{manifest.name}</strong>
          <span>
            {mode === 'install' ? 'Install in workspace' : `Teach ${dotName}`} ·
            v{manifest.version}
          </span>
        </div>
      </div>
      <p>{manifest.description}</p>
      {review.localSource && (
        <p>
          Local package: <code>{review.localSource}</code>
          <br />
          Publisher and source below are declared by this file.
        </p>
      )}
      <p className="ability-source">
        <a
          href={`https://github.com/${manifest.source.owner}/${manifest.source.repository}/commit/${review.descriptor.sourceCommit}`}
          target="_blank"
          rel="noreferrer"
        >
          {manifest.source.owner}/{manifest.source.repository}
        </a>{' '}
        · {manifest.publisher} · {manifest.license}
      </p>
      <p>{runtimes.join(' · ')} · macOS Apple Silicon</p>
      {review.changes.some((change) => change.requiresConsent) && (
        <p>
          <strong>Changed access</strong> — review the permissions below.
        </p>
      )}
      <ul className="ability-permissions">
        {manifest.permissions.map((permission) => (
          <li key={permission.id}>
            <strong>{permission.purpose}</strong>
            <code>{permissionSummary(permission)}</code>
            {permission.kind === 'oauth' && (
              <details>
                <summary>Account access</summary>
                <p>{permission.scopes.join(', ')}</p>
                <code>{permission.tokenUrl}</code>
              </details>
            )}
            {permission.kind === 'https' && (
              <details>
                <summary>Request limits</summary>
                <pre>
                  {JSON.stringify(
                    {
                      path: permission.pathValues,
                      query: permission.query,
                      ...(permission.body ? { body: permission.body } : {}),
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ul>
      <p>
        Runs code with the access above and read/write access to its own private
        folder. Approved actions run without further permission prompts.
      </p>
      {review.storage && (
        <div className="ability-file-access">
          <p>
            Read only: <code>{review.storage.packagePath}</code>
          </p>
          <p>
            Read and write: its private subfolder inside{' '}
            <code>{review.storage.stateParent}</code>
          </p>
        </div>
      )}
      {manifest.tools.some((tool) => tool.visibility === 'model-visible') && (
        <p>Some tool results can be sent to your AI provider.</p>
      )}
      {manifest.settings.required.length > 0 && (
        <label>
          Required settings
          <textarea
            aria-label="Required Ability settings"
            value={settings}
            onChange={(event) => setSettings(event.target.value)}
            spellCheck={false}
          />
          <small>
            Provide: {manifest.settings.required.join(', ')}. Settings are not
            secret storage.
          </small>
        </label>
      )}
      {(manifest.notices ?? []).map((notice) => (
        <div key={notice.id} className="ability-notice">
          <details>
            <summary>{notice.title}</summary>
            <div className="ability-notice-text">{notice.text}</div>
          </details>
          {notice.required && (
            <label>
              <input
                type="checkbox"
                checked={accepted.includes(notice.id)}
                disabled={busy}
                onChange={(event) =>
                  setConsent({
                    reviewId: review.id,
                    ids: event.target.checked
                      ? [...accepted, notice.id]
                      : accepted.filter((id) => id !== notice.id),
                  })
                }
              />
              I agree to {notice.title}.
            </label>
          )}
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
      <div className="ability-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || missingConsent}
          onClick={submit}
        >
          {mode === 'install'
            ? busy
              ? 'Installing…'
              : 'Install'
            : busy
              ? 'Teaching…'
              : 'Teach'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
