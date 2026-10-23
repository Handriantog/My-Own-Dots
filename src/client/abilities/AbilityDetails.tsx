import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Puzzle } from 'lucide-react';
import type {
  DesktopAbilityOutput,
  DesktopAbilityInput,
} from '../../shared/abilities/desktop';
import type { AbilityLibraryEntry } from '../../shared/abilities/library';
import { AbilityMarkdown } from './AbilityMarkdown';
import { permissionSummary, type AbilityReview } from './PermissionReview';
import { unwrap } from './AbilityHostStatus';

export type AbilitySelection =
  | { kind: 'installed'; ability: DesktopAbilityOutput<'install'> }
  | { kind: 'library'; entry: AbilityLibraryEntry; sourceCommit: string }
  | { kind: 'preview'; review: AbilityReview };

export function abilitySummary(description: string): string {
  return description
    .replace(/[#*_`>[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}
export function AbilityIcon({ large = false }: { large?: boolean }) {
  return (
    <span
      className={`ability-icon${large ? ' ability-icon-large' : ''}`}
      aria-hidden="true"
    >
      <Puzzle size={large ? 44 : 24} strokeWidth={1.5} />
    </span>
  );
}
export function AbilityDetails({
  selection,
  actions,
  children,
  onBack,
}: {
  selection: AbilitySelection;
  actions: ReactNode;
  children?: ReactNode;
  onBack(): void;
}) {
  const [tab, setTab] = useState<'details' | 'permissions'>('details');
  const [document, setDocument] = useState<{
    markdown: string | null;
    failed: boolean;
  }>();
  const manifest =
    selection.kind === 'installed'
      ? selection.ability.manifest
      : selection.kind === 'preview'
        ? selection.review.descriptor.manifest
        : undefined;
  const entry = selection.kind === 'library' ? selection.entry : undefined;
  const digest =
    selection.kind === 'installed' ? selection.ability.digest : undefined;
  const id = entry?.id;
  const sourceCommit =
    selection.kind === 'library' ? selection.sourceCommit : undefined;
  useEffect(() => {
    let current = true;
    const input: DesktopAbilityInput<'documentation'> | undefined = digest
      ? { source: 'installed', digest }
      : id && sourceCommit
        ? { source: 'library', id, sourceCommit }
        : undefined;
    if (!input) return;
    void window.dotAbilities
      ?.documentation(input)
      .then((reply) => {
        const value = unwrap(reply);
        if (current) setDocument({ markdown: value.markdown, failed: false });
      })
      .catch(() => {
        if (current) setDocument({ markdown: null, failed: true });
      });
    return () => {
      current = false;
    };
  }, [digest, id, sourceCommit]);
  const name = manifest?.name ?? entry!.name;
  const publisher = manifest?.publisher ?? entry!.publisher;
  const version = manifest?.version ?? entry?.version;
  const sourceUrl =
    entry?.sourceUrl ??
    (selection.kind === 'preview'
      ? selection.review.descriptorUrl
      : `https://github.com/${manifest!.source.owner}/${manifest!.source.repository}`);
  const fallback =
    manifest?.description ?? 'Documentation is not available yet.';
  return (
    <article className="ability-detail" aria-label={`${name} details`}>
      <button type="button" className="ability-back" onClick={onBack}>
        <ArrowLeft size={15} />
        Back to Abilities
      </button>
      <header className="ability-detail-header">
        <AbilityIcon large />
        <div className="ability-detail-title">
          <h1>{name}</h1>
          <div className="ability-publisher">
            <span>{publisher}</span>
            {version && <span>v{version}</span>}
          </div>
          {manifest && (
            <p className="ability-summary">
              {abilitySummary(manifest.description)}
            </p>
          )}
          <div className="ability-actions">{actions}</div>
          {selection.kind === 'installed' && (
            <p className="ability-detail-status">
              {selection.ability.restored
                ? 'Review this release again to restore access.'
                : selection.ability.enabled
                  ? 'Enabled in this workspace.'
                  : 'Disabled in this workspace.'}{' '}
              {!selection.ability.restored &&
                `${selection.ability.enabledDots} ${selection.ability.enabledDots === 1 ? 'Dot selected' : 'Dots selected'}.`}
            </p>
          )}
          {entry && entry.status !== 'released' && (
            <p className="ability-detail-status">
              Not yet released ·{' '}
              {entry.status === 'planned' ? 'Planned' : 'In development'}
            </p>
          )}
        </div>
      </header>
      {children}
      <div className="ability-detail-tabs" aria-label="Ability information">
        <button
          type="button"
          aria-pressed={tab === 'details'}
          onClick={() => setTab('details')}
        >
          Details
        </button>
        {manifest && (
          <button
            type="button"
            aria-pressed={tab === 'permissions'}
            onClick={() => setTab('permissions')}
          >
            Permissions
          </button>
        )}
      </div>
      <div className="ability-detail-content">
        <div className="ability-document">
          {tab === 'permissions' && manifest ? (
            <ul className="ability-permissions">
              {manifest.permissions.map((permission) => (
                <li key={permission.id}>
                  <strong>{permission.purpose}</strong>
                  <code>{permissionSummary(permission)}</code>
                </li>
              ))}
            </ul>
          ) : (
            <>
              {!document && selection.kind !== 'preview' && (
                <p className="muted" role="status">
                  Loading documentation…
                </p>
              )}
              {document?.failed && (
                <p className="muted" role="status">
                  Could not load the full README.
                </p>
              )}
              <AbilityMarkdown>
                {document?.markdown ?? fallback}
              </AbilityMarkdown>
            </>
          )}
        </div>
        <aside className="ability-metadata" aria-label="Ability metadata">
          <h2>Resources</h2>
          <a href={sourceUrl} target="_blank" rel="noreferrer">
            {selection.kind === 'preview' && selection.review.localSource
              ? 'Declared source'
              : 'Source on GitHub'}
          </a>
          <h2>Details</h2>
          <dl>
            <dt>License</dt>
            <dd>{manifest?.license ?? entry!.license}</dd>
            <dt>Identifier</dt>
            <dd>{manifest?.id ?? entry!.id}</dd>
            {version && (
              <>
                <dt>Version</dt>
                <dd>{version}</dd>
              </>
            )}
          </dl>
        </aside>
      </div>
    </article>
  );
}
