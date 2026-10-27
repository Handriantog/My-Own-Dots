import { VoiceTaskList } from './VoiceTaskList';
import { useEffect, useRef, useState } from 'react';
import { authHeaders } from '../api';
import { type VoiceDelegation } from '../../shared/voice-delegation';
export function useVoiceTasks({
  threadId,
  onUpdated,
}: {
  threadId: string;
  onUpdated?(): void;
}) {
  const [jobs, setJobs] = useState<VoiceDelegation[]>([]);
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState<string>();
  const refresh = useRef<() => Promise<void>>(async () => {});
  const updated = useRef(onUpdated);
  updated.current = onUpdated;
  useEffect(() => {
    let active = true,
      busy = false,
      previous = '';
    const controller = new AbortController();
    setJobs([]);
    setError('');
    const load = async () => {
      if (!active || busy) return;
      busy = true;
      try {
        const response = await fetch(
          `/api/local-voice/tasks?threadId=${encodeURIComponent(threadId)}`,
          { headers: authHeaders(), signal: controller.signal },
        );
        if (!response.ok) return;
        const value = (await response.json()) as VoiceDelegation[];
        if (!Array.isArray(value) || !active) return;
        const revision = JSON.stringify(
          value.map((job) => [job.id, job.status, job.deliveredAt]),
        );
        if (revision !== previous) {
          const changed = !!previous && value.length > 0;
          previous = revision;
          setJobs([...value].reverse());
          if (changed) updated.current?.();
        }
      } finally {
        busy = false;
      }
    };
    refresh.current = load;
    void load().catch(() => {});
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [threadId]);
  const stop = async (id: string) => {
    setStopping(id);
    setError('');
    try {
      const response = await fetch(
        `/api/local-voice/tasks/${encodeURIComponent(id)}/stop`,
        { method: 'POST', headers: authHeaders() },
      );
      if (!response.ok)
        throw Error(
          'The task could not be stopped. Open its conversation to check its state.',
        );
      await refresh.current();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The task could not be stopped.',
      );
    } finally {
      setStopping(undefined);
    }
  };
  return { jobs, error, stopping, stop };
}
export type VoiceTaskState = ReturnType<typeof useVoiceTasks>;
export function VoiceTasks(props: { threadId: string; onUpdated?(): void }) {
  return <VoiceTaskList {...useVoiceTasks(props)} />;
}
