import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { CopilotKitCoreErrorCode } from '@copilotkit/core';
import {
  CopilotChatConfigurationProvider,
  CopilotChatToolCallsView,
  CopilotKitProvider,
  useAgent,
  useCopilotKit,
  useHumanInTheLoop,
} from '@copilotkit/react-core/v2';
import type {
  DesktopApprovalBridge,
  FolderApprovalState,
} from '../desktop/shared/approval-contract';
import {
  folderApprovalSchema,
  folderApprovalTool,
  type FolderApprovalPending,
} from '../shared/folder-access';
import { pageReviewSchema, pageReviewTool } from '../shared/page-review';
import {
  connectionActionSchema,
  connectionActionTool,
} from '../shared/connection-types';
import { authHeaders } from './api';
import { FolderAccessCard } from './FolderAccessCard';

declare global {
  interface Window {
    dotApproval?: DesktopApprovalBridge;
  }
}

const messageForError = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;
const sessionKey = (request: FolderApprovalPending) =>
  `${request.dotId}:${request.threadId}`;

export function FolderApprovalApp() {
  const bridge = window.dotApproval;
  const [state, setState] = useState<FolderApprovalState>();
  const [sessions, setSessions] = useState<FolderApprovalPending[]>([]);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const releaseSession = useCallback((key: string) => {
    setSessions((current) =>
      current.filter((session) => sessionKey(session) !== key),
    );
  }, []);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    let receivedUpdate = false;
    const receive = (value: FolderApprovalState) => {
      if (!active) return;
      setState(value);
      setError('');
      if (value.request) {
        const request = value.request;
        setSessions((current) =>
          current.some((item) => sessionKey(item) === sessionKey(request))
            ? current
            : [...current, request],
        );
      }
    };
    const unsubscribe = bridge.onState((value) => {
      receivedUpdate = true;
      receive(value);
    });
    void bridge.state().then(
      (value) => {
        if (!receivedUpdate) receive(value);
      },
      (cause) => {
        if (active && !receivedUpdate)
          setError(messageForError(cause, 'Could not load folder approvals.'));
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge, attempt]);
  const navigate = async (action: 'dismiss' | 'next') => {
    if (!bridge || actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError('');
    try {
      await bridge[action]();
    } catch (cause) {
      setError(messageForError(cause, 'Could not update folder approvals.'));
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  };
  const selected = state?.request;
  return (
    <main className="folder-approval-surface" aria-label="Folder approval">
      <header className="folder-approval-titlebar">
        <h1
          title={selected ? `${selected.dotName} · Folder access` : undefined}
        >
          {selected ? `${selected.dotName} · Folder access` : 'Folder access'}
        </h1>
        <button
          type="button"
          className="folder-approval-close"
          aria-label="Close folder approval"
          disabled={busy || !bridge}
          onClick={() => void navigate('dismiss')}
        >
          <X size={18} />
        </button>
      </header>
      {error && (
        <div className="folder-approval-notice" role="alert">
          <p>{error}</p>
          <button
            type="button"
            aria-label="Retry folder approvals"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {!bridge ? (
        <p role="alert">Open this approval from the desktop app.</p>
      ) : !state && !error ? (
        <p role="status">Loading…</p>
      ) : state && !selected ? (
        <p role="status">No folder requests.</p>
      ) : null}
      <CopilotKitProvider runtimeUrl="/api/copilotkit" headers={authHeaders()}>
        {/* Retain visited runtimes when the host hides or advances the panel.
            Resolving a HITL response starts an asynchronous SDK continuation. */}
        {sessions.map((session) => (
          <FolderApprovalSession
            key={sessionKey(session)}
            session={session}
            request={
              selected && sessionKey(selected) === sessionKey(session)
                ? selected
                : null
            }
            onIdle={releaseSession}
          />
        ))}
      </CopilotKitProvider>
      {selected && state.count > 1 && (
        <footer className="folder-approval-navigation">
          <span>{state.count} requests</span>
          <button
            type="button"
            aria-label="Next request"
            disabled={busy}
            onClick={() => void navigate('next')}
          >
            Next
          </button>
        </footer>
      )}
    </main>
  );
}

function FolderApprovalSession({
  session,
  request,
  onIdle,
}: {
  session: FolderApprovalPending;
  request: FolderApprovalPending | null;
  onIdle: (key: string) => void;
}) {
  const agentId = `chat-${session.threadId}`;
  const { agent, isReady } = useAgent({
    agentId,
    runtimeAgentId: session.dotId,
    threadId: session.threadId,
  });
  const { copilotkit } = useCopilotKit();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [activeTool, setActiveTool] = useState('');
  const [idleAfterSuccess, setIdleAfterSuccess] = useState(false);
  const selected = useRef(request);
  selected.current = request;
  const lastSnapshotRequest = useRef<string | undefined>(undefined);
  const executing = useRef('');
  const resuming = useRef(false);
  const requestKey = request
    ? `${request.requestId}:${request.toolCallId}`
    : undefined;
  const message = agent.messages.find(
    (message) =>
      message.role === 'assistant' &&
      message.toolCalls?.some(
        (call) =>
          call.id === request?.toolCallId &&
          call.function.name === folderApprovalTool.name,
      ),
  );
  const selectedCall =
    message?.role === 'assistant'
      ? message.toolCalls?.find((call) => call.id === request?.toolCallId)
      : undefined;
  let matchesRequest = false;
  try {
    const parsed = folderApprovalSchema.safeParse(
      JSON.parse(selectedCall?.function.arguments ?? 'null'),
    );
    matchesRequest =
      parsed.success && parsed.data.requestId === request?.requestId;
  } catch {
    /* Incomplete or invalid runtime arguments cannot grant access. */
  }
  useEffect(() => {
    if (idleAfterSuccess && !request) onIdle(sessionKey(session));
  }, [idleAfterSuccess, request, onIdle, session]);
  useEffect(() => {
    let successful = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const subscription = copilotkit.subscribe({
      onToolExecutionStart: (event) => {
        if (event.agentId !== agentId) return;
        // A following approval can wait before the SDK starts any transport.
        // The previous response's handoff is over once this resolver begins.
        resuming.current = false;
        executing.current = event.toolCallId;
        setActiveTool(event.toolCallId);
        setIdleAfterSuccess(false);
      },
      onToolExecutionEnd: (event) => {
        if (event.agentId !== agentId || executing.current !== event.toolCallId)
          return;
        executing.current = '';
        setActiveTool('');
      },
      onError: ({ error: cause, code, context }) => {
        if (context?.agentId && context.agentId !== agentId) return;
        setError(cause.message);
        if (
          resuming.current &&
          [
            CopilotKitCoreErrorCode.AGENT_RUN_FAILED,
            CopilotKitCoreErrorCode.AGENT_RUN_FAILED_EVENT,
            CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT,
            CopilotKitCoreErrorCode.AGENT_THREAD_LOCKED,
          ].includes(code)
        ) {
          resuming.current = false;
          setLoaded(false);
          setAttempt((value) => value + 1);
        }
      },
    });
    const events = agent.subscribe({
      onRunFinishedEvent: ({ outcome }) => {
        successful = outcome === 'success';
        if (outcome === 'success') resuming.current = false;
      },
      onRunFailed: () => {
        successful = false;
      },
      onRunFinalized: () => {
        clearTimeout(idleTimer);
        // Allow SDK tool processing to begin before deciding this runtime can
        // be released. A saved decision alone is not a finished continuation.
        idleTimer = setTimeout(() => {
          const pendingApproval = agent.messages.some(
            (message) =>
              message.role === 'assistant' &&
              message.toolCalls?.some(
                (call) =>
                  [
                    folderApprovalTool.name,
                    pageReviewTool.name,
                    connectionActionTool.name,
                  ].includes(call.function.name) &&
                  !agent.messages.some(
                    (result) =>
                      result.role === 'tool' && result.toolCallId === call.id,
                  ),
              ),
          );
          if (
            successful &&
            !agent.isRunning &&
            !executing.current &&
            !pendingApproval
          )
            setIdleAfterSuccess(true);
        }, 0);
      },
    });
    return () => {
      clearTimeout(idleTimer);
      subscription.unsubscribe();
      events.unsubscribe();
    };
  }, [agent, agentId, copilotkit]);
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    const selection = selected.current;
    lastSnapshotRequest.current = selection
      ? `${selection.requestId}:${selection.toolCallId}`
      : undefined;
    setLoaded(false);
    void copilotkit
      .connectAgent({ agent })
      .then(() => {
        if (active) setLoaded(true);
      })
      .catch((cause) => {
        if (active)
          setError(
            messageForError(cause, 'Could not connect this conversation.'),
          );
      });
    return () => {
      active = false;
    };
  }, [agent, copilotkit, isReady, attempt]);
  useEffect(() => {
    // An idle connect is a snapshot, not a subscription to later chat turns.
    // Refresh a newly selected canonical request only when it is absent here.
    // Our own continuation may still be streaming that request, so let it
    // settle before replacing its messages or pending HITL resolver.
    if (
      !loaded ||
      !requestKey ||
      matchesRequest ||
      resuming.current ||
      agent.isRunning ||
      lastSnapshotRequest.current === requestKey
    )
      return;
    lastSnapshotRequest.current = requestKey;
    setLoaded(false);
    setAttempt((value) => value + 1);
  }, [loaded, requestKey, matchesRequest, agent.isRunning]);

  // Keep the same frontend capability set as Chat. Other approval types stay
  // pending in their normal conversation UI; this window renders only a folder.
  useHumanInTheLoop(
    {
      name: pageReviewTool.name,
      description: pageReviewTool.description,
      parameters: pageReviewSchema,
      agentId,
      render: () => null,
    },
    [agentId],
  );
  useHumanInTheLoop(
    {
      name: connectionActionTool.name,
      description: connectionActionTool.description,
      parameters: connectionActionSchema,
      agentId,
      render: () => null,
    },
    [agentId],
  );
  const pickerAvailable = !!window.dotFolders;
  useHumanInTheLoop(
    {
      name: folderApprovalTool.name,
      description: folderApprovalTool.description,
      parameters: folderApprovalSchema,
      agentId,
      available: pickerAvailable,
      render: (props) => (
        <FolderAccessCard
          {...props}
          compact
          threadId={session.threadId}
          respond={
            props.respond && props.toolCallId === activeTool
              ? async (result) => {
                  if (
                    selected.current?.toolCallId !== props.toolCallId ||
                    executing.current !== props.toolCallId
                  )
                    throw new Error(
                      'This folder request is no longer selected.',
                    );
                  resuming.current = true;
                  setError('');
                  await props.respond!(result);
                }
              : undefined
          }
        />
      ),
    },
    [agentId, session.threadId, pickerAvailable, activeTool],
  );

  if (!request) return null;
  const retry = () => {
    setError('');
    setAttempt((value) => value + 1);
  };
  return (
    <section
      className="folder-approval-review"
      aria-label={`${request.dotName} folder request`}
    >
      {error && (
        <div className="folder-approval-notice" role="alert">
          <p>{error}</p>
          <button
            type="button"
            aria-label="Reconnect folder approval"
            onClick={retry}
          >
            Reconnect
          </button>
        </div>
      )}
      {!loaded ? (
        <p role="status">Loading…</p>
      ) : message?.role === 'assistant' && selectedCall && matchesRequest ? (
        <>
          {activeTool && activeTool !== request.toolCallId && (
            <p role="status">
              An earlier request is waiting. Review it in chat.
            </p>
          )}
          <CopilotChatConfigurationProvider
            agentId={agentId}
            threadId={session.threadId}
          >
            <CopilotChatToolCallsView
              key={`${request.requestId}:${request.toolCallId}:${attempt}`}
              message={{ ...message, toolCalls: [selectedCall] }}
              messages={agent.messages}
            />
          </CopilotChatConfigurationProvider>
        </>
      ) : (
        <div className="folder-approval-notice" role="status">
          <p>This request is no longer waiting.</p>
          <button
            type="button"
            aria-label="Reload folder conversation"
            onClick={retry}
          >
            Check again
          </button>
        </div>
      )}
    </section>
  );
}
