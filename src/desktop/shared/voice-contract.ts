import type { VoicePhase } from '../../shared/local-voice.js';

export type CompanionVoiceState = VoicePhase | 'connecting' | null;

/** The workspace receives no desktop access beyond this call lifecycle boundary. */
export interface DesktopVoiceBridge {
  setReady(ready: boolean): Promise<void>;
  /** Consume a fresh native Talk action to deliver one trusted start gesture. */
  activate(): Promise<void>;
  cancelTalk(): void;
  cancelStart(): Promise<void>;
  begin(callId: string): Promise<void>;
  end(callId: string): Promise<void>;
  isWindowless(): boolean;
  phase(callId: string, phase: VoicePhase): Promise<void>;
  reportError(message: string): void;
  onStop(callback: (reason: string) => void): () => void;
  onTalk(callback: () => void): () => void;
}
