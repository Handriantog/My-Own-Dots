import { MemoryPanel } from './MemoryPanel';
import { MemoryActivity } from './MemoryActivity';
import {
  allowNavigation,
  restoreSelection,
  resetNavigationForConfiguration,
  savedNavigation,
  type Surface,
  type WorkspaceView,
} from './workspace-navigation';
import { WorkspaceRail, WorkspaceTitlebar } from './WorkspaceShell';
import { QuickNavigation } from './QuickNavigation';
import type {
  WorkspaceCommand,
  WorkspaceDestination,
  WorkspaceStatus,
} from '../desktop/shared/workspace-contract';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { SpaceWorkspace } from './SpaceWorkspace';
type MessageDestination = WorkspaceDestination & { messageId?: string };
import { useCallback, useEffect, useState, useRef } from 'react';
import { CopilotKitProvider } from '@copilotkit/react-core/v2';
import {
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Clock3,
  MessageCircle,
  Monitor,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Conversation,
  ConversationUpdate,
  Detail,
  Dot,
  Result,
  State,
  WorkspaceState,
} from '../shared/types';
import { api, ApiError, authHeaders, setToken } from './api';
import { trackSetupStep } from './setup-telemetry';
import {
  applyCaptureResult,
  applyRefreshResult,
  dismissNotice,
  visibleNotice,
  type Notices,
} from './poll-notice';
import { Mascot } from './Mascot';
import { useCompanionColor } from './companion-appearance';
import { Chat } from './Chat';
import { FolderAccessSettings } from './FolderAccessSettings';
import { VoiceSettings } from './local-voice/VoiceSettings';
import { CallView } from './CallView';
import { ResultPane } from './ResultPane';
import { TaskRow } from './TaskPresentation';
import { TaskActions } from './TaskActions';
import { WorkspaceDialog, type Dialog } from './WorkspaceDialog';
import { submitComposerOnEnter } from './chat-composer';
import type { LocalVoiceStatus } from '../shared/local-voice';

function describeFailure(error: unknown, fallback: string) {
  return {
    ok: false as const,
    status: error instanceof ApiError ? error.status : undefined,
    message: error instanceof Error ? error.message : fallback,
  };
}

