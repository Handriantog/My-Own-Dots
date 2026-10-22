import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Brain, Layers, Mic, Plug, SlidersHorizontal, X } from 'lucide-react';
import type { Dot, State, WorkspaceState } from '../shared/types';
import type { LocalVoiceStatus } from '../shared/local-voice';
import { Mascot } from './Mascot';
import { ConnectionsSection } from './ConnectionsSection';
import { LocalLearningSettings } from './LocalLearningSettings';
import { VoiceSettings } from './local-voice/VoiceSettings';

const categories = [
  {
    id: 'general',
    label: 'General',
    icon: SlidersHorizontal,
    description: 'Give your Dot a name and a role.',
  },
  {
    id: 'access',
    label: 'Access',
    icon: Layers,
    description: 'Choose the Spaces and tools this Dot can use.',
  },
  {
    id: 'voice',
    label: 'Voice',
    icon: Mic,
    description: 'Choose how your Dot sounds and responds.',
  },
  {
    id: 'learning',
    label: 'Learning',
    icon: Brain,
    description: 'Control what your Dot learns from experience.',
  },
  {
    id: 'connections',
    label: 'Connections',
    icon: Plug,
    description: 'Connect apps and tools to this Dot.',
  },
] as const;
type Category = (typeof categories)[number]['id'];

