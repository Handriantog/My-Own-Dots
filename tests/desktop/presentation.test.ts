import { describe, expect, it } from 'vitest';
import {
  PresentationMailbox,
  validPointerInput,
} from '../../src/desktop/host/presentation.js';
import { CompanionSimulation } from '../../src/desktop/core/simulation.js';
import { buildWorld } from '../../src/desktop/core/world.js';
import { DEFAULT_PREFERENCES } from '../../src/desktop/host/preferences.js';
import { display } from './fixtures.js';
import type { PresentationFrame } from '../../src/desktop/shared/contracts.js';

function frame(sequence: number): PresentationFrame {
  const sim = new CompanionSimulation(buildWorld(null, [display], 0));
  return {
    sequence,
    sentAtMs: sequence * 16,
    origin: { x: 0, y: 0 },
    simulation: sim.frame(),
    events: [
      {
        id: sequence,
        name: 'pat',
        atMs: sequence * 16,
        actionId: 1,
        intensity: 1,
        position: { x: 50, y: 50 },
        scope: 'pat',
      },
    ],
    preferences: DEFAULT_PREFERENCES,
    hovered: false,
    visible: true,
    displayBounds: display.bounds,
  };
}
describe('presentation sequencing', () => {
  it('keeps one in-flight frame and merges events into the freshest pending state', () => {
    const box = new PresentationMailbox();
    expect(box.offer(frame(1))?.sequence).toBe(1);
    expect(box.offer(frame(2))).toBeNull();
    expect(box.offer(frame(3))).toBeNull();
    expect(box.ack(99)).toBeNull();
    const next = box.ack(1)!;
    expect(next.sequence).toBe(3);
    expect(next.events.map((e) => e.id)).toEqual([2, 3]);
    expect(box.ack(3)).toBeNull();
    expect(box.offer(frame(4))?.sequence).toBe(4);
  });
  it('bounds events, reports a hung renderer, and clears stale data on reset', () => {
    const box = new PresentationMailbox();
    box.offer(frame(1));
    for (let i = 2; i < 1000; i++) box.offer(frame(i));
    expect(box.stalled(1000)).toBe(true);
    expect(box.ack(1)!.events.length).toBeLessThanOrEqual(64);
    box.reset();
    expect(box.ack(999)).toBeNull();
    expect(box.offer(frame(1001))?.events).toHaveLength(1);
  });
  it('rejects malformed renderer pointer operations', () => {
    expect(
      validPointerInput({ kind: 'down', point: { x: -500, y: 200 }, atMs: 50 }),
    ).toBe(true);
    for (const value of [
      { kind: 'shell' },
      { kind: 'down', point: { x: Infinity, y: 0 }, atMs: 1 },
      { kind: 'move', point: { x: 999999, y: 0 }, atMs: 1 },
    ])
      expect(validPointerInput(value)).toBe(false);
  });
});
