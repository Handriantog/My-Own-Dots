import { Mascot } from './Mascot';
import { openPageLink } from './page-navigation';
import { Fragment, type ReactNode } from 'react';
import type { VoiceTaskState } from './local-voice/VoiceTasks';
import { VoiceTaskList } from './local-voice/VoiceTaskList';
import { PhoneOff, Pin, Bookmark } from 'lucide-react';
import type { MessageMark, MessageMarkKind } from '../shared/message-marks';
import ReactMarkdown from 'react-markdown';
import type { AssistantMessage, Message } from '@ag-ui/core';
import type { CallReceipt } from '../shared/types';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt';
import { isScheduledTaskMessage } from '../shared/scheduled-message';
// These markers only control rendering; they do not confer trust or permissions.
export function isInternalVoiceReceipt(message: Message): boolean {
  const metadata = message.metadata;
  return (
    message.role === 'user' &&
    (message.id.startsWith(voiceReceiptMessagePrefix) ||
      (!!metadata &&
        typeof metadata === 'object' &&
        'opendotsSource' in metadata &&
        metadata.opendotsSource === 'voice_receipt'))
  );
}
/** Reveal the original article before scrolling a saved-message destination. */
export function revealChatMessage(element: HTMLElement) {
  let ancestor = element.parentElement;
  while (ancestor) {
    if (ancestor.tagName === 'DETAILS')
      (ancestor as HTMLDetailsElement).open = true;
    ancestor = ancestor.parentElement;
  }
  element.scrollIntoView({ block: 'center', behavior: 'instant' });
  element.focus({ preventScroll: true });
}
function Receipt({ call }: { call: CallReceipt }) {
  return (
    <div className="call-receipt">
      <PhoneOff size={13} />
      <time dateTime={new Date(call.startedAt).toISOString()}>
        {new Date(call.startedAt).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        })}
      </time>
      <span>
        {call.status === 'failed'
          ? 'Call failed'
          : call.endedAt
            ? `${Math.round((call.endedAt - call.startedAt) / 1000)}s · Call ended`
            : 'Call in progress'}
      </span>
      {call.error && <small>{call.error}</small>}
    </div>
  );
}
export function ChatTranscript({
  messages,
  calls,
  renderTools,
  dotName = 'Dot',
  dotId,
  marks = [],
  onMark,
  marksDisabled = false,
  highlightedMessageId,
  tasks,
}: {
  tasks?: VoiceTaskState;
  messages: Message[];
  calls: CallReceipt[];
  dotName?: string;
  dotId?: string;
  marks?: MessageMark[];
  onMark?: (messageId: string, kind: MessageMarkKind, active: boolean) => void;
  marksDisabled?: boolean;
  highlightedMessageId?: string;
  renderTools?: (message: AssistantMessage) => ReactNode;
}) {
  const ids = new Set(messages.map((message) => message.id));
  const marksById = new Map(marks.map((mark) => [mark.messageId, mark]));
  const grouped = calls
    .filter((call) => call.messageIds !== undefined)
    .sort((a, b) => a.startedAt - b.startedAt);
  const owner = new Map<string, string>();
  for (const call of grouped)
    for (const id of call.messageIds ?? [])
      if (!owner.has(id)) owner.set(id, call.id);
  const renderMessage = (
    message: Message,
    index: number,
    sequence: Message[],
  ) => {
    const previous = sequence[index - 1];
    const continued =
      previous?.role === message.role &&
      !calls.some((call) => call.anchorMessageId === previous.id);
    const sender = message.role === 'user' ? 'You' : dotName;
    const mark = marksById.get(message.id);
    const pinned = mark?.pinnedAt != null;
    const bookmarked = mark?.bookmarkedAt != null;
    return (
      <Fragment key={message.id}>
        <article
          className={`chat-entry ${message.role}${continued ? ' continued' : ''}${highlightedMessageId === message.id ? ' highlighted' : ''}`}
          id={`chat-message-${message.id}`}
          tabIndex={-1}
          aria-label={
            message.role === 'user' ? 'Your message' : `${sender}'s message`
          }
        >
          {onMark &&
            typeof message.content === 'string' &&
            message.content.trim() && (
              <div
                className="chat-message-actions"
                role="group"
                aria-label="Message actions"
              >
                <button
                  type="button"
                  disabled={marksDisabled}
                  aria-label={pinned ? 'Unpin message' : 'Pin message'}
                  title={pinned ? 'Unpin message' : 'Pin message'}
                  aria-pressed={pinned}
                  onClick={() => onMark(message.id, 'pin', !pinned)}
                >
                  <Pin size={14} />
                </button>
                <button
                  type="button"
                  disabled={marksDisabled}
                  aria-label={
                    bookmarked ? 'Remove bookmark' : 'Bookmark message'
                  }
                  title={bookmarked ? 'Remove bookmark' : 'Bookmark message'}
                  aria-pressed={bookmarked}
                  onClick={() => onMark(message.id, 'bookmark', !bookmarked)}
                >
                  <Bookmark size={14} />
                </button>
              </div>
            )}
          {!continued && (
            <>
              <span className="chat-avatar" aria-hidden="true">
                {message.role === 'assistant' ? (
                  <Mascot identity={dotId} name={dotName} small decorative />
                ) : (
                  Array.from(sender)[0]
                )}
              </span>
              <div className="chat-message-heading">
                <strong>{sender}</strong>
                {message.role === 'assistant' && <span>DOT</span>}
              </div>
            </>
          )}
          <div className="chat-message-content">
            {(pinned || bookmarked) && (
              <div className="chat-message-marks">
                {pinned && (
                  <span>
                    <Pin size={11} /> Pinned
                  </span>
                )}
                {bookmarked && (
                  <span>
                    <Bookmark size={11} /> Bookmarked
                  </span>
                )}
              </div>
            )}
            {typeof message.content === 'string' && message.content.trim() && (
              <div
                className={`chat-bubble ${message.role}${isScheduledTaskMessage(message) ? ' scheduled' : ''}`}
              >
                {isScheduledTaskMessage(message) && (
                  <span className="scheduled-message-label">Scheduled</span>
                )}
                <ReactMarkdown
                  components={{
                    img: ({ alt }) => <span>{alt}</span>,
                    a: ({ href, children }) => (
                      <a
                        onClick={(event) => {
                          if (href?.startsWith('/#/spaces/')) {
                            event.preventDefault();
                            openPageLink(href);
                          }
                        }}
                        href={href}
                        target={
                          href?.startsWith('/#/spaces/') ? undefined : '_blank'
                        }
                        rel="noreferrer"
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {String(message.content)}
                </ReactMarkdown>
              </div>
            )}
            {message.role === 'assistant' && renderTools?.(message)}
          </div>
        </article>
        {calls
          .filter(
            (call) =>
              call.messageIds === undefined &&
              call.anchorMessageId === message.id,
          )
          .map((call) => (
            <Receipt key={call.id} call={call} />
          ))}
      </Fragment>
    );
  };
  const buckets = new Map<number, CallReceipt[]>();
  for (const call of grouped) {
    const first = messages.findIndex(
      (message) => owner.get(message.id) === call.id,
    );
    const anchor = messages.findIndex(
      (message) => message.id === call.afterMessageId,
    );
    // A caption can be mirrored after an earlier typed response completes.
    // Keep the card at the host's call-start position as that caption arrives.
    const position =
      call.afterMessageId === null
        ? 0
        : anchor >= 0
          ? anchor + 1
          : first >= 0
            ? first
            : 0;
    buckets.set(position, [...(buckets.get(position) ?? []), call]);
  }
  const renderCall = (call: CallReceipt) => {
    const owned = messages.filter(
      (message) => owner.get(message.id) === call.id,
    );
    const jobs = tasks?.jobs.filter((job) => job.callId === call.id) ?? [];
    const approval = jobs.filter((job) => job.status === 'approval').length;
    const working = jobs.filter(
      (job) => job.status === 'running' || job.status === 'queued',
    ).length;
    return (
      <details
        className="chat-call"
        key={call.id}
        open={!call.endedAt && call.status !== 'failed' ? true : undefined}
      >
        <summary>
          <Receipt call={call} />
          {approval > 0 && <span>{approval} need approval</span>}
          {working > 0 && <span>{working} working</span>}
        </summary>
        <div className="chat-call-content">
          {owned.map((message, index) => renderMessage(message, index, owned))}
          {tasks && <VoiceTaskList {...tasks} jobs={jobs} />}
        </div>
      </details>
    );
  };
  const groupedIds = new Set(grouped.map((call) => call.id));
  return (
    <>
      {tasks && (
        <VoiceTaskList
          {...tasks}
          jobs={tasks.jobs.filter(
            (job) => !job.callId || !groupedIds.has(job.callId),
          )}
        />
      )}
      {calls
        .filter(
          (call) =>
            call.messageIds === undefined &&
            (!call.anchorMessageId || !ids.has(call.anchorMessageId)),
        )
        .map((call) => (
          <Receipt key={call.id} call={call} />
        ))}
      {messages.map((message, index) => (
        <Fragment key={message.id}>
          {buckets.get(index)?.map(renderCall)}
          {!owner.has(message.id) && renderMessage(message, index, messages)}
        </Fragment>
      ))}
      {buckets.get(messages.length)?.map(renderCall)}
    </>
  );
}
