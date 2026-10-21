import { DotConfiguration } from './DotConfiguration';
import { useEffect, useRef, useState } from 'react';
import { Archive, Plug, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';
import type { Dot, Memory, State, WorkspaceState } from '../shared/types';
import { StorageSettings } from './StorageSettings';
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
export function WorkspaceDialog(
  props: Parameters<typeof WorkspaceFormDialog>[0],
) {
  return props.dialog.type === 'dot' ? (
    <DotConfiguration
      key={props.dialog.dot?.id ?? 'new-dot'}
      {...props}
      dialog={props.dialog}
    />
  ) : (
    <WorkspaceFormDialog {...props} dialog={props.dialog} />
  );
}
function WorkspaceFormDialog({
  dialog,
  state,
  workspace,
  onClose,
  mutate,
  embedded = false,
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
  const [name, setName] = useState('');
  const [text, setText] = useState(
    dialog.type === 'memory' ? (dialog.memory?.text ?? '') : '',
  );
  const [research, setResearch] = useState(state.settings.researchAllowed);
  const [memory, setMemory] = useState(state.settings.memoryAllowed);
  const [apps, setApps] = useState(state.settings.appsAllowed);
  const [interval, setInterval] = useState('86400');
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
          {dialog.type === 'space' && (
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
                {dialog.type === 'space'
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
              />
            </>
          )}
          {dialog.type === 'settings' && settingsSection === 'permissions' && (
            <div className="settings-permission-group">
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={research}
                  onChange={(e) => setResearch(e.target.checked)}
                />
                <span>
                  <strong>Public-page research</strong>
                  <small>Read public web pages.</small>
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
                  <small>Recall saved preferences and context.</small>
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
                  <small>Use your connected services.</small>
                </span>
              </label>
              {dialog.type === 'settings' && (
                <p className="settings-footnote">
                  Applies to all Dots. Changes may stop active work.
                </p>
              )}
            </div>
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