export function DotConfiguration({
  dialog,
  workspace,
  state,
  onClose,
  mutate,
  embedded = false,
  voiceStatus,
  voiceActive = false,
  onVoiceSettingsSaved,
}: {
  dialog: { type: 'dot'; dot?: Dot; spaceId: string };
  workspace: WorkspaceState;
  state: State;
  onClose: () => void;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
  embedded?: boolean;
  voiceStatus?: LocalVoiceStatus;
  voiceActive?: boolean;
  onVoiceSettingsSaved?: () => void;
}) {
  const dot = dialog.dot;
  const [section, setSection] = useState<Category>('general');
  const [visited, setVisited] = useState<Set<Category>>(
    () => new Set(['general']),
  );
  const [name, setName] = useState(dot?.name ?? '');
  const [instructions, setInstructions] = useState(dot?.instructions ?? '');
  const [spaceIds, setSpaceIds] = useState(dot?.spaceIds ?? [dialog.spaceId]);
  const [defaultSpace, setDefaultSpace] = useState(
    dot?.spaceId ?? dialog.spaceId,
  );
  const [research, setResearch] = useState(dot?.researchAllowed ?? true);
  const [memory, setMemory] = useState(dot?.memoryAllowed ?? true);
  const [apps, setApps] = useState(dot?.appsAllowed ?? false);
  const [toolkits, setToolkits] = useState(
    (dot?.composioToolkits ?? []).join(', '),
  );
  const [learningContainer, setLearningContainer] = useState(
    dot?.learningContainerId ?? '',
  );
  const [skillDelivery, setSkillDelivery] = useState(
    dot?.skillDeliveryEnabled ?? false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [desktopDotId, setDesktopDotId] = useState(workspace.desktopDotId);
  const [selectingDesktop, setSelectingDesktop] = useState(false);
  useEffect(
    () => setDesktopDotId(workspace.desktopDotId),
    [workspace.desktopDotId],
  );
  const root = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const saving = useRef(false);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  const local = workspace.setup.conversationBackend === 'local';
  const localLearning = local && workspace.setup.llmBackend === 'subscription';
  const current = categories.find((c) => c.id === section)!;
  const navigate = (next: Category) => {
    setSection(next);
    setVisited((previous) => new Set([...previous, next]));
    content.current?.scrollTo({ top: 0 });
  };
  useEffect(() => {
    if (embedded) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    root.current?.querySelector<HTMLInputElement>('#entity-name')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving.current) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const items = [
        ...(root.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary',
        ) ?? []),
      ].filter((item) => item.getClientRects().length > 0);
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault();
        items[0]?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [embedded]);
  const invalid = (category: Category, message: string, field: string) => {
    navigate(category);
    setError(message);
    requestAnimationFrame(() => {
      const target = root.current?.querySelector<HTMLElement>(`#${field}`);
      const details = target?.closest('details');
      if (details) details.open = true;
      target?.focus();
    });
  };
  const save = async () => {
    if (saving.current) return;
    if (!name.trim() || !instructions.trim()) {
      invalid(
        'general',
        'Add a name and role instructions for this Dot.',
        !name.trim() ? 'entity-name' : 'entity-text',
      );
      return;
    }
    if (!spaceIds.length || !spaceIds.includes(defaultSpace)) {
      invalid(
        'access',
        'Choose at least one Space and a default destination.',
        'default-space',
      );
      return;
    }
    if (toolkits && !/^[a-z0-9_]+(, *[a-z0-9_]+)*$/.test(toolkits)) {
      invalid(
        'connections',
        'Use comma-separated toolkit names, such as gmail, google_calendar.',
        'composio-toolkits',
      );
      return;
    }
    if (
      !local &&
      learningContainer &&
      !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(learningContainer)
    ) {
      invalid(
        'learning',
        'Use a learning container ID with lowercase letters, numbers and hyphens.',
        'learning-container',
      );
      return;
    }
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const saved = await mutate(
        dot ? `/dots/${dot.id}` : '/dots',
        dot ? 'PUT' : 'POST',
        {
          name: name.trim(),
          instructions,
          spaceId: defaultSpace,
          spaceIds,
          researchAllowed: research,
          memoryAllowed: memory,
          appsAllowed: apps,
          composioToolkits: toolkits
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          learningContainerId: learningContainer.trim() || null,
          skillDeliveryEnabled: skillDelivery,
        },
      );
      if (saved) onClose();
      else setError('Could not save. Please try again.');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not save. Please try again.',
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const panel = (id: Category, children: ReactNode) => (
    <section
      key={id}
      hidden={section !== id}
      aria-labelledby={`dot-category-${id}`}
      className="dot-config-panel"
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' &&
          event.target instanceof HTMLInputElement &&
          (id === 'voice' || (id === 'learning' && local))
        )
          event.preventDefault();
      }}
    >
      {children}
    </section>
  );
  const coreDirty =
    name !== (dot?.name ?? '') ||
    instructions !== (dot?.instructions ?? '') ||
    defaultSpace !== (dot?.spaceId ?? dialog.spaceId) ||
    JSON.stringify(spaceIds) !==
      JSON.stringify(dot?.spaceIds ?? [dialog.spaceId]) ||
    research !== (dot?.researchAllowed ?? true) ||
    memory !== (dot?.memoryAllowed ?? true) ||
    apps !== (dot?.appsAllowed ?? false) ||
    toolkits !== (dot?.composioToolkits ?? []).join(', ') ||
    learningContainer !== (dot?.learningContainerId ?? '') ||
    skillDelivery !== (dot?.skillDeliveryEnabled ?? false);
  const separateSave =
    !!dot && (section === 'voice' || (section === 'learning' && local));
  return (
    <div
      className={embedded ? 'dot-config-page' : 'modal-backdrop'}
      onClick={embedded || busy ? undefined : onClose}
    >
      <section
        id="dot-configuration"
        className="modal dot-configuration"
        role={embedded ? undefined : 'dialog'}
        aria-modal={embedded ? undefined : true}
        aria-labelledby="dot-config-title"
        ref={root}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="dot-config-header">
          <div className="dot-config-avatar" aria-hidden="true">
            <Mascot
              identity={dot?.id ?? 'new-dot'}
              name={dot?.name}
              small
              decorative
            />
          </div>
          <div>
            <h2 id="dot-config-title">{dot ? 'Dot settings' : 'New Dot'}</h2>
            <p>{dot?.name || 'Make a Dot your own'}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="dot-config-layout">
            <nav
              className="dot-config-nav"
              aria-label="Dot settings categories"
            >
              {categories.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  id={`dot-category-${id}`}
                  type="button"
                  aria-label={label}
                  aria-current={section === id ? 'page' : undefined}
                  onClick={() => navigate(id)}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
            <div className="dot-config-content" ref={content}>
              <div className="dot-config-heading">
                <h3>{current.label}</h3>
                <p>{current.description}</p>
              </div>
              {panel(
                'general',
                <>
                  <label className="field-label" htmlFor="entity-name">
                    Name
                  </label>
                  <input
                    id="entity-name"
                    value={name}
                    maxLength={40}
                    required
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Research partner"
                  />
                  {typeof window !== 'undefined' && window.dotWorkspace && (
                    <div className="dot-config-appearance">
                      <span>Appearance</span>
                      <button
                        type="button"
                        disabled={!dot}
                        onClick={() => {
                          void window
                            .dotWorkspace!.openPreferences(dot!.id)
                            .catch((cause) =>
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : 'Could not open customization.',
                              ),
                            );
                        }}
                      >
                        Customize…
                      </button>
                      {dot ? (
                        <button
                          type="button"
                          disabled={selectingDesktop || desktopDotId === dot.id}
                          onClick={async () => {
                            setSelectingDesktop(true);
                            setError('');
                            try {
                              await window.dotWorkspace!.selectDesktopDot(
                                dot.id,
                              );
                              setDesktopDotId(dot.id);
                            } catch (cause) {
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : 'Could not select desktop Dot.',
                              );
                            } finally {
                              setSelectingDesktop(false);
                            }
                          }}
                        >
                          {desktopDotId === dot.id
                            ? 'On desktop'
                            : 'Use on desktop'}
                        </button>
                      ) : (
                        <small>Create this Dot to customize it.</small>
                      )}
                    </div>
                  )}
                  <label className="field-label" htmlFor="entity-text">
                    Role instructions
                  </label>
                  <textarea
                    id="entity-text"
                    rows={7}
                    maxLength={2000}
                    required
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="What should this Dot help with? Describe its role, approach and preferences."
                  />
                  <p className="dot-config-hint">
                    Give it a focus, a tone, and anything it should keep in
                    mind.
                  </p>
                </>,
              )}
              {panel(
                'access',
                <>
                  <fieldset>
                    <legend>Permissions</legend>
                    {(
                      [
                        [
                          'Public-page research',
                          'Read public web pages.',
                          research,
                          setResearch,
                          state.settings.researchAllowed,
                        ],
                        [
                          'Use saved memories',
                          'Recall your preferences and context.',
                          memory,
                          setMemory,
                          state.settings.memoryAllowed,
                        ],
                        [
                          'Connected apps',
                          'Use your connected services.',
                          apps,
                          setApps,
                          state.settings.appsAllowed,
                        ],
                      ] as const
                    ).map(
                      ([
                        label,
                        description,
                        checked,
                        change,
                        globalAllowed,
                      ]) => (
                        <label className="permission-row" key={label}>
                          <span>
                            <strong>{label}</strong>
                            <small>
                              {description}
                              {globalAllowed === false
                                ? ' Disabled in workspace settings.'
                                : ''}
                            </small>
                          </span>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => change(e.target.checked)}
                          />
                        </label>
                      ),
                    )}
                    <p className="dot-config-hint">
                      Workspace permissions apply first. Changes may stop active
                      work.
                    </p>
                  </fieldset>
                  <fieldset>
                    <legend>Spaces</legend>
                    <p className="dot-config-hint">
                      This Dot can read and edit pages in selected Spaces.
                    </p>
                    <div className="dot-config-spaces">
                      {workspace.spaces.map((space) => (
                        <label className="permission-row" key={space.id}>
                          <input
                            type="checkbox"
                            aria-label={`Access ${space.name}`}
                            checked={spaceIds.includes(space.id)}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...spaceIds, space.id]
                                : spaceIds.filter((id) => id !== space.id);
                              setSpaceIds(next);
                              if (!next.includes(defaultSpace))
                                setDefaultSpace(next[0] ?? '');
                            }}
                          />
                          <span>{space.name}</span>
                        </label>
                      ))}
                    </div>
                    <div className="dot-config-destination">
                      {' '}
                      <label className="field-label" htmlFor="default-space">
                        Save new pages to
                      </label>
                      <select
                        id="default-space"
                        required
                        value={defaultSpace}
                        onChange={(e) => setDefaultSpace(e.target.value)}
                      >
                        <option value="" disabled>
                          Choose a Space
                        </option>
                        {workspace.spaces
                          .filter((space) => spaceIds.includes(space.id))
                          .map((space) => (
                            <option key={space.id} value={space.id}>
                              {space.name}
                            </option>
                          ))}
                      </select>
                    </div>
                  </fieldset>
                </>,
              )}
              {panel(
                'voice',
                dot ? (
                  visited.has('voice') && (
                    <VoiceSettings
                      dotId={dot.id}
                      initiallyOpen
                      standalone
                      active={section === 'voice'}
                      callActive={voiceActive}
                      previewReady={
                        voiceStatus?.modes?.medium.ready ??
                        (voiceStatus?.selectedQuality !== 'basic' &&
                          !!voiceStatus?.ready)
                      }
                      status={voiceStatus}
                      unavailableReason={voiceStatus?.reason}
                      onSaved={onVoiceSettingsSaved}
                    />
                  )
                ) : (
                  <p className="dot-config-empty">
                    Create this Dot to choose its voice and personality.
                  </p>
                ),
              )}
              {panel(
                'learning',
                local ? (
                  dot && localLearning ? (
                    visited.has('learning') && (
                      <LocalLearningSettings
                        dotId={dot.id}
                        onChanged={() => {}}
                      />
                    )
                  ) : (
                    <p className="dot-config-empty">
                      {!dot
                        ? 'Create this Dot to configure its learning.'
                        : 'Local learning is available with subscription AI.'}
                    </p>
                  )
                ) : (
                  <>
                    <label className="field-label" htmlFor="learning-container">
                      Learning container ID
                    </label>
                    <input
                      id="learning-container"
                      value={learningContainer}
                      maxLength={64}
                      placeholder="research-workflow"
                      onChange={(e) => {
                        setLearningContainer(e.target.value);
                        if (!e.target.value.trim()) setSkillDelivery(false);
                      }}
                    />
                    <p className="dot-config-hint">
                      New conversations contribute to this Intelligence
                      container. Leave blank to keep learning off. Existing
                      conversations keep their original assignment.
                    </p>
                    <label className="permission-row">
                      <span>
                        <strong>Use published skills</strong>
                        <small>
                          Load reviewed skills from the conversation’s
                          container. Enable delivery in Intelligence too.
                        </small>
                      </span>
                      <input
                        type="checkbox"
                        checked={skillDelivery}
                        disabled={!learningContainer.trim()}
                        onChange={(e) => setSkillDelivery(e.target.checked)}
                      />
                    </label>
                    <a
                      href="https://docs.copilotkit.ai/learning"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Set up Learning ↗
                    </a>
                  </>
                ),
              )}
              {panel(
                'connections',
                <>
                  {dot ? (
                    visited.has('connections') && (
                      <ConnectionsSection dotId={dot.id} />
                    )
                  ) : (
                    <p className="dot-config-empty">
                      Create this Dot to connect an MCP server.
                    </p>
                  )}
                  <details className="dot-config-advanced">
                    <summary>App toolkit preferences</summary>
                    <label className="field-label" htmlFor="composio-toolkits">
                      Allowed toolkits
                    </label>
                    <input
                      id="composio-toolkits"
                      value={toolkits}
                      placeholder="gmail, google_calendar"
                      onChange={(e) => setToolkits(e.target.value)}
                    />
                    <p className="dot-config-hint">
                      Optional comma-separated Composio names. Leave blank to
                      search all available toolkits. Connected apps permission
                      must also be enabled.
                    </p>
                  </details>
                </>,
              )}
            </div>
          </div>
          <footer className="dot-config-footer">
            <div className="dot-config-feedback">
              {error ? (
                <p role="alert">{error}</p>
              ) : (
                coreDirty && <span>Unsaved Dot changes</span>
              )}
            </div>
            <button type="button" disabled={busy} onClick={onClose}>
              {separateSave && !coreDirty ? 'Done' : 'Cancel'}
            </button>
            {(!separateSave || coreDirty) && (
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Saving…' : dot ? 'Save changes' : 'Create Dot'}
              </button>
            )}
          </footer>
        </form>
      </section>
    </div>
  );
}
