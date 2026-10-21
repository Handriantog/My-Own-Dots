import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopVoiceBridge } from '../../desktop/shared/voice-contract';
import type {
  LocalVoiceEvent,
  LocalVoiceHandle,
  VoicePhase,
} from '../../shared/local-voice';
import { authHeaders } from '../api';
import { LocalVoiceAudio } from './audio';
import {
  voiceQualitySchema,
  type VoiceQuality,
} from '../../shared/voice-settings';

declare global {
  interface Window {
    dotVoice?: DesktopVoiceBridge;
  }
}
interface Options {
  threadId: string;
  dotId: string;
  quality?: VoiceQuality;
  onTranscript(transcript: { messageId: string; text: string }): Promise<void>;
  onCancelTranscript?(messageId: string): Promise<void> | void;
  onSaved(): void;
  onCanonicalSaved?(): Promise<void> | void;
}
type Control =
  | { action: 'heartbeat' | 'interrupt' | 'end' }
  | { action: 'mute' | 'speaker'; value: boolean }
  | { action: 'answer'; messageId: string }
  | { action: 'played'; generation: number; sequence: number; samples: number };
interface Session {
  quality: VoiceQuality;
  audio: LocalVoiceAudio;
  handle?: LocalVoiceHandle;
  stream: AbortController;
  cancelled: boolean;
  finishing?: Promise<void>;
  generation: number;
  muted: boolean;
  speakerMuted: boolean;
  inputPaused: boolean;
  outputPaused: boolean;
  frames: Uint8Array[];
  inputSequence: number;
  sending?: Promise<void>;
  muteWork: Promise<void>;
  muteRevision: number;
  speakerWork: Promise<void>;
  transcriptWork: Promise<void>;
  cancellationWork: Promise<void>;
  transcriptId?: string;
  submittedId?: string;
  cancelledTranscripts: Set<string>;
  seen: Set<string>;
  answerId?: string;
  answerBusy: boolean;
  answerAgain?: string;
  heartbeatBusy: boolean;
  heartbeat?: ReturnType<typeof setInterval>;
  answers?: ReturnType<typeof setInterval>;
  expires?: ReturnType<typeof setTimeout>;
  connecting?: ReturnType<typeof setTimeout>;
}
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The local voice call failed.';
const pathFor = (handle: LocalVoiceHandle, path: string) =>
  `/api/local-voice/calls/${encodeURIComponent(handle.id)}/${path}`;
