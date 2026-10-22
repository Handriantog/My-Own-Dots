import { ownerOutcomeSchema } from '../shared/abilities/protocol';
import {
  AbilityToolCard,
  RecentAbilityResults,
} from './abilities/AbilityResultCard';
import { MemoryActivity, type MemoryActivityHandle } from './MemoryActivity';
import { SavedMessages } from './SavedMessages';
import { useMessageMarks } from './useMessageMarks';
import { openPageLink } from './page-navigation';
import type { MessageMark, MessageMarkKind } from '../shared/message-marks';
import { parseMemoryCommand } from '../shared/memory-commands';
import { PageReviewCard } from './PageReviewCard';
import { pageReviewSchema, pageReviewTool } from '../shared/page-review';
import {
  connectionActionSchema,
  connectionActionTool,
} from '../shared/connection-types';
import { ConnectionActionCard } from './ConnectionActionCard';
import {
  folderApprovalSchema,
  folderApprovalTool,
} from '../shared/folder-access';
import { FolderAccessCard } from './FolderAccessCard';
import { FolderAccessSettings } from './FolderAccessSettings';
import { contextualMessage, type PageContext } from './page-context';
import { api } from './api';
import type { Page } from '../server/pages';
import { useEffect, useId, useRef, useState } from 'react';
import { CopilotKitCoreErrorCode } from '@copilotkit/core';
import {
  CopilotChatToolCallsView,
  useRenderTool,
  useHumanInTheLoop,
  useAgent,
  useCopilotKit,
} from '@copilotkit/react-core/v2';
import {
  FilePlus,
  Bookmark,
  ArrowUp,
  Clock3,
  Link2,
  Phone,
  PhoneOff,
  Square,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  ComputerToolCard,
  type ComputerToolRenderProps,
} from './ComputerToolCard';
import { ChatTranscript, isInternalVoiceReceipt } from './ChatTranscript';
import type { CallReceipt, Conversation, Dot } from '../shared/types';
import { Mascot } from './Mascot';
import { useVoice } from './useVoice';
import { useLocalVoice } from './local-voice/useLocalVoice';
import {
  VoiceSettings,
  type VoiceSettingsHandle,
} from './local-voice/VoiceSettings';
import { CallView } from './CallView';
import { shouldSubmitComposerOnKeyDown } from './chat-composer';