export function App({
  surface: explicitSurface,
  desktop: legacyDesktop = false,
}: {
  surface?: Surface;
  desktop?: boolean;
}) {
  const surface =
    explicitSurface ?? (legacyDesktop ? 'companion' : 'workspace');
  const desktop = surface === 'companion';
  const [configurationReset] = useState(() =>
    resetNavigationForConfiguration(),
  );
  const [selection] = useState(() => {
    try {
      return restoreSelection(surface, (key) =>
        configurationReset ? '' : localStorage.getItem(key),
      );
    } catch {
      return { dotId: '', threadId: undefined };
    }
  });
  const companionColor = useCompanionColor();
  const [state, setState] = useState<State>();
  const [workspace, setWorkspace] = useState<WorkspaceState>();
  const conversationRevision = useRef(0);
  const [selectedDot, setSelectedDot] = useState(selection.dotId);
  const dot =
    workspace?.dots.find((item) => item.id === selectedDot) ??
    workspace?.dots[0];
  const [voiceRevision, setVoiceRevision] = useState(0);
  const refreshVoiceSettings = useCallback(
    () => setVoiceRevision((value) => value + 1),
    [],
  );
  const [activeVoiceDot, setActiveVoiceDot] = useState<string>();
  const voiceActive = useCallback((dotId: string, active: boolean) => {
    setActiveVoiceDot((previous) =>
      active ? dotId : previous === dotId ? undefined : previous,
    );
  }, []);
  const voiceScope = `${dot?.id ?? ''}:${voiceRevision}`;
  const [resolvedVoiceScope, setResolvedVoiceScope] = useState('');
  const [voiceStatus, setLocalVoice] = useState<LocalVoiceStatus>({
    enabled: false,
    ready: false,
    reason: 'Checking local voice setup…',
  });
  const [voiceIntent, setVoiceIntent] = useState(0);
  const nextVoiceIntent = useRef(0);
  const [voiceChecked, setLocalVoiceChecked] = useState(false);
  const [voiceResolved, setLocalVoiceResolved] = useState(false);
  const currentVoiceScope = voiceScope === resolvedVoiceScope;
  const localVoiceChecked = currentVoiceScope && voiceChecked;
  const localVoiceResolved = currentVoiceScope && voiceResolved;
  const localVoice = currentVoiceScope
    ? voiceStatus
    : ({
        enabled: voiceStatus.enabled,
        ready: false,
        reason: 'Checking local voice setup…',
      } as LocalVoiceStatus);
  const voiceCreation = useRef(0);
  const consumeVoiceIntent = useCallback(() => {
    setVoiceIntent(0);
    window.dotVoice?.cancelTalk();
  }, []);
  useEffect(() => {
    const offTalk = window.dotVoice?.onTalk(() =>
      setVoiceIntent(++nextVoiceIntent.current),
    );
    // The host already revoked this request. Echoing cancelTalk can cancel a
    // newer shortcut request queued while this renderer was busy.
    const offStop = window.dotVoice?.onStop(() => setVoiceIntent(0));
    const hidden = () => {
      if (
        document.visibilityState === 'hidden' &&
        !window.dotVoice?.isWindowless?.()
      )
        consumeVoiceIntent();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', consumeVoiceIntent);
    return () => {
      offTalk?.();
      offStop?.();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', consumeVoiceIntent);
      window.dotVoice?.cancelTalk();
    };
  }, [consumeVoiceIntent]);
  useEffect(() => {
    if (!dot?.id) return;
    let active = true;
    let checking = false;
    const controller = new AbortController();
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const status = await api<LocalVoiceStatus>(
          `/local-voice/status?dotId=${encodeURIComponent(dot.id)}`,
          'GET',
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        );
        if (active) {
          setLocalVoice(status);
          setLocalVoiceChecked(true);
          setLocalVoiceResolved(true);
          setResolvedVoiceScope(voiceScope);
        }
      } catch {
        if (active) {
          setLocalVoiceChecked(false);
          setLocalVoiceResolved(true);
          setResolvedVoiceScope(voiceScope);
          setLocalVoice((previous) => ({
            ...previous,
            ready: false,
            reason: 'Local voice setup is unavailable.',
          }));
        }
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 5000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [dot?.id, voiceScope, voiceIntent]);
  useEffect(() => {
    // A failed status poll blocks new starts, but the active call has its own
    // heartbeat/SSE failure handling. Only confirmed unavailability revokes it.
    if (!localVoiceChecked && !state?.settings.paused) return;
    window.dotVoice?.setReady(
      localVoice.ready && !!workspace && !state?.settings.paused,
    );
  }, [
    localVoice.ready,
    localVoiceChecked,
    !!workspace,
    state?.settings.paused,
  ]);
  useEffect(
    () => () => {
      void window.dotVoice?.setReady(false);
    },
    [],
  );
  const [selectedThread, setSelectedThread] = useState<string | undefined>(
    selection.threadId,
  );
  const [messageTarget, setMessageTarget] = useState<{
    threadId: string;
    messageId: string;
  }>();
  useEffect(() => {
    try {
      localStorage.setItem(`${surface}-dot`, selectedDot);
      localStorage.setItem(`${surface}-thread`, selectedThread ?? '');
    } catch {
      /* Selection can remain in memory. */
    }
  }, [surface, selectedDot, selectedThread]);
  const [savedNavigationState] = useState(() =>
    configurationReset
      ? {
          view: 'chat' as const,
          spaceId: '',
          pageId: undefined,
          collapsed: false,
        }
      : savedNavigation(surface),
  );
  const [view, rawSetView] = useState<WorkspaceView>(savedNavigationState.view);
  const dirtyPage = useRef(false);
  const acceptedHash = useRef(location.hash);
  const [storedSpaceId, setSpaceId] = useState(savedNavigationState.spaceId);
  const [storedPageId, setPageId] = useState<string | undefined>(
    savedNavigationState.pageId,
  );
  const spaceId = workspace
    ? workspace.spaces.find((space) => space.id === storedSpaceId)?.id ||
      workspace.spaces[0]?.id ||
      ''
    : storedSpaceId;
  const pageId = spaceId === storedSpaceId ? storedPageId : undefined;
  if (workspace && spaceId !== storedSpaceId) {
    setSpaceId(spaceId);
    setPageId(undefined);
    dirtyPage.current = false;
  }
  const setDirtyPage = useCallback((value: boolean) => {
    dirtyPage.current = value;
  }, []);
  const guard = (commit: () => void) =>
    allowNavigation(
      dirtyPage.current,
      () => window.confirm('Leave your unsaved page draft?'),
      () => {
        dirtyPage.current = false;
        commit();
      },
    );
  const setView = (next: WorkspaceView) =>
    guard(() => {
      setMessageTarget(undefined);
      if (next !== 'space') acceptedHash.current = '';
      if (next !== 'space' && typeof history !== 'undefined')
        history.replaceState(null, '', location.pathname + location.search);
      if (
        next === 'space' &&
        !workspace?.spaces.some((space) => space.id === spaceId)
      )
        setSpaceId(workspace?.spaces[0]?.id || '');
      rawSetView(next);
    });
  const navigateDestination = (destination: MessageDestination) =>
    guard(() => {
      setMessageTarget(
        destination.threadId && destination.messageId
          ? { threadId: destination.threadId, messageId: destination.messageId }
          : undefined,
      );
      if (destination.spaceId) {
        setSpaceId(destination.spaceId);
        setPageId(destination.pageId);
        rawSetView('space');
        acceptedHash.current = `#/spaces/${destination.spaceId}${destination.pageId ? `/pages/${destination.pageId}` : ''}`;
        history.replaceState(
          null,
          '',
          `#/spaces/${destination.spaceId}${destination.pageId ? `/pages/${destination.pageId}` : ''}`,
        );
      } else {
        const targetDot =
          destination.dotId ||
          workspace?.conversations.find((t) => t.id === destination.threadId)
            ?.dotId ||
          dot?.id ||
          '';
        setSelectedDot(targetDot);
        setSelectedThread(destination.threadId);
        setPendingPrompt(undefined);
        rawSetView('chat');
        acceptedHash.current = '';
        if (typeof history !== 'undefined')
          history.replaceState(null, '', location.pathname + location.search);
      }
    });
  const openPage = (space: string, page?: string) =>
    navigateDestination({ spaceId: space, pageId: page });
  const [quickOpen, setQuickOpen] = useState(false);
  const [backendStatus, setBackendStatus] = useState<WorkspaceStatus>();
  const pendingNavigation = useRef<MessageDestination | undefined>(undefined);
  const pendingCommands = useRef<WorkspaceCommand[]>([]);
  const handlers = useRef<{
    navigate: (destination: MessageDestination) => void;
    command: (command: WorkspaceCommand) => void;
  }>({ navigate: () => {}, command: () => {} });
  useEffect(() => {
    const bridge = window.dotWorkspace;
    const offNavigate = bridge?.onNavigate((destination) => {
      pendingNavigation.current = destination;
      handlers.current.navigate(destination);
    });
    const offCommand = bridge?.onCommand((command) =>
      handlers.current.command(command),
    );
    const offStatus = bridge?.onStatus((status) => {
      setBackendStatus(status);
      if (status.phase !== 'ready') refreshVoiceSettings();
    });
    void bridge
      ?.status()
      .then(setBackendStatus)
      .catch(() => {});
    const key = (event: KeyboardEvent) => {
      if (bridge || !(event.metaKey || event.ctrlKey)) return;
      const command =
        event.key.toLowerCase() === 'k'
          ? 'quick-navigation'
          : event.key.toLowerCase() === 'n'
            ? 'new-chat'
            : event.key === ','
              ? 'settings'
              : event.key.toLowerCase() === 'b' && event.shiftKey
                ? 'toggle-sidebar'
                : undefined;
      if (command) {
        event.preventDefault();
        handlers.current.command(command);
      }
    };
    const hash = () => {
      const [path, query] = location.hash.split('?');
      const match = path.match(
        /^#\/(spaces|chat)\/([^/]+)(?:\/(?:pages\/)?([^/]+))?$/,
      );
      if (!match) return;
      try {
        match[2] = decodeURIComponent(match[2]);
        if (match[3]) match[3] = decodeURIComponent(match[3]);
      } catch {
        return;
      }
      const messageId = new URLSearchParams(query).get('message');
      const destination =
        match[1] === 'spaces'
          ? { spaceId: match[2], pageId: match[3] }
          : {
              dotId: match[2],
              threadId: match[3],
              messageId: messageId ?? undefined,
            };
      pendingNavigation.current = destination;
      handlers.current.navigate(destination);
      if (dirtyPage.current)
        history.replaceState(
          null,
          '',
          acceptedHash.current || location.pathname + location.search,
        );
      else acceptedHash.current = location.hash;
    };
    hash();
    window.addEventListener('hashchange', hash);
    window.addEventListener('keydown', key);
    return () => {
      offNavigate?.();
      offCommand?.();
      offStatus?.();
      window.removeEventListener('hashchange', hash);
      window.removeEventListener('keydown', key);
    };
  }, []);
  useEffect(() => {
    if (!workspace) return;
    if (pendingNavigation.current)
      handlers.current.navigate(pendingNavigation.current);
    for (const command of pendingCommands.current.splice(0))
      handlers.current.command(command);
  }, [workspace]);

  const [notices, setNotices] = useState<Notices>({
    refresh: '',
    capture: '',
    action: '',
  });
  const error = visibleNotice(notices);
  const setError = (action: string) =>
    setNotices((current) =>
      current.action === action ? current : { ...current, action },
    );
  const [auth, setAuth] = useState('');
  const [needsAuth, setNeedsAuth] = useState(false);
  const [dialog, setDialog] = useState<Dialog>();
  const [navCollapsed, setNavCollapsed] = useState(
    savedNavigationState.collapsed,
  );
  useEffect(() => {
    try {
      localStorage.setItem(
        `${surface}-navigation`,
        JSON.stringify({ view, spaceId, pageId, collapsed: navCollapsed }),
      );
    } catch {
      /* Navigation can remain in memory. */
    }
  }, [surface, view, spaceId, pageId, navCollapsed]);
  const [pane, setPane] = useState(false);
  const [capture, setCapture] = useState<Result>();
  const [prompt, setPrompt] = useState('');
  const [pendingPrompt, setPendingPrompt] = useState<string>();
  useEffect(() => {
    if (
      !selectedThread ||
      !workspace?.deletedConversations?.some(
        (item) => item.id === selectedThread,
      )
    )
      return;
    setSelectedThread(undefined);
    setMessageTarget(undefined);
    setPendingPrompt(undefined);
    if (location.hash.startsWith('#/chat/'))
      history.replaceState(null, '', location.pathname + location.search);
  }, [workspace, selectedThread]);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [taskDetail, setTaskDetail] = useState<Detail>();
  useEffect(() => {
    if (!voiceIntent) return;
    const timer = setTimeout(() => {
      consumeVoiceIntent();
      setError(
        'The conversation took too long to connect. Choose Talk to try again.',
      );
    }, 30000);
    return () => clearTimeout(timer);
  }, [voiceIntent, consumeVoiceIntent]);
  const refresh = useCallback(async () => {
    const revision = conversationRevision.current;
    try {
      const [s, w] = await Promise.all([
        api<State>('/state'),
        api<WorkspaceState>('/workspace'),
      ]);
      setState(s);
      if (revision === conversationRevision.current) setWorkspace(w);
      setNeedsAuth(false);
      setSelectedDot((previous) =>
        w.dots.some((dot) => dot.id === previous)
          ? previous
          : w.dots[0]?.id || '',
      );
      setNotices((current) => applyRefreshResult(current, { ok: true }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedsAuth(true);
      setNotices((current) =>
        applyRefreshResult(
          current,
          describeFailure(e, 'Could not connect to the server.'),
        ),
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    setCapture(undefined);
    if (!selectedThread) return;
    let active = true;
    const load = () =>
      void api<Result | null>(`/conversations/${selectedThread}/capture`)
        .then((result) => {
          if (!active) return;
          setCapture(result ?? undefined);
          setNotices((current) => applyCaptureResult(current, { ok: true }));
        })
        .catch((e) => {
          if (!active) return;
          setNotices((current) =>
            applyCaptureResult(
              current,
              describeFailure(e, 'Could not connect to the server.'),
            ),
          );
        });
    load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selectedThread]);
  const mutate = async (path: string, method: string, body?: unknown) => {
    setError('');
    try {
      await api(path, method, body);
      await refresh();
      if (taskDetail)
        setTaskDetail(await api<Detail>(`/tasks/${taskDetail.task.id}`));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      return false;
    }
  };
  const updateConversation = async (id: string, patch: ConversationUpdate) => {
    const updated = await api<Conversation>(
      `/conversations/${encodeURIComponent(id)}`,
      'PATCH',
      patch,
    );
    conversationRevision.current += 1;
    setWorkspace(
      (current) =>
        current && {
          ...current,
          conversations: current.conversations.map((item) =>
            item.id === id ? updated : item,
          ),
        },
    );
  };
  const deleteConversation = async (id: string) => {
    const deleted = await api<Conversation>(
      `/conversations/${encodeURIComponent(id)}`,
      'DELETE',
    );
    conversationRevision.current += 1;
    setWorkspace(
      (current) =>
        current && {
          ...current,
          conversations: current.conversations.filter((item) => item.id !== id),
          deletedConversations: [
            deleted,
            ...(current.deletedConversations ?? []).filter(
              (item) => item.id !== id,
            ),
          ],
        },
    );
  };
  const restoreConversation = async (id: string) => {
    const restored = await api<Conversation>(
      `/conversations/${encodeURIComponent(id)}/restore`,
      'POST',
    );
    conversationRevision.current += 1;
    setWorkspace(
      (current) =>
        current && {
          ...current,
          conversations: [
            ...current.conversations.filter((item) => item.id !== id),
            restored,
          ].sort((a, b) => b.createdAt - a.createdAt),
          deletedConversations: (current.deletedConversations ?? []).filter(
            (item) => item.id !== id,
          ),
        },
    );
  };
  const thread = workspace?.conversations.find(
    (item) => item.id === selectedThread && item.dotId === dot?.id,
  );
  const configured = !!workspace && workspace.setup.missing.length === 0;
  const setupStep = workspace
    ? dialog?.type === 'settings'
      ? 'settings'
      : configured
        ? 'ready'
        : 'setup_required'
    : undefined;
  useEffect(() => {
    if (!setupStep) return;
    return trackSetupStep(setupStep);
  }, [setupStep]);
  const chooseDot = (next: Dot) =>
    navigateDestination({
      dotId: next.id,
      threadId: workspace?.conversations.find((item) => item.dotId === next.id)
        ?.id,
    });
  const newConversation = async (text?: string) => {
    if (!dot || !configured || busy || !setView('chat')) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<Conversation>('/conversations', 'POST', {
        dotId: dot.id,
        title: text?.slice(0, 80) || 'A new thought',
      });
      await refresh();
      if (navigateDestination({ dotId: dot.id, threadId: next.id })) {
        setPendingPrompt(text);
        setPrompt('');
      }
    } catch (e) {
      if (voiceIntent)
        window.dotVoice?.reportError?.(
          e instanceof Error ? e.message : 'Could not create the conversation.',
        );
      consumeVoiceIntent();
      setError(
        e instanceof Error ? e.message : 'Could not create the conversation.',
      );
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!voiceIntent) return;
    if (
      needsAuth ||
      (workspace && !configured) ||
      state?.settings.paused ||
      (localVoiceResolved && !localVoice.ready)
    ) {
      const reason = needsAuth
        ? 'Unlock your workspace, then choose Talk again.'
        : !configured
          ? 'Complete your workspace setup before starting a call.'
          : state?.settings.paused
            ? 'Resume your Dot before starting a call.'
            : localVoice.reason ||
              'Complete local voice setup before starting a call.';
      window.dotVoice?.reportError?.(reason);
      consumeVoiceIntent();
      setError(reason);
      return;
    }
    if (!configured || !dot) return;
    if (view !== 'chat' && !setView('chat')) {
      consumeVoiceIntent();
      return;
    }
    if (!thread && !busy && voiceCreation.current !== voiceIntent) {
      voiceCreation.current = voiceIntent;
      const existing = workspace?.conversations.find(
        (item) => item.dotId === dot.id,
      );
      if (existing) setSelectedThread(existing.id);
      else void newConversation();
    }
  }, [
    voiceIntent,
    configured,
    dot?.id,
    thread?.id,
    busy,
    needsAuth,
    localVoiceResolved,
    localVoice.ready,
    state?.settings.paused,
  ]);
  handlers.current = {
    navigate: (destination) => {
      if (!workspace) return;
      pendingNavigation.current = undefined;
      navigateDestination(destination);
    },
    command: (command) => {
      if (!workspace) {
        pendingCommands.current.push(command);
        return;
      }
      if (command === 'quick-navigation') setQuickOpen(true);
      else if (command === 'toggle-sidebar') setNavCollapsed((value) => !value);
      else if (command === 'settings') {
        if (desktop) setDialog({ type: 'settings' });
        else setView('settings');
      } else void newConversation();
    },
  };
  if (needsAuth)
    return (
      <main className="unlock">
        {desktop ? (
          <div className="companion-connecting" aria-hidden="true">
            <MessageCircle size={30} />
          </div>
        ) : (
          <Mascot />
        )}
        <h1>Unlock My Own Dots</h1>
        <p>Enter the owner access token for this workspace.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setToken(auth);
            try {
              await api('/state');
              setError('');
              await refresh();
            } catch (err) {
              setError(
                err instanceof Error
                  ? err.message
                  : 'Access token was not accepted.',
              );
            }
          }}
        >
          <input
            type="password"
            aria-label="Owner access token"
            autoComplete="current-password"
            value={auth}
            onChange={(e) => setAuth(e.target.value)}
            required
          />
          <button className="primary">Unlock workspace</button>
        </form>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <p className="muted">The access token is retained for this session.</p>
      </main>
    );
  if (!state || !workspace || !dot)
    return (
      <main className="unlock">
        {desktop ? (
          <div className="companion-connecting" aria-hidden="true">
            <MessageCircle size={30} />
          </div>
        ) : (
          <Mascot state="working" />
        )}
        <h1>
          {voiceIntent ? 'Connecting voice call…' : 'Opening your workspace…'}
        </h1>
        <p>
          {backendStatus?.message ||
            'Loading your Dots, conversations and Spaces.'}
        </p>
        {window.dotWorkspace && (
          <button
            onClick={() =>
              void window
                .dotWorkspace!.openBackendSettings()
                .catch((e) => setError(e.message))
            }
          >
            Workspace setup
          </button>
        )}
        {error && (
          <>
            <p className="chat-error">{error}</p>
            <button onClick={() => void refresh()}>Retry</button>
          </>
        )}
      </main>
    );
  const content = (
    <div
      className={`app template-app ${navCollapsed ? 'nav-collapsed' : ''} ${desktop ? 'desktop-chat' : 'desktop-workspace'}`}
    >
      {voiceIntent > 0 && !thread && configured && (
        <CallView
          dot={dot}
          companionColor={companionColor}
          voice={{
            status: 'connecting',
            phase: 'listening',
            error: '',
            muted: false,
            speakerMuted: false,
            startedAt: undefined,
            caption: 'Preparing your conversation…',
            userCaption: '',
            start: async () => {},
            end: async () => consumeVoiceIntent(),
            toggleMute() {},
            toggleSpeaker() {},
          }}
        />
      )}
      {!desktop && (
        <>
          <WorkspaceTitlebar
            onSearch={() => setQuickOpen(true)}
            onToggle={() => setNavCollapsed(!navCollapsed)}
            collapsed={navCollapsed}
          />
          <WorkspaceRail
            view={view}
            onNavigate={(next) => {
              if (next === 'space' && workspace.spaces[0])
                openPage(spaceId || workspace.spaces[0].id);
              else setView(next);
            }}
          />
          <WorkspaceSidebar
            view={view}
            workspace={workspace}
            state={state}
            dot={dot}
            configured={configured}
            busy={busy}
            selectedThread={selectedThread}
            spaceId={spaceId}
            pageId={pageId}
            backendStatus={backendStatus}
            newConversation={() => void newConversation()}
            setDialog={setDialog}
            chooseDot={chooseDot}
            navigateDestination={navigateDestination}
            openPage={openPage}
            setView={setView}
            setSelectedDot={setSelectedDot}
            mutate={mutate}
            updateConversation={updateConversation}
            deleteConversation={deleteConversation}
            restoreConversation={restoreConversation}
          />
        </>
      )}
      <div className="workspace">
        {desktop && (
          <header className="companion-toolbar">
            <div className="companion-toolbar-row">
              <select
                aria-label="Choose your Dot"
                value={dot.id}
                onChange={(event) => {
                  const next = workspace.dots.find(
                    (item) => item.id === event.target.value,
                  );
                  if (next) chooseDot(next);
                }}
              >
                {workspace.dots.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              {view !== 'chat' && (
                <button className="text-button" onClick={() => setView('chat')}>
                  Back to chat
                </button>
              )}
              <button
                className="icon-button"
                aria-label="New conversation"
                title="New conversation"
                disabled={!configured || busy}
                onClick={() => {
                  navigateDestination({ dotId: dot.id });
                }}
              >
                <Plus size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="Settings and setup"
                title="Settings and setup"
                onClick={() => setDialog({ type: 'settings' })}
              >
                <Settings2 size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="Open full workspace"
                title="Open full workspace"
                onClick={() =>
                  void window.dotWorkspace
                    ?.openWorkspace({ dotId: dot.id, threadId: thread?.id })
                    .catch((e) => setError(e.message))
                }
              >
                <ArrowUpRight size={17} />
              </button>
            </div>
            <select
              className="companion-history"
              aria-label="Conversation history"
              value={thread?.id ?? ''}
              onChange={(event) => {
                navigateDestination({
                  dotId: dot.id,
                  threadId: event.target.value || undefined,
                });
              }}
            >
              <option value="">A new conversation</option>
              {workspace.conversations
                .filter((item) => item.dotId === dot.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
            </select>
          </header>
        )}
        <header className="topbar">
          <div className="breadcrumbs">
            <span>
              {view === 'space'
                ? workspace.spaces.find((space) => space.id === spaceId)?.name
                : view === 'chat'
                  ? 'Chats'
                  : 'Workspace'}
            </span>
            <span>/</span>
            <strong>
              {view === 'chat'
                ? thread?.title || 'New conversation'
                : view === 'tasks'
                  ? 'Activity'
                  : view === 'space'
                    ? 'Pages'
                    : view === 'settings'
                      ? 'Settings'
                      : 'Memory'}
            </strong>
          </div>
          <div className="top-actions">
            <span className="mode-badge">
              {configured ? 'LOCAL WORKSPACE' : 'SETUP REQUIRED'}
            </span>
            <button
              className="pause-button"
              aria-label={
                state.settings.paused ? 'Resume all Dots' : 'Pause all Dots'
              }
              onClick={() =>
                void mutate('/settings', 'PATCH', {
                  paused: !state.settings.paused,
                })
              }
            >
              {state.settings.paused ? <Play size={14} /> : <Pause size={14} />}
              <span>{state.settings.paused ? 'Resume' : 'Pause'}</span>
            </button>
            <button
              className="icon-button"
              aria-label={pane ? 'Hide computer' : 'Show computer'}
              aria-expanded={pane}
              onClick={() => setPane(!pane)}
            >
              <Monitor size={18} />
            </button>
          </div>
        </header>
        {backendStatus &&
          (backendStatus.phase !== 'ready' || backendStatus.warning) && (
            <div className="backend-notice" role="status">
              <span>{backendStatus.message}</span>
              <button
                onClick={() =>
                  void window.dotWorkspace
                    ?.retry()
                    .catch((e) => setError(e.message))
                }
              >
                Retry connection
              </button>
              <button
                onClick={() =>
                  void window.dotWorkspace
                    ?.openBackendSettings()
                    .catch((e) => setError(e.message))
                }
              >
                Workspace setup
              </button>
            </div>
          )}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setNotices((current) => dismissNotice(current))}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {state.settings.paused && (
          <div className="notice">
            All Dots are paused. Active compute stops and scheduled tasks wait.
          </div>
        )}
        {view === 'settings' ? (
          <WorkspaceDialog
            embedded
            dialog={{ type: 'settings' }}
            state={state}
            workspace={workspace}
            onClose={() => setView('chat')}
            mutate={mutate}
          />
        ) : view === 'space' && !workspace.spaces.length ? (
          <main className="large-empty">
            <BookOpen size={36} />
            <h1>A Space for your next idea</h1>
            <p>Bring pages, context and specialist Dots together.</p>
            <button
              className="primary"
              onClick={() => setDialog({ type: 'space' })}
            >
              <Plus size={16} />
              Create Space
            </button>
          </main>
        ) : view === 'space' ? (
          <SpaceWorkspace
            key={spaceId}
            space={
              workspace.spaces.find((s) => s.id === spaceId) ??
              workspace.spaces[0]
            }
            pageId={pageId}
            workspace={workspace}
            paused={state.settings.paused}
            onPage={(id) => openPage(spaceId, id)}
            onSettings={() => setDialog({ type: 'settings' })}
            onCreateDot={() => setDialog({ type: 'dot', spaceId })}
            onDirty={setDirtyPage}
            onRefresh={refresh}
            onSchedule={(threadId) => setDialog({ type: 'schedule', threadId })}
            onThread={(id) => {
              const target = workspace.conversations.find((t) => t.id === id);
              if (target) {
                navigateDestination({ dotId: target.dotId, threadId: id });
              }
            }}
          />
        ) : view === 'chat' ? (
          <div className={`chat-workspace ${pane ? 'split' : ''}`}>
            <div className="chat-column">
              {thread && configured ? (
                <Chat
                  key={thread.id}
                  companionColor={companionColor}
                  thread={thread}
                  savedMessagesKey={(workspace.deletedConversations ?? [])
                    .map((item) => item.id)
                    .sort()
                    .join(',')}
                  messageTarget={
                    messageTarget?.threadId === thread.id
                      ? messageTarget
                      : undefined
                  }
                  dot={dot}
                  initialPrompt={pendingPrompt}
                  onConsumed={() => setPendingPrompt(undefined)}
                  localMemory={
                    workspace.setup.conversationBackend === 'local' &&
                    workspace.setup.llmBackend === 'subscription'
                  }
                  voiceReady={
                    !desktop &&
                    localVoiceChecked &&
                    !localVoice.enabled &&
                    (localVoice.selectedQuality ?? 'medium') === 'medium' &&
                    workspace.setup.voice
                  }
                  localVoiceQuality={localVoice.selectedQuality ?? 'medium'}
                  localVoiceStatus={localVoice}
                  onVoiceSettingsSaved={refreshVoiceSettings}
                  onVoiceActive={voiceActive}
                  localVoiceReady={localVoice.ready}
                  localVoiceEnabled={localVoice.enabled}
                  localVoiceReason={localVoice.reason}
                  localVoicePending={!localVoiceResolved}
                  voiceIntent={voiceIntent}
                  onVoiceConsumed={consumeVoiceIntent}
                  calls={workspace.calls.filter(
                    (call) => call.threadId === thread.id,
                  )}
                  paused={state.settings.paused}
                  onSaved={refresh}
                  onComputer={() => setPane(true)}
                  onSchedule={() =>
                    setDialog({ type: 'schedule', threadId: thread.id })
                  }
                />
              ) : (
                <div className="new-conversation">
                  <FolderAccessSettings dotId={dot.id} />
                  {
                    <VoiceSettings
                      dotId={dot.id}
                      callActive={!!voiceIntent}
                      previewReady={
                        localVoice.modes?.medium.ready ?? localVoice.ready
                      }
                      status={localVoice}
                      onSaved={refreshVoiceSettings}
                      unavailableReason={localVoice.reason}
                    />
                  }
                  <div className="empty-chat-persona">
                    <Mascot
                      identity={dot.id}
                      companionColor={companionColor}
                      name={dot.name}
                      state={state.settings.paused ? 'paused' : 'idle'}
                    />
                    <h2>{dot.name}</h2>
                    <p>{dot.instructions}</p>
                    <button
                      className="text-button"
                      onClick={() =>
                        setDialog({ type: 'dot', dot, spaceId: dot.spaceId })
                      }
                    >
                      Edit specialist <MoreHorizontal size={14} />
                    </button>
                  </div>
                  {!configured && (
                    <div className="setup-card">
                      <span className="setup-icon">
                        <Settings2 size={20} />
                      </span>
                      <div>
                        <strong>Connect your Dot</strong>
                        <p>
                          Connect your model and conversation service in
                          Settings to start chatting. Your Spaces and Dot
                          preferences are ready to use.
                        </p>
                        <button
                          onClick={() =>
                            window.dotWorkspace
                              ? void window.dotWorkspace
                                  .openBackendSettings()
                                  .catch((e) => setError(e.message))
                              : setView('settings')
                          }
                        >
                          Workspace setup <ArrowUpRight size={12} />
                        </button>
                      </div>
                    </div>
                  )}
                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void newConversation(prompt);
                    }}
                  >
                    <textarea
                      aria-label="Start a conversation"
                      placeholder={
                        configured
                          ? `Message ${dot.name}…`
                          : 'Your first conversation starts after setup.'
                      }
                      value={prompt}
                      maxLength={4000}
                      onChange={(e) => setPrompt(e.target.value)}
                      onKeyDown={(e) =>
                        submitComposerOnEnter(
                          e,
                          configured && !busy && !!prompt.trim(),
                        )
                      }
                      disabled={!configured}
                    />
                    <div className="composer-bottom">
                      <span>
                        <MessageCircle size={14} />
                        Text and calls, one continuing conversation
                      </span>
                      <button
                        className="send-button"
                        aria-label="Start conversation"
                        disabled={!configured || busy || !prompt.trim()}
                      >
                        <ArrowUp size={19} />
                      </button>
                    </div>
                  </form>
                  <div className="starter-suggestions">
                    {[
                      'Help me think this through',
                      'Research a public page',
                      'Make a plan I can follow',
                    ].map((text) => (
                      <button
                        key={text}
                        disabled={!configured}
                        onClick={() => setPrompt(text)}
                      >
                        {text}
                        <ArrowUpRight size={12} />
                      </button>
                    ))}
                  </div>
                  <div className="connection-note">
                    <span
                      className={`online-dot ${workspace.setup.slack === 'online' ? '' : 'off'}`}
                    />
                    Slack · {workspace.setup.slack.replaceAll('_', ' ')}
                    <button
                      className="text-button"
                      onClick={() => setDialog({ type: 'settings' })}
                    >
                      Setup details
                    </button>
                  </div>
                </div>
              )}
            </div>
            {pane && (
              <ResultPane
                key={dot.id}
                dots={workspace.dots}
                defaultDotId={dot.id}
                latest={capture}
                dotState="idle"
                onClose={() => setPane(false)}
              />
            )}
          </div>
        ) : (
          <main className="main-content">
            <div className="page-heading">
              <div>
                <span className="eyebrow">YOUR WORKSPACE</span>
                <h1>{view === 'memories' ? 'Memories' : 'Activity'}</h1>
                <p>
                  {view === 'memories'
                    ? 'Preferences you choose to share with your Dots.'
                    : 'Scheduled turns run on the server in their original conversation.'}
                </p>
              </div>
              {view === 'memories' &&
                !(
                  workspace.setup.conversationBackend === 'local' &&
                  workspace.setup.llmBackend === 'subscription'
                ) && (
                  <button
                    className="primary"
                    onClick={() => setDialog({ type: 'memory' })}
                  >
                    <Plus size={15} />
                    Add memory
                  </button>
                )}
            </div>
            {view === 'memories' ? (
              workspace.setup.conversationBackend === 'local' &&
              workspace.setup.llmBackend === 'subscription' ? (
                <>
                  <MemoryPanel
                    dotId={dot.id}
                    dots={workspace.dots}
                    spaces={workspace.spaces}
                    onChanged={refresh}
                  />
                  <MemoryActivity
                    dotId={dot.id}
                    historicalThreads={workspace.conversations.filter(
                      (t) => t.dotId === dot.id,
                    )}
                  />
                </>
              ) : (
                <>
                  <div className="memory-grid">
                    {state.memories.map((memory) => (
                      <article className="memory-card" key={memory.id}>
                        <BookOpen size={18} />
                        <p>{memory.text}</p>
                        <div>
                          <small>
                            {state.settings.memoryAllowed
                              ? 'Available to permitted Dots'
                              : 'Memory use disabled'}
                          </small>
                          <button
                            className="icon-button"
                            aria-label="Edit memory"
                            onClick={() =>
                              setDialog({ type: 'memory', memory })
                            }
                          >
                            <MoreHorizontal size={17} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label="Delete memory"
                            onClick={() =>
                              void mutate(
                                `/memories/${memory.id}`,
                                'DELETE',
                                {},
                              )
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                  {!state.memories.length && (
                    <div className="large-empty">
                      <Mascot />
                      <h2>A little context goes a long way.</h2>
                      <p>
                        Add a preference like “Keep my research briefs short.”
                        You can change or remove it anytime.
                      </p>
                    </div>
                  )}
                </>
              )
            ) : (
              <>
                <label className="search-box">
                  <Search size={16} />
                  <input
                    aria-label="Search tasks"
                    placeholder="Find a task…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <div className="task-list">
                  {state.tasks
                    .filter((task) =>
                      task.prompt.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onClick={() =>
                          void api<Detail>(`/tasks/${task.id}`)
                            .then(setTaskDetail)
                            .catch((e) => setError(e.message))
                        }
                      />
                    ))}
                </div>
                {!state.tasks.length && (
                  <div className="large-empty">
                    <Clock3 size={32} />
                    <h2>Let a thought come back around.</h2>
                    <p>
                      Open a conversation and use the clock button to schedule a
                      server-side task.
                    </p>
                  </div>
                )}
                {taskDetail && (
                  <section className="task-detail-card">
                    <h2>{taskDetail.task.prompt}</h2>
                    <TaskActions
                      task={taskDetail.task}
                      busy={busy}
                      settings={state.settings}
                      onAction={(action) =>
                        void mutate(
                          `/tasks/${taskDetail.task.id}/actions`,
                          'POST',
                          { action },
                        )
                      }
                      onSchedule={async () => {
                        const raw = window.prompt(
                          'Repeat interval in minutes (0 removes the schedule)',
                          String((taskDetail.task.intervalSeconds ?? 0) / 60),
                        );
                        if (raw === null) return;
                        const value = Number(raw);
                        if (!Number.isFinite(value) || value < 0) {
                          setError('Enter a valid number of minutes.');
                          return;
                        }
                        await mutate(
                          `/tasks/${taskDetail.task.id}/schedule`,
                          'PUT',
                          {
                            intervalSeconds: value
                              ? Math.round(value * 60)
                              : null,
                          },
                        );
                      }}
                    />
                    {taskDetail.task.error && (
                      <p className="chat-error">{taskDetail.task.error}</p>
                    )}
                    {taskDetail.events.slice(-6).map((event) => (
                      <p className="muted" key={event.id}>
                        {event.text}
                      </p>
                    ))}
                    <small>{taskDetail.runs.length} saved runs</small>
                  </section>
                )}
              </>
            )}
          </main>
        )}
        {pane && view !== 'chat' && (
          <div className="computer-overlay">
            <ResultPane
              key={view === 'space' ? spaceId : dot.id}
              dots={workspace.dots}
              defaultDotId={
                view === 'space'
                  ? (workspace.dots.find((candidate) =>
                      candidate.spaceIds.includes(spaceId),
                    )?.id ?? dot.id)
                  : dot.id
              }
              dotState="idle"
              onClose={() => setPane(false)}
            />
          </div>
        )}
      </div>
      {quickOpen && (
        <QuickNavigation
          workspace={workspace}
          onClose={() => setQuickOpen(false)}
          onChoose={(item) => {
            const accepted = item.destination
              ? navigateDestination(item.destination)
              : setView(item.view);
            if (accepted) setQuickOpen(false);
          }}
        />
      )}
      {dialog && (
        <WorkspaceDialog
          dialog={dialog}
          voiceStatus={
            dialog.type === 'dot' && dialog.dot?.id === dot?.id
              ? localVoice
              : undefined
          }
          voiceActive={
            dialog.type === 'dot' && dialog.dot?.id === activeVoiceDot
          }
          onVoiceSettingsSaved={refreshVoiceSettings}
          state={state}
          workspace={workspace}
          onClose={() => setDialog(undefined)}
          mutate={mutate}
        />
      )}
    </div>
  );
  return configured ? (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" headers={authHeaders()}>
      {content}
    </CopilotKitProvider>
  ) : (
    content
  );
}
