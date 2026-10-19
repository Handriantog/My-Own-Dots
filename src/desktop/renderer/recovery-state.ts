import type {
  DesktopWorkspaceBridge,
  WorkspaceStatus,
} from '../shared/workspace-contract.js';

/** Display stages come from actual host events, never a timer or invented percentage. */
export function recoveryView(
  state: WorkspaceStatus,
  {
    setup = false,
    elapsedMs = 0,
  }: { setup?: boolean; elapsedMs?: number } = {},
) {
  const loading = state.phase === 'idle' || state.phase === 'starting';
  const waiting = loading && elapsedMs >= 12_000;
  const error = state.phase === 'error';
  const stopped = state.phase === 'stopped';
  const mode = setup
    ? 'setup'
    : error
      ? 'error'
      : stopped
        ? 'stopped'
        : loading
          ? 'loading'
          : 'ready';
  const stage = state.stage ?? 'workspace';
  return {
    mode,
    status: error
      ? 'Connection needs attention'
      : stopped
        ? 'Workspace is paused'
        : state.phase === 'ready'
          ? setup
            ? 'Workspace connected'
            : 'Workspace ready'
          : stage === 'services'
            ? 'Checking your connections'
            : stage === 'backend'
              ? 'Waking up your workspace'
              : 'Finding your workspace',
    detail: state.warning || state.message,
    showActions:
      setup ||
      error ||
      stopped ||
      waiting ||
      state.phase === 'ready' ||
      !!state.warning,
    warning: !!state.warning,
    loading,
  };
}

/** Subscribe first and reject a stale snapshot that resolves after a newer event. */
export function watchWorkspaceStatus(
  bridge: Pick<DesktopWorkspaceBridge, 'status' | 'onStatus'>,
  render: (status: WorkspaceStatus) => void,
) {
  let receivedEvent = false;
  let disposed = false;
  const unsubscribe = bridge.onStatus((status) => {
    if (disposed) return;
    receivedEvent = true;
    render(status);
  });
  void bridge.status().then(
    (status) => {
      if (!disposed && !receivedEvent) render(status);
    },
    () => {
      if (!disposed && !receivedEvent)
        render({
          phase: 'error',
          message:
            'Could not connect to your workspace. Retry to reconnect, or check workspace setup.',
        });
    },
  );
  return () => {
    disposed = true;
    unsubscribe();
  };
}
