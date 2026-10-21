import { useEffect, useRef, useState } from 'react';
import { Check, FolderOpen } from 'lucide-react';
import {
  folderApprovalSchema,
  type FolderAccess,
  type FolderDecision,
  type FolderRequestDetail,
  type FolderSelection,
} from '../shared/folder-access';
import { api } from './api';
import { notifyFolderAccessChanged } from './folder-access-events';

type FolderAccessCardProps = {
  args: unknown;
  status: string;
  result?: unknown;
  respond?: (result: unknown) => Promise<void>;
  threadId: string;
  toolCallId: string;
  compact?: boolean;
};
const permissionLabel = (access: FolderAccess) =>
  access === 'readwrite' ? 'Read and write' : 'Read only';

export function FolderAccessCard(props: FolderAccessCardProps) {
  const parsed = folderApprovalSchema.safeParse(props.args);
  if (!parsed.success)
    return (
      <section className="page-review-card folder-access-card">
        <p role="alert">Invalid folder access request. No folder was shared.</p>
      </section>
    );
  return (
    <FolderAccessReview
      key={`${props.threadId}:${props.toolCallId}:${parsed.data.requestId}`}
      {...props}
      requestId={parsed.data.requestId}
    />
  );
}

function FolderAccessReview({
  requestId,
  threadId,
  toolCallId,
  status,
  respond,
  compact = false,
}: FolderAccessCardProps & { requestId: string }) {
  const [detail, setDetail] = useState<FolderRequestDetail>();
  const [access, setAccess] = useState<FolderAccess>('read');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [delivered, setDelivered] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [resolving, setResolving] = useState(false);
  const resolutionRequested = useRef(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const base = `/conversations/${encodeURIComponent(threadId)}/folder-requests/${encodeURIComponent(requestId)}`;
  const bridge = typeof window === 'undefined' ? undefined : window.dotFolders;
  const finished = status === 'complete' || delivered;
  const decision = detail?.decision;
  const selection = detail?.selection;
  const expired = !!detail && detail.request.expiresAt <= Date.now();
  const canDecide =
    !!detail &&
    detail.request.status === 'pending' &&
    !decision &&
    !finished &&
    !!respond;
  const validate = (value: FolderRequestDetail) => {
    if (value.request.id !== requestId || value.request.threadId !== threadId)
      throw new Error('This folder request belongs to another conversation.');
    return value;
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let refreshing = false;
    setError('');
    const refresh = async () => {
      if (pending.current || refreshing) return;
      refreshing = true;
      const version = revision.current;
      try {
        const value = validate(await api<FolderRequestDetail>(base));
        if (active && version === revision.current) setDetail(value);
      } catch (cause) {
        if (active && version === revision.current)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not load this folder request.',
          );
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    // Separate desktop windows do not share DOM events. Reload the owner API
    // while a card is unresolved, without responding to a saved decision.
    const timer = !finished
      ? setInterval(() => void refresh(), 2000)
      : undefined;
    window.addEventListener?.('focus', refresh);
    return () => {
      active = false;
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener?.('focus', refresh);
    };
  }, [base, attempt, finished]);

  useEffect(() => {
    if (
      !compact ||
      !canDecide ||
      !bridge ||
      selection ||
      expired ||
      resolutionRequested.current ||
      pending.current
    )
      return;
    resolutionRequested.current = true;
    const version = ++revision.current;
    setResolving(true);
    // The server resolves the saved hint into a proposal. This never opens
    // the picker, grants access, or responds to the agent's approval tool.
    void api<FolderRequestDetail>(`${base}/resolve`, 'POST', {})
      .then((value) => {
        const resolved = validate(value);
        if (mounted.current && version === revision.current) {
          revision.current++;
          setDetail((current) =>
            current?.selection || current?.decision ? current : resolved,
          );
        }
      })
      .catch(() => {
        /* An unavailable default simply leaves Choose folder. */
      })
      .finally(() => {
        if (mounted.current) setResolving(false);
      });
  }, [base, compact, canDecide, bridge, selection, expired]);

  const chooseFolder = async () => {
    if (!bridge || !canDecide || expired || pending.current) return;
    pending.current = true;
    revision.current++;
    setBusy(true);
    setError('');
    try {
      // Keep the native picker in this click's user activation. No model path
      // is passed to the picker, and selecting a folder grants no access.
      const picked = await bridge.choose();
      if (!mounted.current || !picked) return;
      setDetail((current) => current && { ...current, selection: undefined });
      const chosen = await api<FolderSelection>(`${base}/selection`, 'POST', {
        path: picked.path,
      });
      if (mounted.current)
        setDetail((current) => current && { ...current, selection: chosen });
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not choose this folder.',
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const decide = async (approve: boolean) => {
    if (!respond || pending.current || finished || !detail) return;
    if (
      !decision &&
      (!canDecide || (approve && (!selection || !bridge || expired)))
    )
      return;
    pending.current = true;
    revision.current++;
    setBusy(true);
    setError('');
    let saved: FolderDecision | undefined;
    try {
      // A cached receipt is for display only. The idempotent server decision
      // validates this tool call and checks revocation before every response.
      saved = await api<FolderDecision>(`${base}/decision`, 'POST', {
        toolCallId,
        approve,
        ...(approve && !decision ? { selectionId: selection!.id, access } : {}),
      });
      if (!decision && saved.approved)
        notifyFolderAccessChanged(detail.request.dotId);
      if (!mounted.current) return;
      setDetail(
        (current) =>
          current && {
            ...current,
            request: {
              ...current.request,
              status: saved!.approved ? 'approved' : 'declined',
            },
            decision: saved,
          },
      );
      await respond(saved);
      if (mounted.current) setDelivered(true);
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not save this decision.',
      );
      if (!saved) {
        // A lost response may still have saved the decision. Reconcile before
        // offering another action. Continue still revalidates on the server.
        try {
          const current = validate(await api<FolderRequestDetail>(base));
          if (current.decision?.approved)
            notifyFolderAccessChanged(current.request.dotId);
          if (mounted.current) setDetail(current);
        } catch {
          // Keep the original failure visible and the request available to retry.
        }
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  if (compact)
    return (
      <section
        className="folder-access-compact"
        aria-label="Review folder access"
      >
        <div className="folder-access-target">
          <FolderOpen size={19} aria-hidden="true" />
          <div>
            <strong>
              {selection?.name || detail?.request.folderHint || 'Folder'}
            </strong>
            {selection && <code title={selection.path}>{selection.path}</code>}
            {!selection && resolving && <p role="status">Finding folder…</p>}
            {!selection && !resolving && canDecide && !expired && (
              <p role="status">No folder selected</p>
            )}
            {!detail && !error && <p role="status">Loading…</p>}
          </div>
        </div>
        {canDecide && !expired && bridge && (
          <div className="folder-access-options">
            <select
              aria-label="Folder permission"
              value={access}
              disabled={busy}
              onChange={(event) =>
                setAccess(event.target.value as FolderAccess)
              }
            >
              <option value="read">Read only</option>
              <option value="readwrite">Read and write</option>
            </select>
            <button
              type="button"
              aria-label="Choose folder"
              disabled={busy}
              onClick={() => void chooseFolder()}
            >
              {selection ? 'Change' : 'Choose folder'}
            </button>
          </div>
        )}
        {canDecide && expired && (
          <p role="status">Request expired. Ask Dot again.</p>
        )}
        {canDecide && !bridge && (
          <p>Open Dot on your desktop to choose a folder.</p>
        )}
        {decision && (
          <p role="status">{decision.approved ? 'Approved' : 'Declined'}</p>
        )}
        {!decision && finished && <p role="status">Request ended.</p>}
        {error && <p role="alert">{error}</p>}
        <footer>
          {!detail && error && (
            <button
              type="button"
              aria-label="Retry folder request"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
          )}
          {canDecide && (
            <>
              <button
                type="button"
                aria-label="Decline folder access"
                disabled={busy}
                onClick={() => void decide(false)}
              >
                Decline
              </button>
              {bridge && (
                <button
                  type="button"
                  aria-label="Approve folder access"
                  className="review-primary"
                  disabled={busy || !selection || expired}
                  onClick={() => void decide(true)}
                >
                  Approve
                </button>
              )}
            </>
          )}
          {decision && !finished && respond && (
            <button
              type="button"
              aria-label="Continue conversation"
              className="review-primary"
              disabled={busy}
              onClick={() => void decide(decision.approved)}
            >
              Continue
            </button>
          )}
        </footer>
      </section>
    );
  return (
    <section
      className="page-review-card folder-access-card"
      aria-label="Review folder access"
    >
      <header>
        <FolderOpen size={17} />
        <strong>Folder access</strong>
        <span>
          {decision
            ? decision.approved
              ? 'Approved'
              : 'Declined'
            : finished
              ? 'Ended'
              : !detail
                ? 'Checking'
                : expired
                  ? 'Expired'
                  : 'Needs your approval'}
        </span>
      </header>
      <div className="page-review-body">
        {detail && (
          <>
            <h3>{detail.request.reason}</h3>
            {detail.request.folderHint && (
              <p>Suggested folder: {detail.request.folderHint}</p>
            )}
            <p>
              Requested permission:{' '}
              {permissionLabel(detail.request.requestedAccess)}
            </p>
            {selection && (
              <dl className="folder-access-selection">
                <dt>Selected folder</dt>
                <dd>
                  <strong>{selection.name}</strong>
                  <code>{selection.path}</code>
                </dd>
              </dl>
            )}
            {canDecide && (
              <label className="folder-access-permission">
                Permission to grant
                <select
                  aria-label="Folder permission"
                  value={access}
                  disabled={busy || expired || !bridge}
                  onChange={(event) =>
                    setAccess(event.target.value as FolderAccess)
                  }
                >
                  <option value="read">Read only</option>
                  <option value="readwrite">Read and write</option>
                </select>
              </label>
            )}
            {decision && (
              <p role="status">
                {decision.message}
                {decision.approved && decision.access
                  ? ` Permission: ${permissionLabel(decision.access)}.`
                  : ''}
              </p>
            )}
            {canDecide && !bridge && (
              <p>
                Open the desktop app to choose a folder, or decline this request
                here.
              </p>
            )}
            {canDecide && expired && (
              <p>
                This request expired. Decline it and ask your Dot for a new
                request.
              </p>
            )}
          </>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <footer>
        {!detail && error && (
          <button
            type="button"
            aria-label="Retry folder request"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        )}
        {canDecide && (
          <>
            {bridge && (
              <>
                <button
                  type="button"
                  aria-label="Choose folder"
                  disabled={busy || expired}
                  onClick={() => void chooseFolder()}
                >
                  <FolderOpen size={15} />
                  Choose folder
                </button>
                <button
                  type="button"
                  aria-label="Approve folder access"
                  className="review-primary"
                  disabled={busy || !selection || expired}
                  onClick={() => void decide(true)}
                >
                  <Check size={15} />
                  Approve folder access
                </button>
              </>
            )}
            <button
              type="button"
              aria-label="Decline folder access"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Decline
            </button>
            <small>
              Only the selected folder is shared after approval. You can revoke
              access in Folder access settings.
            </small>
          </>
        )}
        {decision && !finished && respond && (
          <button
            type="button"
            aria-label="Continue conversation"
            className="review-primary"
            disabled={busy}
            onClick={() => void decide(decision.approved)}
          >
            Continue conversation
          </button>
        )}
      </footer>
    </section>
  );
}
