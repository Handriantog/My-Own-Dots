import { describe, expect, it } from 'vitest';
import { voiceStatusLayout } from '../../src/desktop/renderer/voice-status.js';

describe('voice status bubble', () => {
  it('labels startup and active voice phases beside Dot', () => {
    for (const [state, label] of [
      ['connecting', 'Connecting…'],
      ['listening', 'Listening'],
      ['thinking', 'Thinking'],
    ] as const) {
      const bubble = voiceStatusLayout(state, { x: 160, y: 200 });
      expect(bubble).toMatchObject({ label, side: 'right' });
      expect(bubble!.x).toBeGreaterThanOrEqual(160 + 56);
      expect(bubble!.x + bubble!.width).toBeLessThanOrEqual(312);
    }
  });
  it('uses the left side at the screen edge without moving Dot or clipping the label', () => {
    const root = { x: 268, y: 320 };
    for (const state of ['connecting', 'listening', 'thinking'] as const) {
      const bubble = voiceStatusLayout(state, root)!;
      expect(bubble).not.toBeNull();
      expect(bubble.side).toBe('left');
      expect(bubble.x + bubble.width).toBeLessThanOrEqual(root.x - 56);
      expect(bubble.x).toBeGreaterThanOrEqual(8);
      expect(bubble.y + 30).toBeLessThanOrEqual(320);
      const left = voiceStatusLayout(state, { x: 52, y: 50 })!;
      expect(left.side).toBe('right');
      expect(left.x + left.width).toBeLessThanOrEqual(312);
    }
    expect(root).toEqual({ x: 268, y: 320 });
    expect(
      voiceStatusLayout('thinking', { x: 52, y: 50 })!.y,
    ).toBeGreaterThanOrEqual(8);
  });
  it('removes the bubble while speaking and when the call ends', () => {
    expect(voiceStatusLayout('speaking', { x: 160, y: 200 })).toBeNull();
    expect(voiceStatusLayout(null, { x: 160, y: 200 })).toBeNull();
  });
});
