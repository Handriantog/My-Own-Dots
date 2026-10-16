import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AudioPolicy,
  parseSoundManifest,
} from '../../src/desktop/core/audio-policy.js';
import type {
  InteractionEvent,
  SoundName,
} from '../../src/desktop/shared/contracts.js';

const manifest = () =>
  parseSoundManifest(
    JSON.parse(
      readFileSync(
        new URL(
          '../../docs/demos/desktop-dot-audio/manifest.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );
function event(
  id: number,
  name: SoundName = 'pat',
  atMs = id * 1000,
): InteractionEvent {
  return {
    id,
    name,
    atMs,
    actionId: id,
    intensity: 1,
    position: { x: 100, y: 100 },
    scope: name === 'fall' ? 'fall' : `action:${id}`,
  };
}
describe('interaction audio policy', () => {
  it('rejects duplicate IDs and enforces event cooldown', () => {
    const policy = new AudioPolicy(manifest(), () => 0);
    expect(policy.offer(event(1), 1000)).not.toBeNull();
    expect(policy.offer(event(1), 1000)).toBeNull();
    expect(policy.offer(event(2, 'pat', 1100), 1100)).toBeNull();
    expect(policy.offer(event(3, 'pat', 1500), 1500)).not.toBeNull();
  });
  it('does not immediately repeat variants even with a constant random source', () => {
    const policy = new AudioPolicy(manifest(), () => 0);
    const files = [1, 2, 3, 4].map(
      (id) => policy.offer(event(id), id * 1000)!.file,
    );
    expect(files[0]).not.toBe(files[1]);
    expect(files[1]).not.toBe(files[2]);
  });
  it('caps active voices at four, favoring direct interactions over movement', () => {
    const policy = new AudioPolicy(manifest(), () => 0.5);
    ['step', 'carry', 'climb', 'turn'].forEach((name, i) =>
      policy.offer(event(i + 1, name as SoundName, 0), 0),
    );
    const pickup = policy.offer(event(5, 'pickup', 10), 10);
    expect(pickup).not.toBeNull();
    expect(policy.stats().voices).toBeLessThanOrEqual(4);
    expect(policy.drainCanceled().length).toBeGreaterThan(0);
  });
  it('cancels a fall on pickup and landing even if the replacement is muted', () => {
    for (const name of ['pickup', 'land_soft', 'land_hard'] as const) {
      const policy = new AudioPolicy(manifest());
      policy.offer(event(1, 'fall', 0), 0);
      policy.offer(event(2, name, 50), 50);
      expect(policy.drainCanceled()).toContain(1);
    }
    const policy = new AudioPolicy(manifest());
    policy.offer(event(1, 'fall', 0), 0);
    policy.setMuted(true);
    expect(policy.drainCanceled()).toContain(1);
    expect(policy.offer(event(2, 'pickup', 60), 60)).toBeNull();
  });
  it('discards old events across suspension and bounds dedupe memory', () => {
    const policy = new AudioPolicy(manifest());
    policy.offer(event(1), 1000);
    policy.suspend();
    expect(policy.stats().voices).toBe(0);
    expect(policy.offer(event(1), 1001)).toBeNull();
    expect(policy.offer(event(2, 'pat', 100), 5000)).toBeNull();
    for (let i = 3; i < 10000; i++) policy.offer(event(i), i * 1000);
    expect(policy.stats().history).toBeLessThanOrEqual(512);
  });
  it('rejects an incomplete asset pack and paths outside the bundled sounds', () => {
    const m = manifest();
    m.events.pop();
    expect(() => parseSoundManifest(m)).toThrow();
    const bad = manifest();
    bad.events[0].variants[0].file = '../private.wav';
    expect(() => parseSoundManifest(bad)).toThrow();
  });
});
