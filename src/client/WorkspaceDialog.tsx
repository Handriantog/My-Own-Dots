import { LocalLearningSettings } from './LocalLearningSettings';
import { useEffect, useRef, useState } from 'react';
import { Archive, Plug, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';
import type { Dot, Memory, State, WorkspaceState } from '../shared/types';
import { ConnectionsSection } from './ConnectionsSection';
import { StorageSettings } from './StorageSettings';
import { VoiceSettings } from './local-voice/VoiceSettings';
import type { LocalVoiceStatus } from '../shared/local-voice';
import {
  setThemePreference,
  themePreference,
  type ThemePreference,
} from './theme';
export type Dialog =
  | { type: 'space' }
  | { type: 'dot'; dot?: Dot; spaceId: string }
  | { type: 'settings' }
  | { type: 'memory'; memory?: Memory }
  | { type: 'schedule'; threadId: string };
export function WorkspaceDialog({
  dialog,
  state,
  workspace,
  onClose,
  mutate,
  embedded = false,
  voiceStatus,
  voiceActive = false,
  onVoiceSettingsSaved,
}: {
  dialog: Dialog;
  embedded?: boolean;
  voiceStatus?: LocalVoiceStatus;
  voiceActive?: boolean;
  onVoiceSettingsSaved?: () => void;
  state: State;
  workspace: WorkspaceState;
  onClose: () => void;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const [name, setName] = useState(
    dialog.type === 'dot' ? (dialog.dot?.name ?? '') : '',
  );
  const [text, setText] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.instructions ?? '')
      : dialog.type === 'memory'
        ? (dialog.memory?.text ?? '')
        : '',
  );
  const [research, setResearch] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.researchAllowed ?? true)
      : state.settings.researchAllowed,
  );
  const [memory, setMemory] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.memoryAllowed ?? true)
      : state.settings.memoryAllowed,
  );
  const [apps, setApps] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.appsAllowed ?? false)
      : state.settings.appsAllowed,
  );
  const [composioToolkits, setComposioToolkits] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.composioToolkits ?? []).join(', ')
      : '',
  );
  const [spaceIds, setSpaceIds] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceIds ?? [dialog.spaceId]) : [],
  );
  const [defaultSpace, setDefaultSpace] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceId ?? dialog.spaceId) : '',
  );
  const [interval, setInterval] = useState('86400');
  const [learningContainer, setLearningContainer] = useState(
    dialog.type === 'dot' ? (dialog.dot?.learningContainerId ?? '') : '',
  );
  const [skillDelivery, setSkillDelivery] = useState(
    dialog.type === 'dot' ? (dialog.dot?.skillDeliveryEnabled ?? false) : false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [settingsSection, setSettingsSection] = useState('general');
  const [theme, setTheme] = useState(themePreference);
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    if (embedded) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    container.current
      ?.querySelector<HTMLElement>('input,textarea,select')
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = [
          ...(container.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input,textarea,select,a[href],summary',
          ) ?? []),
        ];
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  const title =
    dialog.type === 'space'
      ? 'New Space'
      : dialog.type === 'dot'
        ? dialog.dot
          ? 'Edit Dot'
          : 'New Dot'
        : dialog.type === 'settings'
          ? 'Settings'
          : dialog.type === 'memory'
            ? 'Edit memory'
            : 'Schedule a task';
  const nativeAction = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not open native settings.',
      );
    }
  };
  return (
    <div
      className={embedded ? 'settings-page' : 'modal-backdrop'}
      onClick={embedded ? undefined : onClose}
    >
      <section
        className={`modal ${embedded ? 'settings-content' : ''} ${dialog.type === 'settings' ? 'settings-panel' : ''}`}
        role={embedded ? undefined : 'dialog'}
        aria-modal={embedded ? undefined : true}
        aria-labelledby="dialog-title"
        ref={container}
        onClick={(e) => e.stopPropagation()}
      >
        {!embedded && (
          <button
            className="modal-close icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        )}
        {dialog.type !== 'settings' && (
          <span className="eyebrow">MY OWN DOTS</span>
        )}
        <h2 id="dialog-title">{title}</h2>
        {dialog.type === 'settings' && (
          <>
            <nav className="settings-tabs" aria-label="Settings categories">
              {[
                { id: 'general', label: 'General', icon: SlidersHorizontal },
                { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
                { id: 'services', label: 'Connections', icon: Plug },
                { id: 'storage', label: 'Backup & restore', icon: Archive },
              ].map(({ id, label, icon: Icon }) => (
                <button
                  type="button"
                  key={id}
                  className={settingsSection === id ? 'active' : ''}
                  aria-current={settingsSection === id ? 'page' : undefined}
                  onClick={() => setSettingsSection(id)}
                >
                  <Icon size={16} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </nav>
          </>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            let path = '',
              method = 'POST',
              body: unknown;
            if (dialog.type === 'space') {
              path = '/spaces';
              body = { name, description: text };
            }
            if (dialog.type === 'dot') {
              path = dialog.dot ? `/dots/${dialog.dot.id}` : '/dots';
              method = dialog.dot ? 'PUT' : 'POST';
              body = {
                spaceId: defaultSpace,
                spaceIds,
                name,
                instructions: text,
                researchAllowed: research,
                memoryAllowed: memory,
                appsAllowed: apps,
                composioToolkits: composioToolkits
                  .split(',')
                  .map((slug) => slug.trim())
                  .filter(Boolean),
                learningContainerId: learningContainer.trim() || null,
                skillDeliveryEnabled: skillDelivery,
              };
            }
            if (dialog.type === 'settings') {
              path = '/settings';
              method = 'PATCH';
              body = {
                researchAllowed: research,
                memoryAllowed: memory,
                appsAllowed: apps,
              };
            }
            if (dialog.type === 'memory') {
              path = dialog.memory
                ? `/memories/${dialog.memory.id}`
                : '/memories';
              method = dialog.memory ? 'PUT' : 'POST';
              body = { text };
            }
            if (dialog.type === 'schedule') {
              path = '/tasks';
              body = {
                prompt: text,
                threadId: dialog.threadId,
                intervalSeconds: Number(interval),
              };
            }
            if (await mutate(path, method, body)) onClose();
            else
              setError('Could not save. Review the workspace error and retry.');
            setBusy(false);
          }}
        >
          {(dialog.type === 'space' || dialog.type === 'dot') && (
            <>
              <label className="field-label" htmlFor="entity-name">
                Name
              </label>
              <input
                id="entity-name"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </>
          )}
          {dialog.type !== 'settings' && (
            <>
              <label className="field-label" htmlFor="entity-text">
                {dialog.type === 'dot'
                  ? 'Role instructions'
                  : dialog.type === 'space'
                    ? 'What belongs here?'
                    : dialog.type === 'memory'
                      ? 'Preference or context'
                      : 'Task to revisit'}
              </label>
              <textarea
                id="entity-text"
                rows={4}
                maxLength={dialog.type === 'schedule' ? 4000 : 2000}
                required={dialog.type !== 'space'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  dialog.type === 'dot'
                    ? 'You are a thoughtful research partner. Compare evidence and be clear about uncertainty.'
                    : ''
                }
              />
            </>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Space access</legend>
              <p className="muted">
                Choose where this Dot can read and edit pages.
              </p>
              {workspace.spaces.map((space) => (
                <label className="permission-row" key={space.id}>
                  <input
                    type="checkbox"
                    checked={spaceIds.includes(space.id)}
                    onChange={(event) => {
                      const next = event.target.checked
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
              <label className="field-label" htmlFor="default-space">
                Default destination for saved pages
              </label>
              <select
                id="default-space"
                value={defaultSpace}
                required
                onChange={(event) => setDefaultSpace(event.target.value)}
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
            </fieldset>
          )}
          {dialog.type === 'dot' && dialog.dot && (
            <VoiceSettings
              dotId={dialog.dot.id}
              initiallyOpen
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
          )}
          {dialog.type === 'dot' && !dialog.dot && (
            <p>Create this Dot to choose its voice chat quality.</p>
          )}
          {(dialog.type === 'dot' ||
            (dialog.type === 'settings' &&
              settingsSection === 'permissions')) && (
            <div
              className={
                dialog.type === 'settings'
                  ? 'settings-permission-group'
                  : undefined
              }
            >
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={research}
                  onChange={(e) => setResearch(e.target.checked)}
                />
                <span>
                  <strong>Public-page research</strong>
                  <small>
                    {dialog.type === 'settings'
                      ? 'Read public web pages.'
                      : 'Allow the server-side read-only browser tool. Global settings always take precedence.'}
                  </small>
                </span>
              </label>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={memory}
                  onChange={(e) => setMemory(e.target.checked)}
                />
                <span>
                  <strong>Use saved memories</strong>
                  <small>
                    {dialog.type === 'settings'
                      ? 'Recall saved preferences and context.'
                      : 'Allow essential preferences and on-demand recall. Changing permission stops active work.'}
                  </small>
                </span>
              </label>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={apps}
                  onChange={(event) => setApps(event.target.checked)}
                />
                <span>
                  <strong>Connected apps</strong>
                  <small>
                    {dialog.type === 'settings'
                      ? 'Use your connected services.'
                      : 'Allow access to the owner’s apps through Composio. Global settings always take precedence.'}
                  </small>
                </span>
              </label>
              {dialog.type === 'settings' && (
                <p className="settings-footnote">
                  Applies to all Dots. Changes may stop active work.
                </p>
              )}
            </div>
          )}
          {dialog.type === 'dot' &&
            dialog.dot &&
            workspace.setup.conversationBackend === 'local' &&
            workspace.setup.llmBackend === 'subscription' && (
              <LocalLearningSettings
                dotId={dialog.dot.id}
                onChanged={() => {}}
              />
            )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Connected apps</legend>
              <label className="field-label" htmlFor="composio-toolkits">
                Toolkit slugs
              </label>
              <input
                id="composio-toolkits"
                value={composioToolkits}
                pattern="[a-z0-9_]+(, *[a-z0-9_]+)*"
                placeholder="gmail, google_calendar"
                aria-describedby="composio-toolkits-help"
                onChange={(event) => setComposioToolkits(event.target.value)}
              />
              <p className="muted" id="composio-toolkits-help">
                Optional comma-separated Composio toolkit slugs. Leave blank to
                let the Dot search all available toolkits.
              </p>
            </fieldset>
          )}
          {dialog.type === 'dot' &&
            workspace.setup.conversationBackend !== 'local' && (
              <fieldset className="space-access-fields">
                <legend>Automatic Learning</legend>
                <label className="field-label" htmlFor="learning-container">
                  Learning container ID
                </label>
                <input
                  id="learning-container"
                  value={learningContainer}
                  maxLength={64}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  placeholder="research-workflow"
                  aria-describedby="learning-help"
                  onChange={(event) => {
                    setLearningContainer(event.target.value);
                    if (!event.target.value.trim()) setSkillDelivery(false);
                  }}
                />
                <p className="muted" id="learning-help">
                  Create this container in your Intelligence project first. New
                  conversations will contribute evidence to it. Leave blank to
                  keep new conversations out of Learning. Existing conversations
                  retain their original assignment.
                </p>
                <label className="permission-row">
                  <input
                    type="checkbox"
                    checked={skillDelivery}
                    disabled={!learningContainer.trim()}
                    onChange={(event) => setSkillDelivery(event.target.checked)}
                  />
                  <span>
                    <strong>Use published skills</strong>
                    <small>
                      Load reviewed skills from each conversation’s assigned
                      container. Enable delivery in Intelligence too. Turning
                      this off stops skill loading; it does not stop evidence
                      collection.
                    </small>
                  </span>
                </label>
                <a
                  href="https://docs.copilotkit.ai/learning"
                  target="_blank"
                  rel="noreferrer"
                >
                  Set up Learning and review skills ↗
                </a>
              </fieldset>
            )}
          {dialog.type === 'dot' && dialog.dot && (
            <ConnectionsSection dotId={dialog.dot.id} />
          )}
          {dialog.type === 'schedule' && (
            <>
              <label className="field-label" htmlFor="schedule-interval">
                Repeat after each successful run
              </label>
              <select
                id="schedule-interval"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              >
                <option value="60">Every minute (testing)</option>
                <option value="3600">Every hour</option>
                <option value="86400">Every day</option>
                <option value="604800">Every week</option>
              </select>
              <p className="muted">
                Runs on the server in this same conversation, while the
                application is running. Failed or interrupted runs wait for
                manual retry. Review completed work before retrying an
                interrupted run.
              </p>
            </>
          )}
          {dialog.type === 'settings' && settingsSection === 'storage' && (
            <StorageSettings />
          )}
          {dialog.type === 'settings' && settingsSection === 'general' && (
            <div className="settings-row">
              <label htmlFor="settings-theme">Appearance</label>
              <select
                id="settings-theme"
                aria-label="Appearance"
                value={theme}
                onChange={(event) => {
                  const next = event.target.value as ThemePreference;
                  setTheme(next);
                  setThemePreference(next);
                }}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
          )}
          {dialog.type === 'settings' &&
            settingsSection === 'general' &&
            window.dotWorkspace && (
              <section className="native-settings">
                <div>
                  <h3>Desktop companion</h3>
                  <p>Appearance and behavior</p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void nativeAction(() =>
                      window.dotWorkspace!.openPreferences(),
                    )
                  }
                >
                  Customize
                </button>
              </section>
            )}
          {dialog.type === 'settings' && settingsSection === 'services' && (
            <section className="settings-services">
              <dl className="settings-service-list">
                <div>
                  <dt>AI provider</dt>
                  <dd>
                    {workspace.setup.llmBackend === 'subscription'
                      ? `${workspace.setup.llmProvider ?? 'codex'} · Subscription`
                      : 'Model API'}
                  </dd>
                </div>
                <div>
                  <dt>Conversations</dt>
                  <dd>
                    {workspace.setup.conversationBackend === 'local'
                      ? 'Local'
                      : 'Intelligence'}
                  </dd>
                </div>
                <div>
                  <dt>Slack</dt>
                  <dd>{workspace.setup.slack.replaceAll('_', ' ')}</dd>
                </div>
                <div>
                  <dt>Realtime voice</dt>
                  <dd>
                    {workspace.setup.voice ? 'Configured' : 'Not configured'}
                  </dd>
                </div>
                <div>
                  <dt>Connected apps</dt>
                  <dd>
                    {workspace.setup.composio ? 'Configured' : 'Not configured'}
                  </dd>
                </div>
              </dl>
              {workspace.setup.missing.length > 0 && (
                <p className="settings-setup-note">
                  Setup needed: {workspace.setup.missing.join(', ')}
                </p>
              )}
              {window.dotWorkspace && (
                <button
                  type="button"
                  onClick={() =>
                    void nativeAction(() =>
                      window.dotWorkspace!.openBackendSettings(),
                    )
                  }
                >
                  Workspace setup
                </button>
              )}
              <details className="settings-help">
                <summary>Setup details</summary>
                <div>
                  {workspace.setup.llmBackend === 'subscription' && (
                    <p>Sign in to your provider’s CLI on this computer.</p>
                  )}
                  <p>
                    Manage MCP servers, app access and learning in each Dot’s
                    settings.
                  </p>
                  {workspace.setup.missing.length > 0 && (
                    <p>Add the missing environment values, then restart.</p>
                  )}
                  {!workspace.setup.voice && (
                    <p>
                      Realtime voice requires VOICE_API_KEY and VOICE_MODEL.
                      Local voice has its own setup.
                    </p>
                  )}
                  <p>
                    Configured services still need a successful connection test.
                  </p>
                </div>
              </details>
            </section>
          )}
          {dialog.type === 'memory' && (
            <p className="muted">
              Memories are explicit preferences, not automatic learning. Avoid
              secrets; enabled memories go to your model provider.
            </p>
          )}
          {error && (
            <p className="chat-error" role="alert">
              {error}
            </p>
          )}
          {(dialog.type !== 'settings' ||
            settingsSection === 'permissions') && (
            <button className="primary full" disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
