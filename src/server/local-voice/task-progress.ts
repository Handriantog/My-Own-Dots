import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';

/** Host metadata emitted only for commentary, after its full prose is persisted. */
export const taskProgressEvent = 'dot.task-progress';
type Listener = (input: RunAgentInput, messageId: string) => void;
const listeners = new WeakMap<object, Set<Listener>>();
export function listenTaskProgress(workspace: object, listener: Listener) {
  let group = listeners.get(workspace);
  if (!group) listeners.set(workspace, (group = new Set()));
  group.add(listener);
  return () => {
    group.delete(listener);
  };
}
export function persistedTaskProgress(
  workspace: object,
  input: RunAgentInput,
  event: BaseEvent,
) {
  if (
    event.type !== EventType.CUSTOM ||
    !('name' in event) ||
    event.name !== taskProgressEvent ||
    !('value' in event)
  )
    return;
  const value = event.value as { messageId?: unknown } | null;
  if (!value || typeof value.messageId !== 'string') return;
  for (const listener of listeners.get(workspace) ?? []) {
    try {
      listener(input, value.messageId);
    } catch {
      /* Speech cannot affect task execution. */
    }
  }
}
