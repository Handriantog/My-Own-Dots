/** Host-owned boundary: model output never supplies identity or execution options. */
export interface NativeUnderstanding {
  text: string;
  route: 'chat' | 'clarify' | 'delegate' | 'clock' | 'status' | 'ignore';
  tool?: { name: 'delegate_task'; arguments: { request: string } };
}
export interface NativeHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}
export interface NativeRoutingContext {
  history: NativeHistoryMessage[];
  /** Host-owned lifecycle only; permission and scope decisions stay with the agent. */
  taskStatus:
    | 'none'
    | 'queued'
    | 'running'
    | 'approval'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
}
export interface NativeReplyContext {
  /** Recognition of the current original audio, already persisted by the host. */
  caption: string;
  /** Host-selected Dot persona and authorized supporting context. */
  instructions: string;
  history: NativeHistoryMessage[];
}
export interface NativeSpeech {
  text: string;
  /** Signed 16-bit little endian, 24 kHz, mono. */
  pcm: Buffer;
}
/** An admitted shared-engine turn can wait silently for its actual answer. */
export interface NativeTurnReply extends NativeSpeech {
  assistantMessageId: string;
  reviewFolders?: boolean;
  awaitingReply?: boolean;
}
export interface NativeVoiceSession {
  warm(signal: AbortSignal): Promise<void>;
  /** Input has already passed the call's speech detector; 16 kHz mono PCM. */
  interpret(
    pcm: Buffer,
    signal: AbortSignal,
    context?: NativeRoutingContext,
  ): Promise<NativeUnderstanding>;
  /** Local wording is guided by canonical context; speech still receives original audio. */
  respond(
    pcm: Buffer,
    context: NativeReplyContext,
    signal: AbortSignal,
  ): Promise<NativeSpeech>;
  /** Speak authoritative job/approval text without letting the model rewrite it. */
  speak(text: string, signal: AbortSignal): Promise<NativeSpeech>;
  /** Cancels inference and waits for process exit. Instances cannot be reopened. */
  close(): Promise<void>;
}