export function Chat({
  companionColor,
  thread,
  dot,
  initialPrompt,
  onConsumed,
  voiceReady,
  localVoiceReady = false,
  localVoiceEnabled = false,
  localVoiceReason,
  localVoicePending = false,
  localVoiceQuality = 'medium',
  localVoiceStatus,
  onVoiceSettingsSaved,
  onVoiceActive,
  voiceIntent = 0,
  onVoiceConsumed,
  localMemory = false,
  calls,
  paused,
  onSaved,
  onSchedule,
  onComputer,
  messageTarget,
  savedMessagesKey,
}: {
  companionColor?: string;
  thread: Conversation;
  dot: Dot;
  initialPrompt?: string;
  onConsumed: () => void;
  voiceReady: boolean;
  localVoiceReady?: boolean;
  localVoiceEnabled?: boolean;
  localVoiceReason?: string;
  localVoicePending?: boolean;
  localVoiceQuality?: import('../shared/voice-settings').VoiceQuality;
  localVoiceStatus?: import('../shared/local-voice').LocalVoiceStatus;
  onVoiceSettingsSaved?: () => void;
  onVoiceActive?: (dotId: string, active: boolean) => void;
  voiceIntent?: number;
  onVoiceConsumed?: () => void;
  localMemory?: boolean;
  calls: CallReceipt[];
  paused: boolean;
  onSaved: () => void;
  onSchedule: () => void;
  onComputer?: () => void;
  messageTarget?: { messageId: string };
  savedMessagesKey?: string;
}) {
  const { agent, isReady } = useAgent({
    agentId: `chat-${thread.id}`,
    runtimeAgentId: dot.id,
    threadId: thread.id,
  });
  const { copilotkit } = useCopilotKit();
  const saved = useMessageMarks(thread.id, savedMessagesKey);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedKind, setSavedKind] = useState<MessageMarkKind>('pin');
  const [highlightedMessageId, setHighlightedMessageId] = useState<string>();
  const [jumpError, setJumpError] = useState('');
  const [jumpRequest, setJumpRequest] = useState<{ messageId: string }>();
  const savedTrigger = useRef<HTMLButtonElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const appliedTarget = useRef<typeof messageTarget>(undefined);
  const jumpToMessage = (id: string) => {
    setJumpError('');
    setSavedOpen(false);
    setJumpRequest({ messageId: id });
  };
  const closeSaved = () => {
    setSavedOpen(false);
    savedTrigger.current?.focus();
  };
  const openSavedMessage = (mark: MessageMark) => {
    if (mark.threadId === thread.id) jumpToMessage(mark.messageId);
    else
      openPageLink(
        `#/chat/${encodeURIComponent(mark.dotId)}/${encodeURIComponent(mark.threadId)}?message=${encodeURIComponent(mark.messageId)}`,
      );
  };
  const [pageContext, setPageContext] = useState<PageContext | null>();
  const [contextError, setContextError] = useState('');
  const [contextAttempt, setContextAttempt] = useState(0);
  const contextReady = pageContext !== undefined;
  useEffect(() => {
    let active = true;
    setPageContext(undefined);
    setContextError('');
    void api<PageContext | null>(
      `/conversations/${thread.id}/page-context`,
      'GET',
      undefined,
      AbortSignal.timeout(10000),
    )
      .then((page) => {
        if (active) setPageContext(page);
      })
      .catch(() => {
        if (active)
          setContextError(
            'Conversation context could not load. Retry before sending your message.',
          );
      });
    return () => {
      active = false;
    };
  }, [thread.id, contextAttempt]);
  const memoryActivity = useRef<MemoryActivityHandle>(null);
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsId = useId();
  const [error, setError] = useState('');
  const [runError, setRunError] = useState('');
  const chatError = error || runError;
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const voiceSettings = useRef<VoiceSettingsHandle>(null);
  const voiceRun = useRef<
    | { messageId: string; done?: Promise<unknown>; cancelled: boolean }
    | undefined
  >(undefined);
  const paidVoice = useVoice(thread.id, onSaved, agent.messages.at(-1)?.id);
  const localVoice = useLocalVoice({
    threadId: thread.id,
    dotId: dot.id,
    quality: localVoiceQuality,
    onSaved,
    onCanonicalSaved: async () => {
      await copilotkit.connectAgent({ agent });
    },
    onTranscript: ({ messageId, text }) => send(text, messageId),
    onCancelTranscript: async (messageId) => {
      const current = voiceRun.current;
      if (!current || current.messageId !== messageId) return;
      current.cancelled = true;
      copilotkit.stopAgent({ agent });
      await current.done?.catch(() => {});
    },
  });
  useEffect(() => {
    onVoiceActive?.(dot.id, localVoice.status !== 'idle');
    return () => onVoiceActive?.(dot.id, false);
  }, [dot.id, localVoice.status, onVoiceActive]);
  const [talkError, setTalkError] = useState('');
  const [completedIntent, setCompletedIntent] = useState(0);
  const consumedIntent = useRef(0);
  const requestedIntent = useRef(0);
  const currentIntent = useRef(voiceIntent);
  currentIntent.current = voiceIntent;
  const talkMounted = useRef(true);
  useEffect(() => {
    talkMounted.current = true;
    return () => {
      talkMounted.current = false;
    };
  }, []);
  const waitingForTalk =
    !!voiceIntent &&
    completedIntent !== voiceIntent &&
    localVoice.status === 'idle';
  const consumeTalk = () => {
    consumedIntent.current = voiceIntent;
    setCompletedIntent(voiceIntent);
    onVoiceConsumed?.();
  };
  const transport =
    localVoiceEnabled ||
    localVoiceReady ||
    localVoiceQuality !== 'medium' ||
    localVoice.status !== 'idle'
      ? localVoice
      : paidVoice;
  const voice = waitingForTalk
    ? {
        ...localVoice,
        status: 'connecting' as const,
        phase: 'listening' as const,
        error: '',
        caption: 'Preparing your conversation…',
        end: async () => {
          consumeTalk();
        },
      }
    : transport;
  const canCall = localVoiceReady || voiceReady;
  const voiceMessages = useRef(new Set<string>());
  const sent = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      voiceIntent &&
      consumedIntent.current !== voiceIntent &&
      localVoice.status !== 'idle' &&
      localVoice.status !== 'ending'
    )
      consumeTalk();
  }, [voiceIntent, localVoice.status]);
  useEffect(() => {
    if (!waitingForTalk) return;
    const start = () => {
      if (
        requestedIntent.current !== voiceIntent ||
        consumedIntent.current === voiceIntent
      )
        return;
      voiceSettings.current?.stopPreview();
      consumeTalk();
      void localVoice.start();
    };
    window.addEventListener?.('dot-voice-start', start);
    return () => window.removeEventListener?.('dot-voice-start', start);
  }, [waitingForTalk, voiceIntent, localVoice.start]);
  useEffect(() => {
    if (!waitingForTalk || consumedIntent.current === voiceIntent) return;
    const current = () =>
      talkMounted.current &&
      currentIntent.current === voiceIntent &&
      consumedIntent.current !== voiceIntent;
    const fail = (reason: string) => {
      if (!current()) return;
      setTalkError(reason);
      window.dotVoice?.reportError?.(reason);
      consumeTalk();
    };
    if (paused) return fail('Resume your Dot before starting a call.');
    if (!localVoicePending && !localVoiceReady)
      return fail(
        localVoiceReason ||
          'Local voice is not configured. Complete local voice setup, then choose Talk again.',
      );
    if (contextError || error) return fail(contextError || error);
    if (!localVoiceReady || !loaded || !contextReady || running) return;
    if (requestedIntent.current === voiceIntent) return;
    requestedIntent.current = voiceIntent;
    setTalkError('');
    if (!window.dotVoice)
      return fail('Reopen Talk from your desktop Dot to start the call.');
    const bridge = window.dotVoice;
    // Child effects can run before App publishes cold readiness to the host.
    // Register it before consuming the native Talk gesture.
    void bridge
      .setReady(true)
      .then(() => {
        if (current()) return bridge.activate();
      })
      .catch((cause) =>
        fail(
          cause instanceof Error
            ? cause.message
            : 'Could not start the call. Choose Talk again.',
        ),
      );
  }, [
    waitingForTalk,
    voiceIntent,
    paused,
    localVoicePending,
    localVoiceReady,
    localVoiceReason,
    loaded,
    contextReady,
    running,
    contextError,
    error,
  ]);
  useEffect(() => {
    if (!waitingForTalk) return;
    const timeout = setTimeout(() => {
      if (consumedIntent.current === voiceIntent) return;
      setTalkError(
        'The conversation took too long to connect. Choose Talk to try again.',
      );
      window.dotVoice?.reportError?.(
        'The conversation took too long to connect. Choose Talk to try again.',
      );
      consumeTalk();
    }, 30000);
    return () => clearTimeout(timeout);
  }, [waitingForTalk, voiceIntent]);
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error, code }) => {
        if (voiceRun.current?.cancelled) return;
        if (
          code === CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT ||
          code === CopilotKitCoreErrorCode.AGENT_RUN_FAILED_EVENT ||
          code === CopilotKitCoreErrorCode.AGENT_RUN_FAILED ||
          code === CopilotKitCoreErrorCode.AGENT_THREAD_LOCKED
        )
          setRunError(error.message);
        else setError(error.message);
      },
    });
    const events = agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        if (!voiceRun.current?.cancelled) setRunError(event.message);
      },
      onRunFinishedEvent: ({ outcome }) => {
        if (outcome === 'success') setRunError('');
      },
    });
    return () => {
      subscription.unsubscribe();
      events.unsubscribe();
    };
  }, [agent, copilotkit]);
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    void copilotkit
      .connectAgent({ agent })
      .then(() => {
        if (active) setLoaded(true);
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error ? e.message : 'Conversation could not connect.',
          );
      });
    return () => {
      active = false;
    };
  }, [agent, copilotkit, isReady]);
  const send = async (text: string, voiceMessageId?: string) => {
    if (voiceMessageId && voiceMessages.current.has(voiceMessageId)) return;
    // The transport waits for the previous voice promise; React may not have
    // committed its idle render yet when the next final transcript arrives.
    const busy = voiceMessageId ? !!voiceRun.current : running;
    if (!text.trim() || busy || !loaded || !contextReady || paused) {
      if (voiceMessageId)
        throw new Error('The conversation is not ready for a voice message.');
      return;
    }
    if (!voiceMessageId && voice.status !== 'idle') return;
    setError('');
    setRunError('');
    const command =
      localMemory && !voiceMessageId ? parseMemoryCommand(text) : null;
    if (command) {
      setSettingsOpen(true);
      setRunning(true);
      try {
        if (!memoryActivity.current)
          throw new Error('Memory controls are loading.');
        await memoryActivity.current.execute(command);
        setDraft('');
      } catch (cause) {
        setDraft(text);
        setError(
          cause instanceof Error ? cause.message : 'Memory command failed.',
        );
      } finally {
        setRunning(false);
      }
      return;
    }
    setRunning(true);
    if (voiceMessageId) voiceMessages.current.add(voiceMessageId);
    agent.addMessage({
      id:
        voiceMessageId ??
        crypto.randomUUID?.() ??
        `${Date.now()}-${Math.random()}`,
      role: 'user',
      content: contextualMessage(text, pageContext),
    });
    if (!voiceMessageId) {
      setDraft('');
      setSource('');
      setSourceOpen(false);
    }
    try {
      const current = voiceMessageId
        ? {
            messageId: voiceMessageId,
            done: undefined as Promise<unknown> | undefined,
            cancelled: false,
          }
        : undefined;
      if (current) voiceRun.current = current;
      const pending = copilotkit.runAgent({ agent });
      if (current) current.done = pending;
      const result = await pending;
      if (current?.cancelled) return;
      if (!result.newMessages.some((message) => message.role === 'assistant'))
        throw new Error(
          'The current turn returned no response. Check the runtime connection and retry.',
        );
      onSaved();
    } catch (e) {
      if (voiceMessageId && voiceRun.current?.cancelled) return;
      setRunError(
        e instanceof Error
          ? e.message
          : 'The turn failed. Your conversation remains saved.',
      );
      if (voiceMessageId) throw e;
    } finally {
      if (voiceRun.current?.messageId === voiceMessageId)
        voiceRun.current = undefined;
      setRunning(false);
    }
  };
  useEffect(() => {
    if (loaded && contextReady && !paused && initialPrompt && !sent.current) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [loaded, contextReady, paused, initialPrompt]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [agent.messages.length, running]);
  useEffect(() => {
    if (!loaded || !messageTarget || appliedTarget.current === messageTarget)
      return;
    appliedTarget.current = messageTarget;
    jumpToMessage(messageTarget.messageId);
  }, [loaded, messageTarget, agent.messages.length]);
  useEffect(() => {
    if (!jumpRequest) return;
    const element = Array.from(
      transcript.current?.querySelectorAll<HTMLElement>('.chat-entry') ?? [],
    ).find((entry) => entry.id === `chat-message-${jumpRequest.messageId}`);
    if (!element) {
      setJumpError(
        'The original message is no longer in this conversation. Its saved text is still available.',
      );
      savedTrigger.current?.focus();
      return;
    }
    setHighlightedMessageId(jumpRequest.messageId);
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    element.focus({ preventScroll: true });
  }, [jumpRequest]);
  useEffect(() => {
    if (!highlightedMessageId) return;
    const timer = setTimeout(() => setHighlightedMessageId(undefined), 3000);
    return () => clearTimeout(timer);
  }, [highlightedMessageId]);
  useEffect(() => {
    if (paused && voice.status !== 'idle') void voice.end();
  }, [paused]);
  useHumanInTheLoop(
    {
      name: pageReviewTool.name,
      description: pageReviewTool.description,
      parameters: pageReviewSchema,
      render: (props) => (
        <PageReviewCard {...props} threadId={thread.id} onSaved={onSaved} />
      ),
    },
    [thread.id, onSaved],
  );
  useHumanInTheLoop(
    {
      name: connectionActionTool.name,
      description: connectionActionTool.description,
      parameters: connectionActionSchema,
      render: (props) => (
        <ConnectionActionCard {...props} threadId={thread.id} />
      ),
    },
    [thread.id],
  );
  const folderPickerAvailable = !!window.dotFolders;
  useHumanInTheLoop(
    {
      name: folderApprovalTool.name,
      description: folderApprovalTool.description,
      parameters: folderApprovalSchema,
      available: folderPickerAvailable,
      render: (props) => <FolderAccessCard {...props} threadId={thread.id} />,
    },
    [thread.id, folderPickerAvailable],
  );
  const computerCalls = agent.messages.flatMap((message) =>
    message.role === 'assistant' ? (message.toolCalls ?? []) : [],
  );
  const latestBrowserCall = computerCalls.findLast((call) =>
    [
      'navigate',
      'snapshot',
      'read',
      'screenshot',
      'click',
      'type',
      'key',
      'scroll',
    ].some((action) => call.function.name === `computer_${action}`),
  );
  useRenderTool(
    {
      name: '*',
      render: (props: ComputerToolRenderProps) =>
        props.name.startsWith('computer_') ? (
          <ComputerToolCard
            {...props}
            dotId={dot.id}
            dotName={dot.name}
            running={running}
            showScreen={props.toolCallId === latestBrowserCall?.id}
            onExpand={onComputer}
          />
        ) : props.name.startsWith('ability_') ? (
          <AbilityToolCard
            dotId={dot.id}
            status={props.status}
            result={props.result}
            onSelect={(selectionRef) =>
              send(
                `Use my selected item for the previous Ability request. Selection reference: ${selectionRef}`,
              )
            }
          />
        ) : null,
    },
    [dot.id, dot.name, running, latestBrowserCall?.id, onComputer],
  );
  const abilityHandles = new Set(
    agent.messages.flatMap((message) => {
      if (message.role !== 'tool' || typeof message.content !== 'string')
        return [];
      try {
        const result = ownerOutcomeSchema.safeParse(
          JSON.parse(message.content),
        );
        return result.success && result.data.resultRef
          ? [result.data.resultRef]
          : [];
      } catch {
        return [];
      }
    }),
  );
  const visible = agent.messages.filter(
    (message) =>
      !isInternalVoiceReceipt(message) &&
      ['user', 'assistant'].includes(message.role) &&
      ((typeof message.content === 'string' && message.content.trim()) ||
        (message.role === 'assistant' &&
          message.toolCalls?.some(
            (call) =>
              call.function.name.startsWith('computer_') ||
              call.function.name.startsWith('ability_') ||
              call.function.name === 'COMPOSIO_MANAGE_CONNECTIONS' ||
              call.function.name === pageReviewTool.name ||
              call.function.name === connectionActionTool.name ||
              call.function.name === folderApprovalTool.name,
          ))),
  );
  return (
    <div className="live-chat">
      <header className="chat-persona">
        <Mascot
          identity={dot.id}
          companionColor={companionColor}
          name={dot.name}
          small
          state={running ? 'working' : paused ? 'paused' : 'idle'}
        />
        <div>
          <strong title={dot.name}>{dot.name}</strong>
          <span>
            {paused
              ? 'Paused'
              : running
                ? 'Thinking…'
                : loaded && contextReady
                  ? 'Here with you'
                  : 'Connecting to your conversation…'}
          </span>
        </div>
        <div className="chat-persona-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Saved messages"
            ref={savedTrigger}
            title="Pins and bookmarks"
            aria-expanded={savedOpen}
            onClick={() => {
              if (!savedOpen) saved.refresh();
              setSavedOpen((open) => !open);
            }}
          >
            <Bookmark size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Conversation settings"
            title="Conversation settings"
            aria-expanded={settingsOpen}
            aria-controls={settingsId}
            onClick={() => {
              if (settingsOpen) voiceSettings.current?.stopPreview();
              setSettingsOpen((open) => !open);
            }}
          >
            <SlidersHorizontal size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Save conversation as page"
            disabled={running}
            onClick={async () => {
              const title = window.prompt('Page title', thread.title);
              if (!title) return;
              try {
                const page = await api<Page>(
                  `/conversations/${thread.id}/page`,
                  'POST',
                  { title },
                );
                location.hash = `/spaces/${page.spaceId}/pages/${page.id}`;
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : 'Could not save conversation.',
                );
              }
            }}
          >
            <FilePlus size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Schedule a task in this conversation"
            onClick={onSchedule}
          >
            <Clock3 size={18} />
          </button>
          <button
            className={`icon-button ${voice.status === 'active' ? 'on-call' : ''}`}
            aria-label={
              voice.status === 'idle' ? 'Start voice call' : 'End voice call'
            }
            title={
              canCall
                ? 'Talk with your Dot'
                : localVoiceReason ||
                  'Voice setup requires VOICE_API_KEY and VOICE_MODEL'
            }
            disabled={
              voice.status === 'idle' &&
              (!canCall || paused || !loaded || !contextReady || running)
            }
            onClick={() => {
              if (voice.status === 'idle') {
                voiceSettings.current?.stopPreview();
                void voice.start();
              } else void voice.end();
            }}
          >
            {voice.status === 'idle' ? (
              <Phone size={18} />
            ) : (
              <PhoneOff size={18} />
            )}
          </button>
        </div>
      </header>
      <div id={settingsId} className="chat-settings" hidden={!settingsOpen}>
        <FolderAccessSettings dotId={dot.id} />
        <VoiceSettings
          ref={voiceSettings}
          dotId={dot.id}
          callActive={voice.status !== 'idle'}
          previewReady={
            localVoiceStatus?.modes?.medium.ready ?? localVoiceReady
          }
          status={localVoiceStatus}
          onSaved={onVoiceSettingsSaved}
          unavailableReason={localVoiceReason}
        />
        {localMemory && (
          <MemoryActivity
            ref={memoryActivity}
            dotId={dot.id}
            threadId={thread.id}
          />
        )}
      </div>
      {pageContext && (
        <div className="page-chat-context">
          Working on{' '}
          <a href={`/#/spaces/${pageContext.spaceId}/pages/${pageContext.id}`}>
            {pageContext.title}
          </a>
        </div>
      )}
      <div
        className="chat-body"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && savedOpen) {
            event.stopPropagation();
            closeSaved();
          }
        }}
      >
        <div className="chat-transcript" ref={transcript} inert={savedOpen}>
          <VoiceTasks
            threadId={thread.id}
            onUpdated={() => {
              onSaved();
              if (!running)
                void copilotkit.connectAgent({ agent }).catch(() => {});
            }}
          />
          {!visible.length && (
            <div className="chat-welcome">
              <span className="eyebrow">A LITTLE SPACE TO THINK</span>
              <h1>What’s on your mind?</h1>
              <p>{dot.instructions}</p>
              <p className="muted">
                Your conversation stays with this Dot, across text and calls.
              </p>
            </div>
          )}
          <ChatTranscript
            messages={visible}
            dotId={dot.id}
            dotName={dot.name}
            marks={saved.marks.filter((mark) => mark.threadId === thread.id)}
            marksDisabled={saved.loading || saved.saving || running || !loaded}
            onMark={(id, kind, active) => {
              void saved.update(thread.id, id, kind, active);
            }}
            highlightedMessageId={highlightedMessageId}
            calls={calls}
            renderTools={(message) => (
              <CopilotChatToolCallsView
                message={message}
                messages={agent.messages}
              />
            )}
          />
          <RecentAbilityResults
            dotId={dot.id}
            threadId={thread.id}
            hiddenHandles={abilityHandles}
            onSelect={(selectionRef) =>
              send(
                `Use my selected item for the previous Ability request. Selection reference: ${selectionRef}`,
              )
            }
          />
          {running && (
            <div className="thinking">
              <span />
              <span />
              <span />
              <span>{dot.name} is thinking</span>
            </div>
          )}
          <div ref={bottom} />
        </div>
        {savedOpen && (
          <SavedMessages
            threadId={thread.id}
            marks={saved.marks}
            kind={savedKind}
            onKind={setSavedKind}
            onClose={closeSaved}
            onOpen={openSavedMessage}
            onRemove={(mark, kind) => {
              void saved.update(mark.threadId, mark.messageId, kind, false);
            }}
            busy={saved.loading || saved.saving}
            loading={saved.loading}
          />
        )}
      </div>
      {(saved.error || jumpError) && (
        <div className="chat-error" role="alert">
          {saved.error || jumpError}
          {saved.error && <button onClick={saved.refresh}>Retry</button>}
          {jumpError && (
            <button onClick={() => setJumpError('')}>Dismiss</button>
          )}
        </div>
      )}
      {contextError && (
        <div className="chat-error" role="alert">
          {contextError}
          <button onClick={() => setContextAttempt((value) => value + 1)}>
            Retry context
          </button>
        </div>
      )}
      {(chatError || voice.error) && (
        <div className="chat-error" role="alert">
          {chatError || voice.error}
          {chatError && (
            <button
              onClick={() => {
                setError('');
                setRunError('');
                void copilotkit
                  .connectAgent({ agent })
                  .then(() => setLoaded(true))
                  .catch((e) => setError(e.message));
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      <CallView
        key={voice.status === 'idle' ? 'idle' : 'call'}
        dot={dot}
        voice={voice}
        companionColor={companionColor}
      />
      {talkError && (
        <p className="chat-error" role="alert">
          {talkError}
        </p>
      )}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(`${source ? `From ${source}:\n\n` : ''}${draft}`);
        }}
      >
        {sourceOpen && (
          <div className="source-input">
            <Link2 size={15} />
            <input
              aria-label="Source page URL"
              type="url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://example.com/page"
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Remove source"
              onClick={() => {
                setSourceOpen(false);
                setSource('');
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="chat-compose-row">
          <button
            type="button"
            className="icon-button"
            aria-label="Add source page link"
            onClick={() => setSourceOpen(!sourceOpen)}
          >
            <Link2 size={19} />
          </button>
          <textarea
            aria-label="Message your Dot"
            placeholder={`Message ${dot.name}…`}
            rows={1}
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (shouldSubmitComposerOnKeyDown(e)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {running ? (
            <button
              type="button"
              className="send-button"
              aria-label="Stop response"
              onClick={() =>
                localVoice.status !== 'idle'
                  ? void localVoice.interrupt()
                  : copilotkit.stopAgent({ agent })
              }
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="Send message"
              disabled={
                !draft.trim() ||
                !loaded ||
                !contextReady ||
                paused ||
                voice.status !== 'idle'
              }
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
        <div className="chat-compose-note">
          Enter to send · Shift + Enter for a new line
        </div>
      </form>
    </div>
  );
}
import { VoiceTasks } from './local-voice/VoiceTasks';
