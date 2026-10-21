import type { VoiceQuality } from './voice-settings.js';

export interface VoiceModeStatus {
  ready: boolean;
  reason: string;
  audioInput: boolean;
  audioOutput: boolean;
  needsSetup: boolean;
}
export interface LocalVoiceStatus {
  enabled: boolean;
  ready: boolean;
  reason: string;
  inferenceRuntime?:
    'warm-session' | 'per-request' | 'persistent-provider' | 'native-local';
  /** Optional only for clients talking to a workspace predating quality settings. */
  selectedQuality?: VoiceQuality;
  /** Changes whenever the saved quality, voice or personality changes. */
  settingsRevision?: string;
  modes?: Record<VoiceQuality, VoiceModeStatus>;
}
export type VoicePhase = 'listening' | 'thinking' | 'speaking' | 'approval';
export type LocalVoiceEvent =
  | { type: 'phase'; phase: VoicePhase }
  | { type: 'transcript'; messageId: string; text: string; generation: number }
  | {
      type: 'native-transcript';
      messageId: string;
      text: string;
      generation: number;
    }
  | { type: 'saved'; text: string }
  | { type: 'caption'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'review-folders' }
  | { type: 'flush'; generation: number; keepTranscript?: boolean }
  | { type: 'audio'; generation: number; sequence: number; pcm: string }
  | { type: 'ended'; error?: string };
export interface LocalVoiceHandle {
  id: string;
  token: string;
  /** Older workspaces return no quality and always use Medium. */
  quality?: VoiceQuality;
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
