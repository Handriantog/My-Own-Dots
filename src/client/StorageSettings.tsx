import { useEffect, useRef, useState } from 'react';
import './storage-settings.css';
import type {
  DesktopStorageBridge,
  StorageStatus,
} from '../desktop/shared/storage-contract';

export function StorageSettings({
  bridge = window.dotStorage,
}: {
  bridge?: DesktopStorageBridge;
}) {
  const [status, setStatus] = useState<StorageStatus>();
  const [error, setError] = useState('');
  const [remember, setRemember] = useState(false);
  const recoveryPassword = useRef<HTMLInputElement>(null);
  const restorePassword = useRef<HTMLInputElement>(null);
  const migrationPassword = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    void bridge.status().then(
      (value) => {
        if (mounted) setStatus(value);
      },
      () => {
        if (mounted)
          setError(
            'Backup settings are unavailable. Open a workspace and retry.',
          );
      },
    );
    const unsubscribe = bridge.onStatus((value) => {
      if (mounted) setStatus(value);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [bridge]);
  if (!bridge)
    return (
      <section>
        <h3>Storage & recovery</h3>
        <p>
          Open the desktop application to back up or restore this workspace.
        </p>
      </section>
    );
  const operation = status?.operation;
  const busy =
    !!operation &&
    ['queued', 'snapshot', 'archive', 'verify'].includes(operation.phase);
  const action = async (work: () => Promise<unknown>) => {
    setError('');
    try {
      await work();
      setStatus(await bridge.status());
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message.replace(
              /^Error invoking remote method '[^']+': Error: /,
              '',
            )
          : 'Storage operation failed',
      );
    }
  };
  const readPassword = (field: HTMLInputElement | null) => {
    const value = field?.value ?? '';
    if (field) field.value = '';
    return value;
  };
  const progress =
    operation?.phase === 'snapshot'
      ? 'Creating a consistent snapshot…'
      : operation?.phase === 'archive'
        ? 'Encrypting the backup…'
        : operation?.phase === 'verify'
          ? 'Verifying recovery data…'
          : operation?.phase === 'queued'
            ? 'Preparing storage operation…'
            : operation?.phase === 'cancelled'
              ? 'Storage operation cancelled.'
              : operation?.phase === 'ready' && operation.kind === 'backup'
                ? 'Backup verified.'
                : operation?.phase === 'ready' && status?.preview
                  ? status.preview.migration
                    ? 'Migration preview ready.'
                    : 'Restore preview ready.'
                  : '';
  return (
    <section className="storage-settings">
      <h3>Storage & recovery</h3>
      {status?.workspaceDirectory && (
        <p>
          <strong>Workspace folder:</strong> {status.workspaceDirectory}
        </p>
      )}
      {status?.storageEngine && (
        <p>
          Core storage:{' '}
          {status.storageEngine === 'sqlite'
            ? 'Local SQLite — independent of Docker'
            : 'Legacy PostgreSQL'}
        </p>
      )}
      <p>
        Backups include conversations, voice transcripts, memories, pages and
        settings. Computer files, browser profiles and provider logins need
        separate recovery.
      </p>
      <p>
        <strong>Backup folder:</strong> {status?.destination ?? 'Not selected'}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void action(() => bridge.chooseBackupDirectory())}
      >
        Choose backup folder
      </button>
      <p className="field-note">
        Choose a folder outside your workspace. A copy on the same disk does not
        protect against disk failure.
      </p>
      <label>
        Recovery password
        <input
          ref={recoveryPassword}
          type="password"
          autoComplete="new-password"
          aria-label="Backup recovery password"
          disabled={busy}
        />
      </label>
      <label>
        <input
          type="checkbox"
          aria-label="Remember recovery password"
          disabled={busy || !status?.secureStorage}
          checked={remember && !!status?.secureStorage}
          onChange={(event) => setRemember(event.target.checked)}
        />{' '}
        Remember with the operating system’s secure storage
      </label>
      {!status?.secureStorage && (
        <p className="field-note">
          Secure storage is unavailable. You can still make a manual backup with
          a password.
        </p>
      )}
      <p className="field-note">
        Keep this password somewhere safe. You will need it to recover on
        another computer.
      </p>
      <button
        type="button"
        disabled={busy || !status?.destination}
        onClick={() => {
          const passphrase = readPassword(recoveryPassword.current);
          void action(() =>
            bridge.backupNow({
              passphrase,
              remember: remember && !!status?.secureStorage,
            }),
          );
        }}
      >
        Back up now
      </button>
      <p>
        Last attempt:{' '}
        {status?.lastAttempt
          ? new Date(status.lastAttempt).toLocaleString()
          : 'None'}
      </p>
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
        />{' '}
        Back up daily after changes while idle
      </label>
      <p className="field-note">
        Make a backup with “Remember” selected before enabling this. Dot must be
        running. Retain seven daily and four weekly recovery points; overlapping
        points share one archive.
      </p>
      <p>
        Last verified backup:{' '}
        {status?.lastSuccess
          ? new Date(status.lastSuccess).toLocaleString()
          : 'None'}
      </p>
      <hr />
      {status?.migrationAvailable && (
        <>
          <h3>Move core data out of Docker</h3>
          <p>
            Dot will close chat, verify an encrypted backup and prepare a
            separate workspace. Your original data stays in place. Review the
            results before switching.
          </p>
          <label>
            Pre-migration backup password
            <input
              ref={migrationPassword}
              type="password"
              autoComplete="new-password"
              aria-label="Migration recovery password"
              disabled={busy}
            />
          </label>
          <button
            type="button"
            disabled={busy || !status.destination}
            onClick={() => {
              const passphrase = readPassword(migrationPassword.current);
              void action(() => bridge.previewMigration({ passphrase }));
            }}
          >
            Back up and prepare migration
          </button>
          <hr />
        </>
      )}
      <h3>Restore a workspace</h3>
      <p>
        Recovery creates a separate workspace. Schedules remain paused and
        external access needs fresh approval.
      </p>
      <label>
        Archive password
        <input
          ref={restorePassword}
          type="password"
          autoComplete="off"
          aria-label="Restore recovery password"
          disabled={busy}
        />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          const passphrase = readPassword(restorePassword.current);
          void action(() => bridge.previewRestore({ passphrase }));
        }}
      >
        Choose backup and preview restore
      </button>
      {status?.preview && (
        <div>
          <h4>
            {status.preview.migration
              ? 'Migration preview'
              : 'Recovery preview'}
          </h4>
          {status.preview.destination && (
            <p>Prepared workspace: {status.preview.destination}</p>
          )}
          {status.preview.backupPath && (
            <p>Verified backup: {status.preview.backupPath}</p>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void action(() => bridge.cancel(status.preview!.operationId))
            }
          >
            Discard preview
          </button>
          <p>
            {status.preview.counts.local_ai_threads ??
              status.preview.counts.conversation_threads ??
              0}{' '}
            conversations · {status.preview.counts.memory_items ?? 0} memories ·{' '}
            {status.preview.counts.pages ?? 0} pages
          </p>
          {status.preview.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          {status.preview.migration ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void action(() =>
                  bridge.migrate({ operationId: status.preview!.operationId }),
                )
              }
            >
              Switch to verified workspace
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    bridge.restore({
                      operationId: status.preview!.operationId,
                      mode: 'new',
                    }),
                  )
                }
              >
                Open restored workspace
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    bridge.restore({
                      operationId: status.preview!.operationId,
                      mode: 'replace',
                    }),
                  )
                }
              >
                Back up current workspace and replace selection
              </button>
            </>
          )}
        </div>
      )}
      {progress && <p role="status">{progress}</p>}
      {status?.recoveryWarnings?.map((warning) => (
        <p role="alert" key={warning}>
          {warning}
        </p>
      ))}
      {(error || operation?.error || status?.error) && (
        <p role="alert">{error || operation?.error || status?.error}</p>
      )}
      {busy && (
        <button
          type="button"
          onClick={() => void action(() => bridge.cancel(operation!.id))}
        >
          Cancel storage operation
        </button>
      )}
    </section>
  );
}
