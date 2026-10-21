import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';
import { ChevronDown, Play, SlidersHorizontal, Square } from 'lucide-react';
import { authHeaders } from '../api';
import {
  DEFAULT_VOICE_SETTINGS,
  PERSONALITIES,
  VOICES,
  VOICE_QUALITIES,
  voiceSettingsSchema,
  type VoiceSettings as Settings,
} from '../../shared/voice-settings';
import type { LocalVoiceStatus } from '../../shared/local-voice';

export interface VoiceSettingsHandle {
  stopPreview(): void;
}

export interface VoiceSettingsProps {
  dotId: string;
  callActive: boolean;
  previewReady: boolean;
  unavailableReason?: string;
  status?: LocalVoiceStatus;
  onSaved?: () => void;
  initiallyOpen?: boolean;
  standalone?: boolean;
  active?: boolean;
  ref?: Ref<VoiceSettingsHandle>;
}

interface Preview {
  controller: AbortController;
  context: AudioContext;
  source?: AudioBufferSourceNode;
}

/** Bound body reads, decoding and audio resume as well as the initial fetch. */
async function bounded<T>(
  controller: AbortController,
  operation: (signal: AbortSignal) => Promise<T>,
  timeout = 15000,
): Promise<T> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(
    () => controller.abort(new Error('Request timed out. Please retry.')),
    timeout,
  );
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

async function requireSuccess(response: Response) {
  if (response.ok) return;
  const data = await response.json().catch(() => null);
  throw new Error(
    typeof data?.error === 'string'
      ? data.error
      : `Request failed (${response.status}).`,
  );
}

function releasePreview(preview: Preview) {
  preview.controller.abort();
  if (preview.source) {
    preview.source.onended = null;
    try {
      preview.source.stop();
    } catch {
      // A failed source.start() leaves a node that cannot be stopped.
    }
    preview.source.disconnect();
  }
  if (preview.context.state !== 'closed')
    void preview.context.close().catch(() => {});
}

export function VoiceSettings(props: VoiceSettingsProps) {
  // Discard the previous Dot's draft and asynchronous state as one unit.
  return <DotVoiceSettings key={props.dotId} {...props} />;
}

