export type MessageMarkKind = 'pin' | 'bookmark';
export interface MarkableMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}
export interface MessageMark {
  threadId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  pinnedAt: number | null;
  bookmarkedAt: number | null;
  threadTitle: string;
  dotId: string;
  dotName: string;
}
