export interface LocalVoiceStatus {
  enabled: boolean;
  ready: boolean;
  reason: string;
  inferenceRuntime?: 'warm-session' | 'per-request' | 'persistent-provider';
}
export type VoicePhase = 'listening' | 'thinking' | 'speaking' | 'approval';
export type LocalVoiceEvent =
  | { type: 'phase'; phase: VoicePhase }
  | { type: 'transcript'; messageId: string; text: string; generation: number }
  | { type: 'caption'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'flush'; generation: number; keepTranscript?: boolean }
  | { type: 'audio'; generation: number; sequence: number; pcm: string }
  | { type: 'ended'; error?: string };
export interface LocalVoiceHandle {
  id: string;
  token: string;
}
export interface VoiceDelivery {
  messageId: string;
  assistantMessageId?: string;
  segmentSequence?: number;
  generation: number;
  generatedSamples: number;
  queuedSamples: number;
  softwarePlayedSamples: number;
  interrupted: boolean;
}
