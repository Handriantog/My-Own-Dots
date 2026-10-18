import {
  SOUND_CATEGORIES,
  SOUND_CATEGORY,
  type SoundCategory,
} from '../core/sound-categories.js';
import { AudioPolicy, parseSoundManifest } from '../core/audio-policy.js';
import type {
  InteractionEvent,
  Preferences,
  SimulationFrame,
} from '../shared/contracts.js';

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
}
export class CompanionAudio {
  private context = new AudioContext({ latencyHint: 'interactive' });
  private master = this.context.createGain();
  private categories = new Map<SoundCategory, GainNode>();
  private buffers = new Map<string, AudioBuffer>();
  private voices = new Map<number, Voice>();
  private policy: AudioPolicy | null = null;
  private disposed = false;
  private suspended = false;
  constructor() {
    this.master.gain.value = 0.4;
    this.master.connect(this.context.destination);
    for (const category of SOUND_CATEGORIES) {
      const gain = this.context.createGain();
      gain.connect(this.master);
      this.categories.set(category, gain);
    }
  }
  async load(base: string): Promise<void> {
    const response = await fetch(`${base}/manifest.json`);
    if (!response.ok) throw new Error('Sound catalog is unavailable');
    const manifest = parseSoundManifest(await response.json());
    await Promise.all(
      manifest.events
        .flatMap((family) => family.variants)
        .map(async (variant) => {
          const response = await fetch(`${base}/${variant.file}`);
          if (!response.ok) throw new Error(`Missing sound ${variant.file}`);
          const buffer = await this.context.decodeAudioData(
            await response.arrayBuffer(),
          );
          if (!this.disposed) this.buffers.set(variant.file, buffer);
        }),
    );
    this.policy = new AudioPolicy(manifest);
  }
  consume(
    events: InteractionEvent[],
    frame: SimulationFrame,
    prefs: Preferences,
    display: { x: number; width: number },
    voiceActive = false,
  ): void {
    if (this.disposed || !this.policy) return;
    this.suspended = false;
    if (this.context.state === 'suspended') void this.context.resume();
    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(
      prefs.muted ? 0 : prefs.volume * (voiceActive ? 0.1 : 1),
      now,
      0.018,
    );
    for (const category of SOUND_CATEGORIES)
      this.categories
        .get(category)!
        .gain.setTargetAtTime(prefs.categoryVolumes[category], now, 0.018);
    this.policy.setMuted(prefs.muted);
    this.cancelVoices();
    for (const event of events) {
      // Silent events still deduplicate and cancel previous actions, without
      // taking an audible voice's slot or advancing cooldown/variant selection.
      const request = this.policy.offer(
        event,
        frame.atMs,
        prefs.volume > 0 &&
          prefs.categoryVolumes[SOUND_CATEGORY[event.name]] > 0,
      );
      const canceled = this.cancelVoices();
      if (!request) continue;
      const buffer = this.buffers.get(request.file);
      if (!buffer) continue;
      const source = this.context.createBufferSource(),
        gain = this.context.createGain(),
        pan = this.context.createStereoPanner();
      source.buffer = buffer;
      source.playbackRate.value = request.rate;
      gain.gain.value = request.gain;
      const stereo = Math.max(
        -0.55,
        Math.min(
          0.55,
          ((event.position.x - display.x) / display.width - 0.5) * 1.1,
        ),
      );
      pan.pan.setValueAtTime(stereo, now);
      source
        .connect(gain)
        .connect(pan)
        .connect(this.categories.get(SOUND_CATEGORY[event.name])!);
      this.voices.set(request.id, { source, gain, pan });
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        pan.disconnect();
        this.voices.delete(request.id);
      };
      // A replacement starts after the stolen voice's brief fade, preserving four audible voices.
      source.start(now + (canceled ? 0.018 : 0));
    }
  }
  private cancelVoices(): boolean {
    const ids = this.policy?.drainCanceled() ?? [];
    for (const id of ids) {
      const voice = this.voices.get(id);
      if (!voice) continue;
      const now = this.context.currentTime;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + 0.015);
      voice.source.stop(now + 0.016);
      this.voices.delete(id);
    }
    return ids.length > 0;
  }
  suspend(): void {
    if (this.suspended || this.disposed) return;
    this.suspended = true;
    this.policy?.suspend();
    this.cancelVoices();
    this.master.gain.setTargetAtTime(0, this.context.currentTime, 0.01);
  }
  stats(): { decoded: number; voices: number; state: AudioContextState } {
    return {
      decoded: this.buffers.size,
      voices: this.voices.size,
      state: this.context.state,
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.suspend();
    this.disposed = true;
    this.buffers.clear();
    void this.context.close();
  }
}
