import { z } from 'zod';
import {
  SOUND_NAMES,
  type InteractionEvent,
  type SoundName,
} from '../shared/contracts.js';

const manifestSchema = z.object({
  version: z.literal(1),
  events: z
    .array(
      z.object({
        event: z.enum(SOUND_NAMES),
        cooldownMs: z.number().nonnegative().max(60000),
        variants: z
          .array(
            z.object({
              file: z.string().regex(/^[a-z_-]+-\d{2}\.wav$/),
              durationSeconds: z.number().positive().max(10),
            }),
          )
          .length(3),
      }),
    )
    .length(SOUND_NAMES.length),
});
export type SoundManifest = z.infer<typeof manifestSchema>;
export function parseSoundManifest(value: unknown): SoundManifest {
  const manifest = manifestSchema.parse(value);
  if (new Set(manifest.events.map((e) => e.event)).size !== SOUND_NAMES.length)
    throw new Error('Incomplete sound family coverage');
  return manifest;
}
export interface VoiceRequest {
  id: number;
  file: string;
  rate: number;
  gain: number;
  duration: number;
  priority: number;
  scope: string;
}
export class AudioPolicy {
  private seen = new Set<number>();
  private lastAt = new Map<SoundName, number>();
  private lastVariant = new Map<SoundName, number>();
  private voices = new Map<
    number,
    { until: number; priority: number; scope: string }
  >();
  private canceled: number[] = [];
  private muted = false;
  constructor(
    private manifest: SoundManifest,
    private random: () => number = Math.random,
  ) {}
  offer(event: InteractionEvent, nowMs: number): VoiceRequest | null {
    for (const [id, voice] of this.voices)
      if (voice.until <= nowMs) this.voices.delete(id);
    if (this.seen.has(event.id)) return null;
    this.seen.add(event.id);
    if (this.seen.size > 512)
      this.seen.delete(this.seen.values().next().value!);
    const cancelScopes = new Set(event.cancelScopes ?? []);
    if (['pickup', 'land_soft', 'land_hard', 'grab'].includes(event.name))
      cancelScopes.add('fall');
    if (['release', 'land_soft', 'land_hard'].includes(event.name))
      cancelScopes.add('carry');
    for (const [id, voice] of this.voices)
      if (cancelScopes.has(voice.scope)) this.cancel(id);
    if (this.muted || nowMs - event.atMs > 250 || event.atMs - nowMs > 50)
      return null;
    const family = this.manifest.events.find((e) => e.event === event.name)!;
    if (nowMs - (this.lastAt.get(event.name) ?? -Infinity) < family.cooldownMs)
      return null;
    const priority = [
      'pickup',
      'release',
      'pat',
      'land_soft',
      'land_hard',
      'bump',
      'grab',
    ].includes(event.name)
      ? 3
      : ['step', 'carry', 'climb', 'turn'].includes(event.name)
        ? 1
        : 2;
    if (this.voices.size >= 4) {
      const lowest = [...this.voices.entries()].sort(
        (a, b) => a[1].priority - b[1].priority,
      )[0];
      if (lowest[1].priority > priority) return null;
      this.cancel(lowest[0]);
    }
    const candidates = family.variants
      .map((_, i) => i)
      .filter((i) => i !== this.lastVariant.get(event.name));
    const variant =
      candidates[
        Math.floor(
          Math.max(0, Math.min(0.999999, this.random())) * candidates.length,
        )
      ];
    const chosen = family.variants[variant],
      rate = 0.98 + this.random() * 0.04;
    this.lastVariant.set(event.name, variant);
    this.lastAt.set(event.name, nowMs);
    this.voices.set(event.id, {
      until: nowMs + (chosen.durationSeconds / rate) * 1000,
      priority,
      scope: event.scope,
    });
    return {
      id: event.id,
      file: chosen.file,
      rate,
      gain: 0.35 + 0.65 * Math.sqrt(Math.max(0, Math.min(1, event.intensity))),
      duration: chosen.durationSeconds / rate,
      priority,
      scope: event.scope,
    };
  }
  private cancel(id: number): void {
    this.voices.delete(id);
    this.canceled.push(id);
  }
  drainCanceled(): number[] {
    const result = this.canceled;
    this.canceled = [];
    return result;
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.suspend();
  }
  suspend(): void {
    for (const id of this.voices.keys()) this.cancel(id);
  }
  stats(): { voices: number; history: number } {
    return { voices: this.voices.size, history: this.seen.size };
  }
}
