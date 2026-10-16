import { useEffect, useState } from 'react';
import type { MemorySettings, MemorySettingsPatch } from '../shared/memory';
import { api } from './api';
export function LocalLearningSettings({
  dotId,
  onChanged,
}: {
  dotId: string;
  onChanged: () => void;
}) {
  const [saved, setSaved] = useState<MemorySettings>(),
    [draft, setDraft] = useState<MemorySettings>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<MemorySettings>(
      `/dots/${encodeURIComponent(dotId)}/memory-settings`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((s) => {
        if (!controller.signal.aborted) {
          setSaved(s);
          setDraft(s);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [dotId]);
  const patch = (change: MemorySettingsPatch) => {
    setDraft((d) => (d ? { ...d, ...change } : d));
    setNotice('');
  };
  const save = async () => {
    if (!saved || !draft) return;
    setBusy(true);
    setError('');
    try {
      const { revision, createdAt, enabledAt, ...settings } = draft;
      void revision;
      void createdAt;
      void enabledAt;
      const result = await api<MemorySettings>(
        `/dots/${encodeURIComponent(dotId)}/memory-settings`,
        'PUT',
        { expectedRevision: saved.revision, patch: settings },
      );
      setSaved(result);
      setDraft(result);
      setNotice('Learning settings saved.');
      onChanged();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not save learning settings.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="local-learning">
      <legend>Local memory and learning</legend>
      <p>
        Compact keeps the current conversation manageable. Dream reviews
        experience for lasting memories. Chat takes priority over background
        work.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {draft && (
        <>
          {(
            [
              ['learningEnabled', 'Learn from new conversations'],
              ['autoCompact', 'Compact automatically'],
              ['autoDream', 'Dream automatically while learning is enabled'],
            ] as const
          ).map(([key, label]) => (
            <label className="permission-row" key={key}>
              <input
                aria-label={label}
                type="checkbox"
                checked={draft[key]}
                onChange={(e) => patch({ [key]: e.target.checked })}
              />
              <span>{label}</span>
            </label>
          ))}
          <p className="muted">
            Learning starts with new conversations after enablement. You can
            select older conversations explicitly. A manual Dream with learning
            off produces proposals for review.
          </p>
          <label>
            Publish learned memories
            <select
              aria-label="Learning publication policy"
              value={draft.publicationPolicy}
              onChange={(e) =>
                patch({
                  publicationPolicy: e.target
                    .value as MemorySettings['publicationPolicy'],
                })
              }
            >
              <option value="hybrid">
                Save clear preferences; review other changes
              </option>
              <option value="review_all">Review every change</option>
            </select>
          </label>
          <details>
            <summary>Timing and limits</summary>
            <div className="memory-timing">
              {(
                [
                  [
                    'compactThreshold',
                    'Compact at context use (%)',
                    100,
                    25,
                    95,
                  ],
                  [
                    'compactIdleMs',
                    'Compact after idle (minutes)',
                    1 / 60000,
                    1 / 60,
                    1440,
                  ],
                  [
                    'compactExchanges',
                    'New exchanges before idle Compact',
                    1,
                    1,
                    1000,
                  ],
                  [
                    'compactNewTokens',
                    'New context units before idle Compact',
                    1,
                    100,
                    1000000,
                  ],
                  [
                    'dreamIntervalMs',
                    'Time between automatic Dreams (minutes)',
                    1 / 60000,
                    1,
                    10080,
                  ],
                  [
                    'dreamIdleMs',
                    'Dream after idle (minutes)',
                    1 / 60000,
                    1 / 60,
                    1440,
                  ],
                  ['automaticJobsPerDay', 'Automatic Dreams per day', 1, 1, 24],
                ] as const
              ).map(([key, label, scale, min, max]) => (
                <label key={key}>
                  {label}
                  <input
                    aria-label={label}
                    type="number"
                    step="any"
                    min={min}
                    max={max}
                    value={Number((draft[key] * scale).toFixed(3))}
                    onChange={(e) =>
                      patch({ [key]: Number(e.target.value) / scale })
                    }
                  />
                </label>
              ))}
              <label>
                Daily limit time zone
                <input
                  aria-label="Learning time zone"
                  value={draft.timeZone}
                  onChange={(e) => patch({ timeZone: e.target.value })}
                />
              </label>
            </div>
            <p className="muted">
              Each job uses at most three model calls and five minutes. Retries
              share those limits.
            </p>
          </details>
          <button
            type="button"
            aria-label="Save learning settings"
            disabled={busy}
            onClick={() => void save()}
          >
            Save learning settings
          </button>
          {notice && <p role="status">{notice}</p>}
        </>
      )}
    </fieldset>
  );
}
