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
  const activeStep =
    error || stopped
      ? -1
      : state.phase === 'ready'
        ? 3
        : ['workspace', 'services', 'backend'].indexOf(stage);
  return {
    mode,
    activeStep,
    eyebrow: setup
      ? 'MAKE YOURSELF AT HOME'
      : error
        ? 'A LITTLE HELP, THEN WE’RE OFF'
        : stopped
          ? 'READY WHEN YOU ARE'
          : state.phase === 'ready'
            ? 'LET’S MAKE SOMETHING'
            : 'DOT IS GETTING THINGS READY',
    headline: setup
      ? 'Your space. Your way.'
      : error
        ? 'Let’s get you connected.'
        : stopped
          ? 'Pick up where you left off.'
          : state.phase === 'ready'
            ? 'Your next idea awaits.'
            : 'Good things are\ncoming together.',
    description: setup
      ? 'Keep your workspace and connections just the way you like them.'
      : error
        ? 'Dot is here. Your workspace just needs a little attention.'
        : stopped
          ? 'Your workspace is here whenever you’re ready.'
          : waiting
            ? 'A little longer this time. We’re still getting your workspace ready.'
            : state.phase === 'ready'
              ? state.warning
                ? 'Your workspace is ready. One connection needs attention.'
                : 'Everything is in place. Come on in.'
              : 'A little space to think. A companion to make it happen.',
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
