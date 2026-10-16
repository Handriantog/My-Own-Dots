import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
} from 'react';
import type { MemoryCommand } from '../shared/memory-commands';
import type { ApplyReceipt, RestorePreview } from '../shared/memory';
import type { MemoryJob } from '../server/memory-jobs';
import type { IndexCoverage } from '../server/conversation-memory';
import { api } from './api';
interface Activity {
  jobs: MemoryJob[];
  changes: ApplyReceipt[];
  coverage: IndexCoverage;
  error?: string | null;
}
export interface MemoryActivityHandle {
  execute: (command: MemoryCommand) => Promise<void>;
}
export const MemoryActivity = forwardRef<
  MemoryActivityHandle,
  {
    dotId: string;
    threadId?: string;
    historicalThreads?: { id: string; title: string }[];
  }
>(({ dotId, threadId, historicalThreads = [] }, ref) => {
  const [activity, setActivity] = useState<Activity>(),
    [preview, setPreview] = useState<RestorePreview>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [selected, setSelected] = useState<string[]>([]);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const value = await api<Activity>(
        `/dots/${encodeURIComponent(dotId)}/memory-jobs`,
        'GET',
        undefined,
        signal,
      );
      if (!signal?.aborted) setActivity(value);
    },
    [dotId],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await load(controller.signal);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'Memory activity is unavailable.',
          );
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [load]);
  const execute = async (command: MemoryCommand) => {
    setOpen(true);
    setBusy(true);
    setError('');
    try {
      if (command.kind === 'compact') {
        if (!threadId) throw new Error('Open a conversation to compact it.');
        await api(
          `/conversations/${encodeURIComponent(threadId)}/compact`,
          'POST',
          {},
        );
      }
      if (command.kind === 'dream')
        await api(`/dots/${encodeURIComponent(dotId)}/dream`, 'POST', {});
      if (command.kind === 'dream-restore')
        setPreview(
          await api<RestorePreview>(
            `/memory-changes/${encodeURIComponent(command.id)}/restore-preview`,
            'POST',
            {},
          ),
        );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Memory request failed.');
      throw e;
    } finally {
      setBusy(false);
    }
  };
  useImperativeHandle(ref, () => ({ execute }));
  const run = (command: MemoryCommand) => {
    void execute(command).catch(() => {});
  };
  const restore = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await api(
        `/memory-changes/${encodeURIComponent(preview.changeSetId)}/restore`,
        'POST',
        { previewId: preview.id, expectedRevisions: preview.expectedRevisions },
      );
      setPreview(undefined);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not restore memories.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="memory-activity"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        Memory activity{' '}
        {activity?.jobs.some((j) => j.state === 'running')
          ? '· Working'
          : activity?.jobs.some((j) => j.state === 'queued')
            ? '· Queued'
            : ''}
      </summary>
      <p>
        Compact condenses this conversation. Dream reviews experience for useful
        memories. Original conversations stay saved.
      </p>
      <div className="memory-actions">
        {threadId && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run({ kind: 'compact' })}
          >
            Compact now
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => run({ kind: 'dream' })}
        >
          Dream now
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run({ kind: 'dream-log' })}
        >
          Refresh activity
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {activity?.error && <p role="status">{activity.error}</p>}
      {activity?.coverage && !activity.coverage.complete && (
        <p className="muted">
          Recall coverage is partial. Some older or unavailable evidence has not
          been indexed.
        </p>
      )}
      {activity?.jobs.length === 0 && <p>No memory jobs yet.</p>}
      <ul className="memory-job-list" aria-label="Maintenance jobs">
        {activity?.jobs.map((job) => (
          <li key={job.id}>
            <strong>
              {job.kind === 'dream' ? 'Dream' : 'Compact'} ·{' '}
              {job.state[0].toUpperCase() + job.state.slice(1)}
            </strong>
            <small>
              {job.origin === 'automatic' ? 'Automatic' : 'Requested by you'} ·{' '}
              {job.modelCalls} model calls
            </small>
            {job.error && <p>{job.error}</p>}
          </li>
        ))}
      </ul>
      {!!historicalThreads.length && (
        <details>
          <summary>Review older conversations</summary>
          <p>Select only the conversations you want this Dream to consider.</p>
          {historicalThreads.map((t) => (
            <label className="permission-row" key={t.id}>
              <input
                type="checkbox"
                checked={selected.includes(t.id)}
                onChange={(e) =>
                  setSelected((ids) =>
                    e.target.checked
                      ? [...ids, t.id]
                      : ids.filter((id) => id !== t.id),
                  )
                }
              />
              {t.title}
            </label>
          ))}
          <button
            type="button"
            disabled={busy || !selected.length}
            onClick={() => {
              setBusy(true);
              setError('');
              void api(`/dots/${encodeURIComponent(dotId)}/dream`, 'POST', {
                selectedThreadIds: selected,
              })
                .then(() => load())
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            Dream from selected conversations
          </button>
        </details>
      )}
      {!!activity?.changes.length && (
        <details>
          <summary>Memory change history</summary>
          {activity.changes.map((change) => (
            <article key={change.id}>
              <p>
                {new Date(change.createdAt).toLocaleString()} ·{' '}
                {change.changes.length
                  ? `${change.changes.length} changes`
                  : 'No lasting changes'}
              </p>
              <small className="memory-change-id">{change.id}</small>
              <button
                type="button"
                aria-label={'Preview restore ' + change.id}
                disabled={busy}
                onClick={() => run({ kind: 'dream-restore', id: change.id })}
              >
                Preview restore
              </button>
            </article>
          ))}
        </details>
      )}
      {preview && (
        <section aria-label="Restore preview" className="memory-restore">
          <h3>Review before restoring</h3>
          <p>
            This reverses only the selected memory changes. It does not rewind
            conversations or later edits.
          </p>
          {preview.conflicts.length > 0 && (
            <p role="alert">
              Some memories have newer revisions. This restore is blocked.
            </p>
          )}
          {preview.changes.map((change) => (
            <article key={change.after.id}>
              <strong>{change.after.title}</strong>
              <p>Current change: {change.after.text}</p>
              <p>
                Restore to:{' '}
                {change.before?.text ?? 'Removed from active memory'}
              </p>
            </article>
          ))}
          <div className="memory-actions">
            <button
              type="button"
              aria-label="Confirm memory restore"
              disabled={busy || preview.conflicts.length > 0}
              onClick={() => void restore()}
            >
              Confirm restore
            </button>
            <button type="button" onClick={() => setPreview(undefined)}>
              Cancel
            </button>
          </div>
        </section>
      )}
    </details>
  );
});
MemoryActivity.displayName = 'MemoryActivity';
