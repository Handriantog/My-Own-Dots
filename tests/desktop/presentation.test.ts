import { describe, expect, it } from 'vitest';
import {
  PresentationMailbox,
  overlayOrigin,
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
  it('drops queued activity poses during a delayed native acknowledgement', () => {
    const box = new PresentationMailbox(),
      painted = frame(1);
    box.offer(painted);
    box.beginAck(1);
    box.offer(frame(2));
    box.discardPending();
    expect(box.ack(1)).toBeNull();
    expect(box.offer(frame(3))?.sequence).toBe(3);
  });
  it('returns the exact painted frame before advancing a queued presentation', () => {
    const box = new PresentationMailbox(),
      painted = frame(1),
      future = frame(2);
    box.offer(painted);
    box.offer(future);
    expect(box.beginAck(1)).toBe(painted);
    expect(box.beginAck(1)).toBeNull();
    expect(box.beginAck(2)).toBeNull();
    expect(box.ack(1)).toEqual(future);
    expect(box.beginAck(1)).toBeNull();
  });
  it('never passes negative zero to the native integer position API', () => {
    const negativeOriginDisplay = {
      ...display,
      bounds: { ...display.bounds, x: -400, y: -400 },
    };
    for (const [root, monitor, dragging] of [
      [{ x: 159.6925468827576, y: 4893.614583333282 }, display, false],
      [{ x: 159.7, y: 199.7 }, display, true],
      [{ x: 159.7, y: 199.7 }, negativeOriginDisplay, false],
    ] as const) {
      const origin = overlayOrigin(root, monitor, dragging);
      expect(Object.is(origin.x, -0)).toBe(false);
      expect(Object.is(origin.y, -0)).toBe(false);
      expect(origin.x).toBe(0);
    }
  });
  it('retains the whole grabbed body while its pointer crosses a display seam', () => {
    const right = {
      ...display,
      id: '2',
      bounds: { ...display.bounds, x: 1440 },
      workArea: { ...display.workArea, x: 1440 },
      scaleFactor: 1,
    };
    const sim = new CompanionSimulation(
      buildWorld(null, [display, right], 0),
      1,
      { x: 1380, y: 850 },
    );
    sim.pointer({ kind: 'down', point: { x: 1425, y: 795 }, atMs: 0 });
    sim.pointer({ kind: 'move', point: { x: 1445, y: 795 }, atMs: 17 });
    expect(sim.frame().displayId).toBe('2');
    const held = sim.frame();
    for (const dragging of [true, false]) {
      const origin = overlayOrigin(held.root, right, dragging);
      expect(held.root.x - origin.x).toBeGreaterThanOrEqual(52);
      expect(held.root.x - origin.x).toBeLessThanOrEqual(268);
    }
  });
  it('keeps the native surface on its display when the real floor extends below or beside Dock work-area insets', () => {
    for (const scaleFactor of [1, 1.5, 2]) {
      for (const offset of [
        { x: -1920, y: -180 },
        { x: 1440, y: 200 },
        { x: 0, y: -1080 },
      ]) {
        const monitor = {
          id: 'external',
          scaleFactor,
          bounds: { ...offset, width: 1920, height: 1080 },
          workArea: {
            x: offset.x + 80,
            y: offset.y + 25,
            width: 1840,
            height: 1020,
          },
        };
        for (const x of [offset.x + 52, offset.x + 1868]) {
          for (const y of [offset.y + 140, offset.y + 1080]) {
            const root = { x, y },
              origin = overlayOrigin(root, monitor);
            expect(origin.x).toBeGreaterThanOrEqual(monitor.bounds.x);
            expect(origin.x + 320).toBeLessThanOrEqual(monitor.bounds.x + 1920);
            expect(origin.y).toBeGreaterThanOrEqual(monitor.bounds.y);
            expect(origin.y + 320).toBeLessThanOrEqual(monitor.bounds.y + 1080);
            // The body stays inside the canvas without changing the world root.
            expect(root.x - origin.x).toBeGreaterThanOrEqual(52);
            expect(root.x - origin.x).toBeLessThanOrEqual(268);
            expect(root.y - origin.y).toBeGreaterThanOrEqual(112);
            expect(root.y - origin.y).toBeLessThanOrEqual(320);
          }
        }
      }
    }
  });
  it('keeps a held or partly offscreen body centered during handoff and release recovery', () => {
    for (const [root, held] of [
      [{ x: 600, y: 900 }, true],
      [{ x: 40, y: 900 }, false],
      [{ x: 1400, y: 900 }, false],
      [{ x: 600, y: 940 }, false],
      [{ x: 600, y: 100 }, false],
    ] as const) {
      const origin = overlayOrigin(root, display, held);
      expect(root.x - origin.x).toBe(160);
      expect(root.y - origin.y).toBe(200);
    }
  });
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
