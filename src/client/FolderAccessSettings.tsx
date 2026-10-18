import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderOpen } from 'lucide-react';
import type { FolderGrant } from '../shared/folder-access';
import { api } from './api';
import {
  folderAccessChangedEvent,
  notifyFolderAccessChanged,
} from './folder-access-events';

export function FolderAccessSettings({ dotId }: { dotId: string }) {
  return <FolderPermissions key={dotId} dotId={dotId} />;
}

function FolderPermissions({ dotId }: { dotId: string }) {
  const [open, setOpen] = useState(false);
  const [grants, setGrants] = useState<FolderGrant[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const path = `/dots/${encodeURIComponent(dotId)}/folder-grants`;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ dotId?: string }>).detail?.dotId === dotId)
        setAttempt((value) => value + 1);
    };
    window.addEventListener?.(folderAccessChangedEvent, changed);
    return () =>
      window.removeEventListener?.(folderAccessChangedEvent, changed);
  }, [open, dotId]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setGrants(undefined);
    setError('');
    void api<FolderGrant[]>(path)
      .then((value) => {
        if (active) setGrants(value);
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not load folder permissions.',
          );
      });
    return () => {
      active = false;
    };
  }, [open, path, attempt]);
  const revoke = async (grant: FolderGrant) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(grant.id);
    setError('');
    try {
      await api(`${path}/${encodeURIComponent(grant.id)}`, 'DELETE');
      notifyFolderAccessChanged(dotId);
      if (mounted.current)
        setGrants((current) =>
          current?.filter((value) => value.id !== grant.id),
        );
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not revoke folder access.',
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy('');
    }
  };
  return (
    <section className="folder-access-settings">
      <button
        type="button"
        className="folder-access-toggle"
        aria-label="Folder access"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <FolderOpen size={14} />
        Folder access
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="folder-access-panel">
          <p>
            Folders shared with this Dot. Revoking access stops future folder
            operations.
          </p>
          {grants === undefined && !error && (
            <p role="status">Loading folder permissions…</p>
          )}
          {grants?.length === 0 && <p>No folders shared.</p>}
          {grants?.map((grant) => (
            <div className="folder-access-grant" key={grant.id}>
              <div>
                <strong>{grant.name}</strong>
                <code>{grant.path}</code>
                <small>
                  {grant.access === 'readwrite'
                    ? 'Read and write'
                    : 'Read only'}
                </small>
              </div>
              <button
                type="button"
                aria-label={`Revoke access to ${grant.name}`}
                disabled={!!busy}
                onClick={() => void revoke(grant)}
              >
                {busy === grant.id ? 'Revoking…' : 'Revoke'}
              </button>
            </div>
          ))}
          {error && <p role="alert">{error}</p>}
          {!grants && error && (
            <button
              type="button"
              aria-label="Retry folder permissions"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
          )}
        </div>
      )}
    </section>
  );
}
