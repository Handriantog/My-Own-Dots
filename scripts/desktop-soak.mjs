import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { CompanionSimulation } from '../src/desktop/core/simulation.ts';
import { buildWorld } from '../src/desktop/core/world.ts';
import {
  AudioPolicy,
  parseSoundManifest,
} from '../src/desktop/core/audio-policy.ts';

const display = {
  id: '1',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 24, width: 1920, height: 996 },
  scaleFactor: 2,
};
const windows = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  ownerPid: 100 + i,
  generation: 1,
  bounds: {
    x: 110 + (i % 5) * 290,
    y: 170 + Math.floor(i / 5) * 165,
    width: 280,
    height: 360,
  },
  opaque: true,
}));
const observation = {
  protocolVersion: 1,
  helperSession: 'soak',
  seq: 1,
  observedAtMs: 0,
  sceneRevision: 1,
  pollIntervalMs: 100,
  accessibility: true,
  sceneValid: true,
  displays: [display],
  windows,
};
const sim = new CompanionSimulation(
  buildWorld(observation, [display], 0),
  5711,
  { x: 1700, y: 1020 },
);
const audio = new AudioPolicy(
  parseSoundManifest(
    JSON.parse(
      readFileSync(
        new URL(
          '../docs/demos/desktop-dot-audio/manifest.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  ),
);
const actions = {},
  sounds = {};
let previous = sim.frame().root,
  maximumDisplacement = 0,
  maximumVoices = 0,
  events = 0;
const started = performance.now();
sim.advance(0);
for (
  let t = 1000 / 60, frameNumber = 1;
  t <= 30 * 60 * 1000;
  t += 1000 / 60, frameNumber++
) {
  if (frameNumber % 6 === 0) {
    const index = Math.floor(t / 3000) % 20;
    const dynamic = windows
      .map((w, i) =>
        i === index
          ? {
              ...w,
              bounds: { ...w.bounds, x: w.bounds.x + Math.sin(t / 1000) * 12 },
            }
          : w,
      )
      .filter((_, i) => !(Math.floor(t / 7000) % 5 === 0 && i === 0));
    const current = {
      ...observation,
      seq: frameNumber,
      observedAtMs: t,
      accessibility: !(t > 600000 && t < 610000),
      windows: dynamic,
    };
    sim.setWorld(buildWorld(current, [display], t));
  }
  sim.advance(t);
  const frame = sim.frame();
  assert(
    Number.isFinite(
      frame.root.x + frame.root.y + frame.velocity.x + frame.velocity.y,
    ),
  );
  const displacement = Math.hypot(
    frame.root.x - previous.x,
    frame.root.y - previous.y,
  );
  assert(displacement < 24, `Discontinuous movement at ${t}: ${displacement}`);
  maximumDisplacement = Math.max(maximumDisplacement, displacement);
  previous = frame.root;
  actions[frame.action] = (actions[frame.action] ?? 0) + 1;
  for (const event of sim.drainEvents()) {
    events++;
    sounds[event.name] = (sounds[event.name] ?? 0) + 1;
    audio.offer(event, frame.atMs);
    audio.drainCanceled();
  }
  maximumVoices = Math.max(maximumVoices, audio.stats().voices);
  assert(maximumVoices <= 4);
  assert(audio.stats().history <= 512);
}
const report = {
  kind: 'synthetic virtual-time soak',
  simulatedMinutes: 30,
  windows: 20,
  frames: 108000,
  elapsedSeconds: (performance.now() - started) / 1000,
  maximumDisplacementPerFrame: maximumDisplacement,
  maximumVoices,
  events,
  actions,
  sounds,
  heapUsedMiB: process.memoryUsage().heapUsed / 1024 ** 2,
  note: 'Proves bounded deterministic simulation under scripted geometry changes; not native stacking, OS capture, physical audio latency, or live process resource stability.',
};
mkdirSync('artifacts/desktop', { recursive: true });
writeFileSync(
  'artifacts/desktop/synthetic-soak.json',
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
