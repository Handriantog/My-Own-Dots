import { useEffect, useRef, useState } from 'react';
import './storage-settings.css';
import type {
  DesktopStorageBridge,
  StorageStatus,
} from '../desktop/shared/storage-contract';

function storageError(error: unknown) {
  return error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        '',
      )
    : 'The operation could not be completed. Please try again.';
}

export function StorageSettings({
  bridge = window.dotStorage,
}: {
  bridge?: DesktopStorageBridge;
}) {
  const [status, setStatus] = useState<StorageStatus>();
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const [view, setView] = useState<'home' | 'backup' | 'restore' | 'upgrade'>(
    'home',
  );
  const [selectedFile, setSelectedFile] = useState('');
  const [protectedBackup, setProtectedBackup] = useState(false);
  const [encryptedRestore, setEncryptedRestore] = useState(false);
  const [remember, setRemember] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    const receive = (value: StorageStatus) => {
      if (mounted) {
        setStatus(value);
        setStatusError('');
        if (
          value.operation &&
          ['queued', 'snapshot', 'archive', 'verify'].includes(
            value.operation.phase,
          )
        )
          setFeedback('');
      }
    };
    void bridge.status().then(receive, (error: unknown) => {
      if (mounted) setStatusError(storageError(error));
    });
    const unsubscribe = bridge.onStatus(receive);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [bridge]);
  if (!bridge)
    return (
      <section>
        <h3>Backup & restore</h3>
        <p>Open the desktop app to back up or restore your data.</p>
      </section>
    );
  const operation = status?.operation;
  const preview = status?.preview;
  const operationBusy =
    !!operation &&
    ['queued', 'snapshot', 'archive', 'verify'].includes(operation.phase);
  const busy = pending || operationBusy;
  const action = async (work: () => Promise<unknown>) => {
    setError('');
    setFeedback('');
    setPending(true);
    try {
      await work();
      setStatus(await bridge.status());
      setStatusError('');
    } catch (error) {
      setError(storageError(error));
    } finally {
      setPending(false);
    }
  };
  const back = () => {
    if (password.current) password.current.value = '';
    setPasswordError('');
    setError('');
    setView('home');
    setSelectedFile('');
  };
  const chooseBackup = (upgrade = false) =>
    void action(async () => {
      const file = await bridge.chooseBackupFile();
      if (!file) return;
      setSelectedFile(file);
      setProtectedBackup(false);
      setRemember(false);
      setPasswordError('');
      setView(upgrade ? 'upgrade' : 'backup');
    });
  const chooseRestore = () =>
    void action(async () => {
      const archive = await bridge.chooseRestoreArchive();
      if (!archive) return;
      setSelectedFile(archive.name);
      setEncryptedRestore(archive.encrypted);
      setPasswordError('');
      setView('restore');
    });
  const submit = () => {
    const required = view === 'restore' ? encryptedRestore : protectedBackup;
    const passphrase = required ? (password.current?.value ?? '') : '';
    if (required && !passphrase) {
      setPasswordError(
        view === 'restore'
          ? 'Enter the password used for this backup.'
          : 'Enter a password, or turn off password protection.',
      );
      password.current?.focus();
      return;
    }
    if (password.current) password.current.value = '';
    setPasswordError('');
    void action(async () => {
      if (view === 'restore') await bridge.previewRestore({ passphrase });
      else if (view === 'upgrade')
        await bridge.previewMigration({ passphrase });
      else {
        await bridge.backupNow({
          passphrase,
          remember: protectedBackup && remember && !!status?.secureStorage,
        });
        setFeedback(`Backup saved to ${selectedFile}`);
        setView('home');
      }
    });
  };
  const progress =
    operation?.phase === 'snapshot'
      ? 'Creating a snapshot of your data…'
      : operation?.phase === 'archive'
        ? 'Saving your backup…'
        : operation?.phase === 'verify'
          ? 'Checking your data…'
          : operation?.phase === 'queued'
            ? 'Preparing…'
            : operation?.phase === 'cancelled'
              ? 'Cancelled. Your current workspace is unchanged.'
              : operation?.phase === 'ready' && operation.kind === 'backup'
                ? 'Backup saved and verified.'
                : '';
  const field = (restoring: boolean) => (
    <label className="storage-password">
      {restoring ? 'Backup password' : 'Password'}
      <input
        ref={password}
        type="password"
        autoComplete={restoring ? 'off' : 'new-password'}
        aria-label={
          restoring ? 'Restore recovery password' : 'Backup recovery password'
        }
        required
        maxLength={4096}
        disabled={busy}
        aria-invalid={!!passwordError}
        aria-describedby={passwordError ? 'storage-password-error' : undefined}
        onChange={() => setPasswordError('')}
      />
      {passwordError && (
        <span id="storage-password-error" role="alert">
          {passwordError}
        </span>
      )}
    </label>
  );
  const showHome = !preview && view === 'home' && !operationBusy;
  return (
    <section className="storage-settings" aria-label="Backup and restore">
      <header className="storage-heading">
        <h3>Backup & restore</h3>
        <p>Keep a copy of your workspace.</p>
      </header>
      {(error || statusError || operation?.error || status?.error) && (
        <p className="storage-message" role="alert">
          {error || statusError || operation?.error || status?.error}
        </p>
      )}
      {(feedback || progress) && (
        <p className="storage-message" role="status">
          {feedback || progress}
        </p>
      )}
      {showHome && (
        <>
          <div className="storage-actions">
            <article className="storage-card">
              <h4>Keep a copy</h4>
              <p>Save a backup file.</p>
              <button
                type="button"
                className="storage-primary"
                disabled={busy}
                onClick={() => chooseBackup()}
              >
                Backup
              </button>
            </article>
            <article className="storage-card">
              <h4>Restore your data</h4>
              <p>Open an existing backup.</p>
              <button type="button" disabled={busy} onClick={chooseRestore}>
                Restore
              </button>
            </article>
          </div>
          <p className="storage-muted">
            Last backup:{' '}
            {status?.lastSuccess
              ? new Date(status.lastSuccess).toLocaleString()
              : 'No backup yet'}
          </p>
          <details
            className="storage-details"
            onToggle={(event) => setAdvanced(event.currentTarget.open)}
          >
            <summary>Advanced options</summary>
            <div className="storage-detail-content">
              <p>
                <strong>Workspace</strong>
                <br />
                {status?.workspaceDirectory ?? 'Starting…'}
              </p>
              <div className="storage-buttons">
                <button
                  type="button"
                  disabled={busy || !status?.workspaceDirectory}
                  onClick={() =>
                    void action(() => bridge.openWorkspaceFolder())
                  }
                >
                  Open workspace folder
                </button>
                {status?.moveAvailable && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(() => bridge.chooseWorkspaceMove())
                    }
                  >
                    Move workspace
                  </button>
                )}
              </div>
              {status?.migrationAvailable && (
                <div className="storage-upgrade">
                  <h4>One-time storage upgrade</h4>
                  <p>Includes a backup. Your original workspace is kept.</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => chooseBackup(true)}
                  >
                    Upgrade storage
                  </button>
                </div>
              )}
              {advanced && (
                <div className="storage-automatic">
                  <h4>Automatic backups</h4>
                  <p>
                    Optional daily backups while Dot is open and idle. First
                    save a password-protected backup with “Remember password”
                    selected.
                  </p>
                  <p>Folder: {status?.destination ?? 'Not selected'}</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(() => bridge.chooseBackupDirectory())
                    }
                  >
                    Choose automatic backup folder
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      aria-label="Automatic daily backups"
                      checked={status?.automatic ?? false}
                      disabled={
                        busy ||
                        (!status?.automatic &&
                          (!status?.secureStorage || !status?.destination))
                      }
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        void action(() => bridge.setAutomatic({ enabled }));
                      }}
                    />
                    Enable daily backups
                  </label>
                  <p className="storage-muted">
                    Keeps seven daily and four weekly recovery points. Your
                    manually saved backups are kept until you delete them.
                  </p>
                </div>
              )}
              <p className="storage-muted">
                Computer files, browser profiles and provider logins are not
                included. Store a copy on another drive to protect against disk
                failure.
              </p>
            </div>
          </details>
        </>
      )}
      {!preview && view !== 'home' && !operationBusy && (
        <div className="storage-step">
          <h4>
            {view === 'restore'
              ? 'Restore a backup'
              : view === 'upgrade'
                ? 'Upgrade storage'
                : 'Save a backup'}
          </h4>
          {view === 'upgrade' && (
            <p>
              Dot will save and verify your backup, then prepare an upgraded
              workspace. Chat will close during this step. You can review the
              result before finishing.
            </p>
          )}
          <p className="storage-file">
            <span>{view === 'restore' ? 'Selected backup' : 'Save to'}</span>
            {selectedFile}
          </p>
          {view === 'restore' ? (
            encryptedRestore ? (
              <>
                <p>This backup is password protected.</p>
                {field(true)}
              </>
            ) : (
              <p className="storage-muted">
                No password needed for this backup.
              </p>
            )
          ) : (
            <>
              <label>
                <input
                  type="checkbox"
                  aria-label="Protect with a password"
                  checked={protectedBackup}
                  disabled={busy}
                  onChange={(event) => {
                    setProtectedBackup(event.target.checked);
                    setPasswordError('');
                    setRemember(false);
                    if (password.current) password.current.value = '';
                  }}
                />
                Protect with a password{' '}
                <span className="storage-muted">(optional)</span>
              </label>
              {protectedBackup ? (
                <>
                  {field(false)}
                  <p className="storage-muted">
                    Keep this password safe. You will need it to restore this
                    backup.
                  </p>
                  {status?.secureStorage && view === 'backup' && (
                    <label>
                      <input
                        type="checkbox"
                        checked={remember}
                        disabled={busy}
                        onChange={(event) => setRemember(event.target.checked)}
                      />
                      Remember password for automatic backups
                    </label>
                  )}
                </>
              ) : (
                <p className="storage-muted">
                  Anyone with this file can read its contents.
                </p>
              )}
            </>
          )}
          <div className="storage-buttons">
            <button
              type="button"
              className="storage-primary"
              disabled={busy}
              onClick={submit}
            >
              {view === 'restore'
                ? 'Review backup'
                : view === 'upgrade'
                  ? 'Start upgrade'
                  : 'Save backup'}
            </button>
            <button type="button" disabled={busy} onClick={back}>
              Back
            </button>
          </div>
        </div>
      )}
      {preview && (
        <div className="storage-step">
          <h4>
            {preview.migration
              ? 'Ready to finish the upgrade'
              : preview.movement
                ? 'Ready to move'
                : 'Ready to restore'}
          </h4>
          <p className="storage-counts">
            {preview.counts.local_ai_threads ??
              preview.counts.conversation_threads ??
              0}{' '}
            conversations · {preview.counts.memory_items ?? 0} memories ·{' '}
            {preview.counts.pages ?? 0} pages
          </p>
          <p>
            Your current workspace is kept. The verified copy will open when you
            continue.
          </p>
          <details className="storage-details">
            <summary>View details</summary>
            <div className="storage-detail-content">
              {preview.destination && <p>Workspace: {preview.destination}</p>}
              {preview.backupPath && <p>Backup: {preview.backupPath}</p>}
            </div>
          </details>
          {preview.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <div className="storage-buttons">
            <button
              type="button"
              className="storage-primary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const input = { operationId: preview.operationId };
                  if (preview.migration) await bridge.migrate(input);
                  else if (preview.movement) await bridge.moveWorkspace(input);
                  else await bridge.restore({ ...input, mode: 'new' });
                  setView('home');
                })
              }
            >
              {preview.migration
                ? 'Finish upgrade'
                : preview.movement
                  ? 'Move workspace'
                  : 'Restore'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await bridge.cancel(preview.operationId);
                  back();
                })
              }
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {status?.recoveryWarnings?.map((warning) => (
        <p role="alert" key={warning}>
          {warning}
        </p>
      ))}
      {operationBusy && (
        <button
          type="button"
          onClick={() => void action(() => bridge.cancel(operation!.id))}
        >
          Cancel operation
        </button>
      )}
    </section>
  );
}
