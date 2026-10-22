import { Mascot } from './Mascot';
import { openPageLink } from './page-navigation';
import { Fragment, type ReactNode } from 'react';
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
function Receipt({ call }: { call: CallReceipt }) {
  return (
    <div className="call-receipt">
      <PhoneOff size={13} />
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
}: {
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
  return (
    <>
      {calls
        .filter(
          (call) => !call.anchorMessageId || !ids.has(call.anchorMessageId),
        )
        .map((call) => (
          <Receipt key={call.id} call={call} />
        ))}
      {messages.map((message, index) => {
        const previous = messages[index - 1];
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
                      title={
                        bookmarked ? 'Remove bookmark' : 'Bookmark message'
                      }
                      aria-pressed={bookmarked}
                      onClick={() =>
                        onMark(message.id, 'bookmark', !bookmarked)
                      }
                    >
                      <Bookmark size={14} />
                    </button>
                  </div>
                )}
              {!continued && (
                <>
                  <span className="chat-avatar" aria-hidden="true">
                    {message.role === 'assistant' ? (
                      <Mascot
                        identity={dotId}
                        name={dotName}
                        small
                        decorative
                      />
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
                {typeof message.content === 'string' &&
                  message.content.trim() && (
                    <div
                      className={`chat-bubble ${message.role}${isScheduledTaskMessage(message) ? ' scheduled' : ''}`}
                    >
                      {isScheduledTaskMessage(message) && (
                        <span className="scheduled-message-label">
                          Scheduled
                        </span>
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
                                href?.startsWith('/#/spaces/')
                                  ? undefined
                                  : '_blank'
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
              .filter((call) => call.anchorMessageId === message.id)
              .map((call) => (
                <Receipt key={call.id} call={call} />
              ))}
          </Fragment>
        );
      })}
    </>
  );
}
