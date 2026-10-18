import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionAudio } from '../../src/desktop/renderer/audio.js';
import { DEFAULT_PREFERENCES } from '../../src/desktop/host/preferences.js';
import { CompanionSimulation } from '../../src/desktop/core/simulation.js';
import { buildWorld } from '../../src/desktop/core/world.js';
import type {
  InteractionEvent,
  SoundName,
} from '../../src/desktop/shared/contracts.js';
import { display } from './fixtures.js';

// The browser's Web Audio engine is unavailable in Node. This small graph models
// its gain routing so assertions concern the renderer's audible output.
class AudioParamDouble {
  value = 1;
  setTargetAtTime(value: number) {
    this.value = value;
  }
  setValueAtTime(value: number) {
    this.value = value;
  }
  linearRampToValueAtTime(value: number) {
    this.value = value;
  }
  cancelScheduledValues() {}
}
class AudioNodeDouble {
  output?: AudioNodeDouble;
  connect(node: AudioNodeDouble) {
    this.output = node;
    return node;
  }
  disconnect() {
    this.output = undefined;
  }
  level(): number {
    return this.output?.level() ?? 1;
  }
}
class GainDouble extends AudioNodeDouble {
  gain = new AudioParamDouble();
  level(): number {
    return this.gain.value * super.level();
  }
}
class SourceDouble extends AudioNodeDouble {
  buffer: unknown;
  playbackRate = new AudioParamDouble();
  onended?: () => void;
  stopped = false;
  start() {}
  stop() {
    this.stopped = true;
  }
  level(): number {
    return this.stopped ? 0 : super.level();
  }
}
class ContextDouble {
  sampleRate = 48000;
  static current: ContextDouble;
  destination = new AudioNodeDouble();
  currentTime = 0;
  state = 'running';
  sources: SourceDouble[] = [];
  constructor() {
    ContextDouble.current = this;
  }
  createGain() {
    return new GainDouble();
  }
  createStereoPanner() {
    return Object.assign(new AudioNodeDouble(), {
      pan: new AudioParamDouble(),
    });
  }
  createBufferSource() {
    const source = new SourceDouble();
    this.sources.push(source);
    return source;
  }
  createBuffer(_channels: number, length: number) {
    const samples = new Float32Array(length);
    return { getChannelData: () => samples };
  }
  async decodeAudioData() {
    return { duration: 1 };
  }
  async resume() {}
  async close() {}
}
const manifest = JSON.parse(
  readFileSync(
    new URL(
      '../../docs/demos/desktop-dot-audio/manifest.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const frame = new CompanionSimulation(
  buildWorld(null, [display], 0),
  1,
).frame();
function event(id: number, name: SoundName): InteractionEvent {
  return {
    id,
    name,
    atMs: 0,
    actionId: id,
    intensity: 1,
    position: { x: 100, y: 100 },
    scope: name === 'fall' ? 'fall' : `action:${id}`,
  };
}
let audio: CompanionAudio;
beforeEach(async () => {
  vi.stubGlobal('AudioContext', ContextDouble);
  vi.stubGlobal('fetch', async (url: string) => ({
    ok: true,
    json: async () => manifest,
    arrayBuffer: async () => new ArrayBuffer(url.length),
  }));
  audio = new CompanionAudio();
  await audio.load('/sounds');
});
afterEach(() => {
  audio.dispose();
  vi.unstubAllGlobals();
});

describe('desktop sound category mixer', () => {
  it('plays a visibility pop once per cue through the existing volume and interaction bus', () => {
    const prefs = {
      ...DEFAULT_PREFERENCES,
      volume: 0.8,
      categoryVolumes: {
        ...DEFAULT_PREFERENCES.categoryVolumes,
        interactions: 0.25,
      },
    };
    audio.consume([], frame, prefs, display.bounds, false, 1);
    audio.consume([], frame, prefs, display.bounds, false, 1);
    expect(ContextDouble.current.sources).toHaveLength(1);
    expect(ContextDouble.current.sources[0].level()).toBeCloseTo(0.2);
    audio.consume([], frame, prefs, display.bounds, true, 1);
    expect(ContextDouble.current.sources[0].level()).toBeCloseTo(0.02);
    audio.suspend();
    expect(ContextDouble.current.sources[0].stopped).toBe(true);
  });
  it.each(['muted', 'master', 'category'] as const)(
    'does not replay a pop suppressed by %s when sound is restored',
    (control) => {
      const prefs = {
        ...DEFAULT_PREFERENCES,
        muted: control === 'muted',
        volume: control === 'master' ? 0 : 0.4,
        categoryVolumes: {
          ...DEFAULT_PREFERENCES.categoryVolumes,
          interactions: control === 'category' ? 0 : 1,
        },
      };
      audio.consume([], frame, prefs, display.bounds, false, 1);
      audio.consume([], frame, DEFAULT_PREFERENCES, display.bounds, false, 1);
      expect(ContextDouble.current.sources).toHaveLength(0);
      audio.consume([], frame, DEFAULT_PREFERENCES, display.bounds, false, 2);
      expect(ContextDouble.current.sources).toHaveLength(1);
    },
  );
  it('ducks active and new plush effects during a call, then restores the saved volume', () => {
    audio.consume(
      [event(1, 'pat')],
      frame,
      DEFAULT_PREFERENCES,
      display.bounds,
    );
    const before = ContextDouble.current.sources[0].level();
    audio.consume([], frame, DEFAULT_PREFERENCES, display.bounds, true);
    expect(ContextDouble.current.sources[0].level()).toBeCloseTo(before * 0.1);
    audio.consume(
      [event(2, 'pickup')],
      frame,
      DEFAULT_PREFERENCES,
      display.bounds,
      true,
    );
    expect(ContextDouble.current.sources[1].level()).toBeCloseTo(0.04);
    audio.consume([], frame, DEFAULT_PREFERENCES, display.bounds, false);
    expect(ContextDouble.current.sources[1].level()).toBeCloseTo(0.4);
    expect(DEFAULT_PREFERENCES.volume).toBe(0.4);
  });
  it.each([
    ['step', 'walking'],
    ['turn', 'walking'],
    ['jump', 'walking'],
    ['appear', 'interactions'],
    ['notice', 'interactions'],
    ['pat', 'interactions'],
    ['pickup', 'interactions'],
    ['carry', 'interactions'],
    ['release', 'interactions'],
    ['bump', 'interactions'],
    ['grab', 'climbing'],
    ['climb', 'climbing'],
    ['pull_up', 'climbing'],
    ['slip', 'falls'],
    ['fall', 'falls'],
    ['land_soft', 'falls'],
    ['land_hard', 'falls'],
    ['sit', 'rest'],
    ['stand', 'rest'],
    ['stretch', 'rest'],
    ['yawn', 'rest'],
    ['sleep', 'rest'],
    ['wake', 'rest'],
  ] as const)(
    'routes %s through the %s volume and master volume',
    (name, category) => {
      audio.consume(
        [event(1, name)],
        frame,
        {
          ...DEFAULT_PREFERENCES,
          volume: 0.8,
          categoryVolumes: {
            walking: 1,
            interactions: 1,
            climbing: 1,
            falls: 1,
            rest: 1,
            [category]: 0.25,
          },
        },
        display.bounds,
      );
      expect(ContextDouble.current.sources[0].level()).toBeCloseTo(0.2);
    },
  );
  it('updates existing voices independently when category or master levels change', () => {
    const prefs = {
      ...DEFAULT_PREFERENCES,
      volume: 0.8,
      categoryVolumes: {
        walking: 0.5,
        interactions: 0.25,
        climbing: 1,
        falls: 1,
        rest: 1,
      },
    };
    audio.consume(
      [event(1, 'step'), event(2, 'pat')],
      frame,
      prefs,
      display.bounds,
    );
    const [walking, interaction] = ContextDouble.current.sources;
    expect(walking.level()).toBeCloseTo(0.4);
    expect(interaction.level()).toBeCloseTo(0.2);
    audio.consume(
      [],
      frame,
      { ...prefs, categoryVolumes: { ...prefs.categoryVolumes, walking: 0 } },
      display.bounds,
    );
    expect(walking.level()).toBe(0);
    expect(interaction.level()).toBeCloseTo(0.2);
    audio.consume([], frame, { ...prefs, volume: 0.4 }, display.bounds);
    expect(walking.level()).toBeCloseTo(0.2);
    expect(interaction.level()).toBeCloseTo(0.1);
  });
  it('keeps zero-volume landing events silent while canceling an active fall', () => {
    audio.consume(
      [event(1, 'fall')],
      frame,
      DEFAULT_PREFERENCES,
      display.bounds,
    );
    const fall = ContextDouble.current.sources[0];
    audio.consume(
      [event(2, 'land_soft')],
      frame,
      {
        ...DEFAULT_PREFERENCES,
        categoryVolumes: {
          walking: 1,
          interactions: 1,
          climbing: 1,
          falls: 0,
          rest: 1,
        },
      },
      display.bounds,
    );
    expect(fall.stopped).toBe(true);
    expect(ContextDouble.current.sources).toHaveLength(1);
  });
  it('does not start zero-category voices while their bus is fading', () => {
    audio.consume(
      [event(1, 'step'), event(2, 'pat')],
      frame,
      {
        ...DEFAULT_PREFERENCES,
        categoryVolumes: {
          walking: 0,
          interactions: 0.5,
          climbing: 1,
          falls: 1,
          rest: 1,
        },
      },
      display.bounds,
    );
    expect(ContextDouble.current.sources).toHaveLength(1);
    expect(ContextDouble.current.sources[0].level()).toBeCloseTo(0.2);
  });
  it('preserves four audible voices when another category emits a silent high-priority event', () => {
    audio.consume(
      [event(1, 'step'), event(2, 'turn'), event(3, 'climb'), event(4, 'sit')],
      frame,
      DEFAULT_PREFERENCES,
      display.bounds,
    );
    const voices = [...ContextDouble.current.sources];
    audio.consume(
      [event(5, 'pat')],
      frame,
      {
        ...DEFAULT_PREFERENCES,
        categoryVolumes: {
          ...DEFAULT_PREFERENCES.categoryVolumes,
          interactions: 0,
        },
      },
      display.bounds,
    );
    expect(ContextDouble.current.sources).toHaveLength(4);
    expect(voices.every((voice) => !voice.stopped)).toBe(true);
  });
  it.each(['master', 'category'] as const)(
    'does not replay sounds suppressed by zero %s volume or consume their cooldown',
    (control) => {
      const silent =
        control === 'master'
          ? { ...DEFAULT_PREFERENCES, volume: 0 }
          : {
              ...DEFAULT_PREFERENCES,
              categoryVolumes: {
                ...DEFAULT_PREFERENCES.categoryVolumes,
                interactions: 0,
              },
            };
      audio.consume([event(1, 'pat')], frame, silent, display.bounds);
      expect(ContextDouble.current.sources).toHaveLength(0);
      audio.consume(
        [event(1, 'pat')],
        frame,
        DEFAULT_PREFERENCES,
        display.bounds,
      );
      expect(ContextDouble.current.sources).toHaveLength(0);
      audio.consume(
        [event(2, 'pat')],
        frame,
        DEFAULT_PREFERENCES,
        display.bounds,
      );
      expect(ContextDouble.current.sources).toHaveLength(1);
    },
  );
  it('retains master mute cancellation and resumes with category levels', () => {
    audio.consume(
      [event(1, 'pat')],
      frame,
      DEFAULT_PREFERENCES,
      display.bounds,
    );
    const pat = ContextDouble.current.sources[0];
    audio.consume(
      [],
      frame,
      { ...DEFAULT_PREFERENCES, muted: true },
      display.bounds,
    );
    expect(pat.stopped).toBe(true);
    audio.consume(
      [event(2, 'pickup')],
      frame,
      {
        ...DEFAULT_PREFERENCES,
        volume: 0.6,
        categoryVolumes: {
          walking: 1,
          interactions: 0.5,
          climbing: 1,
          falls: 1,
          rest: 1,
        },
      },
      display.bounds,
    );
    expect(ContextDouble.current.sources[1].level()).toBeCloseTo(0.3);
  });
});
