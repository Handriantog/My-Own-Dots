import { useEffect, useRef, useState } from 'react';
import type { MessageMark, MessageMarkKind } from '../shared/message-marks';
import { api } from './api';

export function useMessageMarks(threadId: string, workspaceKey?: string) {
  const [marks, setMarks] = useState<MessageMark[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const alive = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api<MessageMark[]>(
      '/message-marks',
      'GET',
      undefined,
      controller.signal,
    )
      .then((items) => {
        if (controller.signal.aborted) return;
        setMarks(items);
        setError('');
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Saved messages could not load.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [threadId, revision, workspaceKey]);
  const refresh = () => {
    if (!pending.current) setRevision((value) => value + 1);
  };
  const update = async (
    thread: string,
    messageId: string,
    kind: MessageMarkKind,
    active: boolean,
  ) => {
    if (pending.current || loading) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await api<MessageMark | null>(
        `/conversations/${encodeURIComponent(thread)}/messages/${encodeURIComponent(messageId)}/marks`,
        'PUT',
        { kind, active },
      );
      if (alive.current)
        setMarks((items) => [
          ...items.filter(
            (item) => item.threadId !== thread || item.messageId !== messageId,
          ),
          ...(result ? [result] : []),
        ]);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not save this message. Try again.',
        );
    } finally {
      pending.current = false;
      if (alive.current) setSaving(false);
    }
  };
  return { marks, loading, saving, error, refresh, update };
}