function headers(handle?: LocalVoiceHandle) {
  return {
    ...authHeaders(),
    ...(handle ? { 'X-Dot-Voice-Token': handle.token } : {}),
  };
}
async function post(
  path: string,
  body: unknown,
  handle?: LocalVoiceHandle,
  keepalive = false,
  timeout = 8000,
): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { ...headers(handle), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
    ...(keepalive ? { keepalive: true } : {}),
  });
  const result = (await response.json().catch(() => ({}))) as {
    error?: unknown;
  };
  if (!response.ok)
    throw new Error(
      typeof result.error === 'string'
        ? result.error
        : `Local voice request failed (${response.status}).`,
    );
  return result;
}
function control(
  current: Session,
  body: Control,
  keepalive = false,
): Promise<unknown> {
  if (!current.handle) return Promise.resolve();
  return post(
    pathFor(current.handle, 'control'),
    body,
    current.handle,
    keepalive,
  );
}
function parseEvent(text: string): LocalVoiceEvent {
  const event: unknown = JSON.parse(text);
  if (!event || typeof event !== 'object' || !('type' in event))
    throw new Error('Invalid local voice event');
  const data = event as Record<string, unknown>;
  const valid =
    data.type === 'review-folders' ||
    (data.type === 'phase' &&
      ['listening', 'thinking', 'speaking', 'approval'].includes(
        String(data.phase),
      )) ||
    (data.type === 'flush' &&
      integer(data.generation) &&
      (data.keepTranscript === undefined ||
        typeof data.keepTranscript === 'boolean')) ||
    (['transcript', 'native-transcript'].includes(String(data.type)) &&
      integer(data.generation) &&
      typeof data.messageId === 'string' &&
      data.messageId.length > 0 &&
      data.messageId.length <= 200 &&
      typeof data.text === 'string' &&
      data.text.length > 0 &&
      data.text.length <= 4000) ||
    (data.type === 'caption' &&
      typeof data.text === 'string' &&
      data.text.length <= 64000) ||
    (['notice', 'saved'].includes(String(data.type)) &&
      typeof data.text === 'string' &&
      data.text.length > 0 &&
      data.text.length <= 1000) ||
    (data.type === 'audio' &&
      integer(data.generation) &&
      integer(data.sequence) &&
      typeof data.pcm === 'string' &&
      data.pcm.length > 0 &&
      data.pcm.length <= 2560) ||
    (data.type === 'ended' &&
      (data.error === undefined || typeof data.error === 'string'));
  if (!valid) throw new Error('Invalid local voice event');
  return data as unknown as LocalVoiceEvent;
}
function decodePcm(value: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error('Invalid speech audio encoding');
  const raw = atob(value);
  if (!raw.length || raw.length > 1920 || raw.length % 2)
    throw new Error('Invalid speech audio frame');
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

/** Local speech transports the existing Chat agent's messages, never a second brain. */
export function useLocalVoice(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const session = useRef<Session | undefined>(undefined);
  const mounted = useRef(true);
  const [status, setStatus] = useState<
    'idle' | 'connecting' | 'active' | 'ending'
  >('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [phase, setPhase] = useState<VoicePhase>('listening');
  const [caption, setCaption] = useState('');
  const [userCaption, setUserCaption] = useState('');
  const [quality, setQuality] = useState<VoiceQuality>(
    options.quality ?? 'medium',
  );

  const cancelTranscript = useCallback((current: Session) => {
    const id = current.submittedId;
    if (!id || current.cancelledTranscripts.has(id))
      return current.cancellationWork;
    current.cancelledTranscripts.add(id);
    let cancelled: Promise<void>;
    try {
      cancelled = Promise.resolve(latest.current.onCancelTranscript?.(id));
    } catch (failure) {
      cancelled = Promise.reject(failure);
    }
    current.cancellationWork = Promise.allSettled([
      current.cancellationWork,
      cancelled,
    ]).then((results) => {
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
    return current.cancellationWork;
  }, []);

  const finish = useCallback(
    (current = session.current): Promise<void> => {
      if (!current) return Promise.resolve();
      if (current.finishing) return current.finishing;
      current.cancelled = true;
      current.audio.stop();
      // Revoke the desktop permission immediately, before any persistence/network await.
      let nativeEnd: Promise<void> | undefined;
      try {
        if (current.handle) nativeEnd = window.dotVoice?.end(current.handle.id);
        else nativeEnd = window.dotVoice?.cancelStart?.();
      } catch {
        /* Audio is already released. */
      }
      const cancelled = cancelTranscript(current);
      current.frames = [];
      current.answerId = undefined;
      clearInterval(current.heartbeat);
      clearInterval(current.answers);
      clearTimeout(current.expires);
      clearTimeout(current.connecting);
      if (mounted.current && session.current === current) setStatus('ending');
      current.finishing = (async () => {
        void nativeEnd?.catch(() => {});
        await Promise.allSettled([cancelled]);
        current.stream.abort();
        const saved = control(current, { action: 'end' }, true);
        const [result] = await Promise.allSettled([saved]);
        try {
          if (result.status === 'fulfilled') {
            if (current.handle) latest.current.onSaved();
          } else if (mounted.current && session.current === current) {
            setError(
              (previous) =>
                previous ||
                `Call ended, but its receipt could not be saved: ${message(result.reason)}`,
            );
          }
        } catch (failure) {
          if (mounted.current && session.current === current)
            setError(
              (previous) =>
                previous ||
                `Call ended, but its conversation could not refresh: ${message(failure)}`,
            );
        } finally {
          if (session.current === current) {
            session.current = undefined;
            if (mounted.current) setStatus('idle');
          }
        }
      })();
      return current.finishing;
    },
    [cancelTranscript],
  );
  const fail = useCallback(
    (current: Session, failure: unknown) => {
      if (current.cancelled || session.current !== current) return;
      if (mounted.current) setError(message(failure));
      window.dotVoice?.reportError?.(message(failure));
      void finish(current);
    },
    [finish],
  );

  const start = useCallback(async () => {
    if (session.current) return;
    if (!options.threadId || !options.dotId) {
      setError('Choose a Dot conversation before starting a call.');
      return;
    }
    const current: Session = {
      audio: new LocalVoiceAudio({
        onFrame: ({ pcm }) => {
          if (current.cancelled || current.inputPaused || current.muted) return;
          if (current.frames.length >= 8) {
            fail(current, new Error('Microphone input backlog exceeded.'));
            return;
          }
          current.frames.push(pcm);
          if (current.sending) return;
          const sending = (async () => {
            while (
              !current.cancelled &&
              !current.inputPaused &&
              current.frames.length
            ) {
              const frame = current.frames.shift()!;
              const sequence = current.inputSequence++;
              await post(
                pathFor(current.handle!, 'frame'),
                { sequence, pcm: btoa(String.fromCharCode(...frame)) },
                current.handle,
              );
            }
          })();
          current.sending = sending;
          void sending
            .catch((failure) => fail(current, failure))
            .finally(() => {
              if (current.sending === sending) current.sending = undefined;
            });
        },
        onPlayed: ({ generation, sequence, playedSamples }) => {
          if (
            current.quality === 'basic' ||
            current.cancelled ||
            generation !== current.generation
          )
            return;
          void control(current, {
            action: 'played',
            generation,
            sequence,
            samples: playedSamples,
          }).catch((failure) => fail(current, failure));
        },
        onError: (failure) => fail(current, failure),
      }),
      quality: options.quality ?? 'medium',
      stream: new AbortController(),
      cancelled: false,
      generation: 0,
      muted: false,
      speakerMuted: false,
      inputPaused: true,
      outputPaused: false,
      frames: [],
      inputSequence: 0,
      muteWork: Promise.resolve(),
      muteRevision: 0,
      speakerWork: Promise.resolve(),
      transcriptWork: Promise.resolve(),
      cancellationWork: Promise.resolve(),
      cancelledTranscripts: new Set(),
      seen: new Set(),
      answerBusy: false,
      heartbeatBusy: false,
    };
    session.current = current;
    setStatus('connecting');
    setError('');
    setNotice('');
    setMuted(false);
    setSpeakerMuted(false);
    setStartedAt(undefined);
    setPhase('listening');
    setCaption('');
    setUserCaption('');
    setQuality(current.quality);

    const checkAnswer = (afterRun = false) => {
      const id = current.answerId;
      if (current.cancelled || !id) return;
      if (current.answerBusy) {
        if (afterRun) current.answerAgain = id;
        return;
      }
      current.answerBusy = true;
      void control(current, { action: 'answer', messageId: id })
        .catch((failure) => {
          if (current.answerId === id) fail(current, failure);
        })
        .finally(() => {
          current.answerBusy = false;
          const again = current.answerAgain;
          current.answerAgain = undefined;
          if (again && current.answerId === again) checkAnswer();
        });
    };

    const handleEvent = (event: LocalVoiceEvent) => {
      if (current.cancelled) return;
      if (event.type === 'ended') {
        if (event.error) {
          setError(event.error);
          window.dotVoice?.reportError?.(event.error);
        }
        void finish(current);
      } else if (event.type === 'phase') {
        setPhase(event.phase);
        if (current.handle)
          void window.dotVoice
            ?.phase?.(current.handle.id, event.phase)
            .catch(() => {});
        if (event.phase === 'thinking' || event.phase === 'speaking')
          setNotice('');
      } else if (event.type === 'review-folders') {
        if (current.quality === 'high' && current.handle)
          void window.dotVoice
            ?.reviewFolders?.(current.handle.id)
            .catch(() => {});
      } else if (event.type === 'caption') {
        setCaption(event.text);
      } else if (event.type === 'notice') {
        setNotice(event.text);
      } else if (event.type === 'flush') {
        if (event.generation < current.generation) return;
        current.generation = event.generation;
        current.outputPaused = false;
        current.audio.flush(event.generation);
        if (!event.keepTranscript) {
          current.answerId = undefined;
          current.transcriptId = undefined;
          void cancelTranscript(current).catch((failure) =>
            fail(current, failure),
          );
        }
        setCaption('');
      } else if (event.type === 'audio') {
        if (
          current.quality === 'basic' ||
          event.generation < current.generation ||
          current.outputPaused ||
          current.speakerMuted
        )
          return;
        current.audio.play({
          generation: event.generation,
          sequence: event.sequence,
          pcm: decodePcm(event.pcm),
        });
      } else if (event.type === 'saved') {
        if (current.quality !== 'high') return;
        setNotice(event.text);
        latest.current.onSaved();
        void Promise.resolve(latest.current.onCanonicalSaved?.()).catch(
          (failure) => fail(current, failure),
        );
      } else if (event.type === 'native-transcript') {
        if (
          current.quality !== 'high' ||
          event.generation < current.generation ||
          current.seen.has(event.messageId)
        )
          return;
        if (event.generation !== current.generation || current.seen.size >= 100)
          throw Error('Invalid native transcript generation');
        current.seen.add(event.messageId);
        setNotice('');
        setUserCaption(event.text);
        latest.current.onSaved();
        void Promise.resolve(latest.current.onCanonicalSaved?.()).catch(
          (failure) => fail(current, failure),
        );
      } else if (event.type === 'transcript') {
        if (current.quality === 'high')
          throw Error('High requires a server-owned conversation.');
        if (
          event.generation < current.generation ||
          current.seen.has(event.messageId)
        )
          return;
        if (event.generation !== current.generation || current.seen.size >= 100)
          throw new Error('Invalid voice transcript generation');
        current.seen.add(event.messageId);
        setNotice('');
        current.transcriptId = event.messageId;
        setUserCaption(event.text);
        current.transcriptWork = current.transcriptWork
          .then(async () => {
            await current.cancellationWork;
            if (current.cancelled || current.transcriptId !== event.messageId)
              return;
            current.answerId = event.messageId;
            current.submittedId = event.messageId;
            try {
              await latest.current.onTranscript({
                messageId: event.messageId,
                text: event.text,
              });
              // The governed run just finished. Avoid adding a poll interval to
              // its latency; the server still validates the canonical answer.
              if (current.transcriptId === event.messageId) checkAnswer(true);
            } catch (failure) {
              if (current.transcriptId === event.messageId)
                fail(current, failure);
            } finally {
              if (current.submittedId === event.messageId)
                current.submittedId = undefined;
            }
          })
          .catch((failure) => fail(current, failure));
      }
    };
    const readEvents = async (body: ReadableStream<Uint8Array>) => {
      const reader = body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = '';
      let data = '';
      try {
        while (!current.cancelled) {
          const { done, value } = await reader.read();
          if (done) {
            if (!current.cancelled)
              throw new Error('The local voice event stream disconnected.');
            break;
          }
          if (value.length > 262144)
            throw new Error('Local voice event stream is too large');
          pending += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline).replace(/\r$/, '');
            pending = pending.slice(newline + 1);
            if (line.startsWith('data:'))
              data += `${line.slice(5).replace(/^ /, '')}\n`;
            if (data.length > 65536)
              throw new Error('Local voice event is too large');
            if (!line && data) {
              handleEvent(parseEvent(data));
              data = '';
            }
            if (current.cancelled) break;
          }
          if (pending.length > 65536)
            throw new Error('Local voice event stream is too large');
        }
      } finally {
        // Cancelling the reader disconnects SSE, which ends the server call. Let the
        // Chat SDK first abort any request that is still starting its owned run.
        await current.cancellationWork.catch(() => {});
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    };

    try {
      // This call occurs in the button gesture, before warming workers or HTTP awaits.
      if (current.quality !== 'basic') await current.audio.startPlayback();
      if (current.cancelled) return;
      const result = (await post(
        '/api/local-voice/calls',
        {
          threadId: options.threadId,
          dotId: options.dotId,
          expectedQuality: current.quality,
        },
        undefined,
        false,
        125000,
      )) as LocalVoiceHandle;
      if (
        !result ||
        typeof result.id !== 'string' ||
        !result.id ||
        result.id.length > 200 ||
        typeof result.token !== 'string' ||
        !result.token ||
        result.token.length > 256
      )
        throw new Error('Invalid local voice call response');
      current.handle = result;
      const actualQuality = voiceQualitySchema.parse(
        result.quality ?? 'medium',
      );
      if (actualQuality !== current.quality)
        throw new Error(
          'Voice quality changed. Refresh the settings and start again.',
        );
      if (current.cancelled) {
        await control(current, { action: 'end' }, true);
        latest.current.onSaved();
        return;
      }
      current.heartbeat = setInterval(() => {
        if (current.cancelled || current.heartbeatBusy) return;
        current.heartbeatBusy = true;
        void control(current, { action: 'heartbeat' })
          .catch((failure) => fail(current, failure))
          .finally(() => {
            current.heartbeatBusy = false;
          });
      }, 2000);
      current.expires = setTimeout(() => void finish(current), 15 * 60_000);
      if (current.quality === 'basic')
        await window.dotVoice?.begin(result.id, 'basic');
      else await window.dotVoice?.begin(result.id);
      if (current.cancelled) return;
      current.connecting = setTimeout(
        () =>
          fail(current, new Error('Local voice event connection timed out.')),
        10000,
      );
      const response = await fetch(pathFor(result, 'events'), {
        headers: { ...headers(result), Accept: 'text/event-stream' },
        signal: current.stream.signal,
      });
      clearTimeout(current.connecting);
      if (current.cancelled) return;
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get('Content-Type')?.includes('text/event-stream')
      )
        throw new Error('Could not connect the local voice event stream.');
      void readEvents(response.body).catch((failure) => fail(current, failure));
      current.inputPaused = false;
      await current.audio.startCapture();
      if (current.cancelled) return;
      setStatus('active');
      setStartedAt(Date.now());
      // Approval continuations can finish outside onTranscript's original promise.
      if (current.quality !== 'high')
        current.answers = setInterval(() => checkAnswer(), 500);
    } catch (failure) {
      fail(current, failure);
    }
  }, [
    options.threadId,
    options.dotId,
    options.quality,
    fail,
    finish,
    cancelTranscript,
  ]);

  const end = useCallback(() => finish(), [finish]);
  const toggleMute = useCallback(() => {
    const current = session.current;
    if (!current?.handle || current.cancelled) return;
    const next = !current.muted;
    const revision = ++current.muteRevision;
    current.muted = next;
    current.inputPaused = true;
    current.frames = [];
    if (next) current.audio.muteCapture();
    setMuted(next);
    current.muteWork = current.muteWork
      .then(async () => {
        await current.sending;
        if (current.cancelled) return;
        await control(current, { action: 'mute', value: next });
        if (!next && !current.muted && !current.cancelled) {
          current.inputPaused = false;
          try {
            await current.audio.startCapture();
          } catch (failure) {
            if (current.cancelled || revision !== current.muteRevision) return;
            throw failure;
          }
        }
      })
      .catch((failure) => fail(current, failure));
  }, [fail]);
  const toggleSpeaker = useCallback(() => {
    const current = session.current;
    if (!current?.handle || current.cancelled || current.quality === 'basic')
      return;
    current.speakerMuted = !current.speakerMuted;
    const next = current.speakerMuted;
    current.audio.setSpeakerMuted(next);
    setSpeakerMuted(next);
    current.speakerWork = current.speakerWork
      .then(async () => {
        if (!current.cancelled)
          await control(current, { action: 'speaker', value: next });
      })
      .catch((failure) => fail(current, failure));
  }, [fail]);
  const interrupt = useCallback(async () => {
    const current = session.current;
    if (!current?.handle || current.cancelled) return;
    current.outputPaused = true;
    current.answerId = undefined;
    current.transcriptId = undefined;
    current.audio.flush(current.generation);
    void cancelTranscript(current).catch((failure) => fail(current, failure));
    try {
      await control(current, { action: 'interrupt' });
    } catch (failure) {
      fail(current, failure);
    }
  }, [fail, cancelTranscript]);

  useEffect(() => {
    mounted.current = true;
    const stop = () => {
      void finish();
    };
    const hidden = () => {
      if (
        document.visibilityState === 'hidden' &&
        !window.dotVoice?.isWindowless?.()
      )
        stop();
    };
    window.addEventListener('pagehide', stop);
    document.addEventListener('visibilitychange', hidden);
    const removeNative = window.dotVoice?.onStop(stop);
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', stop);
      document.removeEventListener('visibilitychange', hidden);
      removeNative?.();
      void finish();
    };
  }, [options.threadId, options.dotId, finish]);

  return {
    status,
    error,
    notice,
    start,
    end,
    muted,
    speakerMuted,
    startedAt,
    phase,
    caption,
    userCaption,
    quality,
    toggleMute,
    toggleSpeaker,
    interrupt,
  };
}
