/** The workspace receives no desktop access beyond this call lifecycle boundary. */
export interface DesktopVoiceBridge {
  setReady(ready: boolean): Promise<void>;
  /** Consume a fresh native Talk action to deliver one trusted start gesture. */
  activate(): Promise<void>;
  cancelTalk(): void;
  begin(callId: string): Promise<void>;
  end(callId: string): Promise<void>;
  onStop(callback: (reason: string) => void): () => void;
  onTalk(callback: () => void): () => void;
}