function DotVoiceSettings({
  dotId,
  callActive,
  previewReady,
  unavailableReason,
  status,
  onSaved,
  initiallyOpen = false,
  standalone = false,
  active = true,
  ref,
}: VoiceSettingsProps) {
  const id = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const [draft, setDraft] = useState<Settings>(DEFAULT_VOICE_SETTINGS);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [previewState, setPreviewState] = useState<
    'idle' | 'loading' | 'playing'
  >('idle');
  const preview = useRef<Preview | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const lastSettingsRevision = useRef<string | undefined>(undefined);
  const settingsRevision = status?.settingsRevision ?? status?.selectedQuality;
  const path = `/api/local-voice/dots/${encodeURIComponent(dotId)}`;

  const stopPreview = useCallback(() => {
    const current = preview.current;
    preview.current = null;
    if (current) releasePreview(current);
    setPreviewState('idle');
  }, []);
  useImperativeHandle(ref, () => ({ stopPreview }), [stopPreview]);
  useEffect(() => {
    if (callActive || !previewReady || !active) stopPreview();
  }, [callActive, previewReady, active, stopPreview]);
  useEffect(
    () => () => {
      const current = preview.current;
      preview.current = null;
      if (current) releasePreview(current);
      saveRequest.current?.abort();
      saveRequest.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const changed =
      lastSettingsRevision.current !== undefined &&
      lastSettingsRevision.current !== settingsRevision;
    lastSettingsRevision.current = settingsRevision;
    stopPreview();
    const controller = new AbortController();
    let current = true;
    setLoading(true);
    setSaved(null);
    setError('');
    setNotice(
      changed ? 'Voice settings refreshed. Review the current choices.' : '',
    );
    void bounded(controller, async (signal) => {
      const response = await fetch(`${path}/settings`, {
        method: 'GET',
        headers: authHeaders(),
        signal,
      });
      await requireSuccess(response);
      return voiceSettingsSchema.parse(await response.json());
    })
      .then((settings) => {
        if (!current) return;
        setDraft(settings);
        setSaved(settings);
      })
      .catch((failure: unknown) => {
        if (current)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Could not load voice settings.',
          );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [open, path, attempt, settingsRevision, stopPreview]);

  const disabled = callActive || loading || saving || !saved;
  const dirty =
    saved?.quality !== draft.quality ||
    saved?.voiceId !== draft.voiceId ||
    saved?.personality !== draft.personality;
  const personality = PERSONALITIES.find(
    (item) => item.id === draft.personality,
  )!;
  const canPreview =
    previewReady && draft.quality === 'medium' && saved?.quality === 'medium';
  const update = (settings: Settings) => {
    stopPreview();
    setDraft(settings);
    setError('');
    setNotice('');
  };
  const save = () => {
    if (disabled || !dirty || saveRequest.current) return;
    const controller = new AbortController();
    saveRequest.current = controller;
    setSaving(true);
    setError('');
    setNotice('');
    void bounded(controller, async (signal) => {
      const response = await fetch(`${path}/settings`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
        signal,
      });
      await requireSuccess(response);
      return voiceSettingsSchema.parse(await response.json());
    })
      .then((settings) => {
        if (saveRequest.current !== controller) return;
        setSaved(settings);
        setDraft(settings);
        setNotice('Saved');
        onSaved?.();
      })
      .catch((failure: unknown) => {
        if (saveRequest.current === controller)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Could not save voice settings.',
          );
      })
      .finally(() => {
        if (saveRequest.current !== controller) return;
        saveRequest.current = null;
        setSaving(false);
      });
  };
  const startPreview = () => {
    if (disabled || !canPreview) return;
    stopPreview();
    setError('');
    setNotice('');
    let current: Preview;
    try {
      // This happens inside the user's click, before fetch or other async work.
      const context = new AudioContext();
      current = { context, controller: new AbortController() };
      preview.current = current;
      const resumed = context.resume();
      setPreviewState('loading');
      void bounded(
        current.controller,
        async (signal) => {
          const [, response] = await Promise.all([
            resumed,
            fetch(`${path}/preview`, {
              method: 'POST',
              headers: { ...authHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify(draft),
              signal,
            }),
          ]);
          await requireSuccess(response);
          const bytes = await response.arrayBuffer();
          if (preview.current !== current) return null;
          // Decode the WAV directly; no media element or object URL outlives the preview.
          return context.decodeAudioData(bytes);
        },
        30000,
      )
        .then((buffer) => {
          if (preview.current !== current || !buffer) return;
          if (context.state !== 'running')
            throw new Error(
              'Audio playback did not start. Please try Preview again.',
            );
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          current.source = source;
          source.onended = () => {
            if (preview.current === current) stopPreview();
          };
          source.start();
          setPreviewState('playing');
        })
        .catch((failure: unknown) => {
          if (preview.current !== current) return;
          stopPreview();
          setError(
            failure instanceof Error
              ? failure.message
              : 'Could not preview this voice.',
          );
        });
    } catch (failure) {
      stopPreview();
      setError(
        failure instanceof Error
          ? failure.message
          : 'Audio playback is unavailable.',
      );
    }
  };

  return (
    <section className="voice-settings">
      {!standalone && (
        <button
          type="button"
          className="voice-settings-toggle"
          aria-label="Voice & personality"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          onClick={() => {
            if (open) {
              stopPreview();
              saveRequest.current?.abort();
              saveRequest.current = null;
              setSaving(false);
            }
            setOpen(!open);
          }}
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          Voice &amp; personality
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      )}
      {open && (
        <div
          id={`${id}-panel`}
          className="voice-settings-panel"
          aria-busy={loading || saving}
        >
          <div className="voice-settings-fields">
            <label htmlFor={`${id}-quality`} className="voice-quality-field">
              Voice chat quality
              <select
                id={`${id}-quality`}
                aria-label="Voice chat quality"
                aria-describedby={`${id}-quality-description`}
                value={draft.quality}
                disabled={disabled}
                onChange={(event) =>
                  update({
                    ...draft,
                    quality: event.target.value as Settings['quality'],
                  })
                }
              >
                {VOICE_QUALITIES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${id}-voice`}>
              Voice
              <select
                id={`${id}-voice`}
                aria-label="Voice"
                value={draft.voiceId}
                disabled={disabled || draft.quality !== 'medium'}
                onChange={(event) =>
                  update({
                    ...draft,
                    voiceId: event.target.value as Settings['voiceId'],
                  })
                }
              >
                {(['American', 'British'] as const).flatMap((accent) =>
                  (['Female', 'Male'] as const).map((gender) => (
                    <optgroup
                      key={`${accent}-${gender}`}
                      label={`${accent} · ${gender}`}
                    >
                      {VOICES.filter(
                        (voice) =>
                          voice.accent === accent && voice.gender === gender,
                      ).map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.name}
                        </option>
                      ))}
                    </optgroup>
                  )),
                )}
              </select>
            </label>
            <label htmlFor={`${id}-personality`}>
              Personality
              <select
                id={`${id}-personality`}
                aria-label="Personality"
                value={draft.personality}
                disabled={disabled}
                aria-describedby={`${id}-description`}
                onChange={(event) =>
                  update({
                    ...draft,
                    personality: event.target.value as Settings['personality'],
                  })
                }
              >
                {PERSONALITIES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p id={`${id}-quality-description`}>
            {
              VOICE_QUALITIES.find((item) => item.id === draft.quality)!
                .description
            }
          </p>
          {draft.quality === 'high' && (
            <p role="status">
              {status?.modes?.high.reason ||
                'High is not available yet. A local native audio runtime and task delegation must be validated first.'}
            </p>
          )}
          {draft.quality === 'basic' && (
            <p>
              Text replies appear in chat. Voice preview and speaker output are
              off.
            </p>
          )}
          {draft.quality === 'medium' && saved?.quality !== 'medium' && (
            <p>Save Medium quality to preview a voice.</p>
          )}
          <p id={`${id}-description`}>
            {personality.description}. Voice applies to your next call;
            personality applies to future replies.
          </p>
          {callActive && <p>End the call to change these settings.</p>}
          {!previewReady &&
            !(
              draft.quality === 'high' &&
              unavailableReason === status?.modes?.high.reason
            ) && (
              <p>
                {unavailableReason || 'Set up local voice to preview voices.'}
              </p>
            )}
          <div className="voice-settings-actions">
            <button
              type="button"
              aria-label={
                previewState === 'idle' ? 'Preview voice' : 'Stop voice preview'
              }
              disabled={disabled || !canPreview}
              onClick={previewState === 'idle' ? startPreview : stopPreview}
            >
              {previewState === 'idle' ? (
                <Play size={14} aria-hidden="true" />
              ) : (
                <Square size={14} aria-hidden="true" />
              )}
              {previewState === 'loading'
                ? 'Cancel preview'
                : previewState === 'playing'
                  ? 'Stop preview'
                  : 'Preview'}
            </button>
            <button
              type="button"
              aria-label="Save voice settings"
              disabled={disabled || !dirty}
              onClick={save}
            >
              {saving ? 'Saving…' : standalone ? 'Save voice settings' : 'Save'}
            </button>
            <span role="status">
              {loading
                ? 'Loading…'
                : previewState === 'loading'
                  ? 'Preparing preview…'
                  : notice}
            </span>
          </div>
          {error && (
            <p className="voice-settings-error" role="alert">
              {error}
            </p>
          )}
          {!loading && !saved && (
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry settings
            </button>
          )}
        </div>
      )}
    </section>
  );
}
