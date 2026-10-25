import type {
  NativeVoiceSession,
  NativeRoutingContext,
} from './native-contract.js';

/** Separate processes keep speech output failures from destroying recognition. */
export class QwenVoiceSession implements NativeVoiceSession {
  constructor(
    private readonly recognition: NativeVoiceSession,
    private readonly synthesis: NativeVoiceSession,
  ) {}
  async warm(signal: AbortSignal): Promise<void> {
    try {
      await Promise.all([
        this.recognition.warm(signal),
        this.synthesis.warm(signal),
      ]);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  interpret(pcm: Buffer, signal: AbortSignal, context?: NativeRoutingContext) {
    return this.recognition.interpret(pcm, signal, context);
  }
  respond(): Promise<never> {
    return Promise.reject(
      new Error('High replies must come from the task agent.'),
    );
  }
  speak(text: string, signal: AbortSignal) {
    return this.synthesis.speak(text, signal);
  }
  async close(): Promise<void> {
    await Promise.all([this.recognition.close(), this.synthesis.close()]);
  }
}
