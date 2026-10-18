import { describe, expect, it } from 'vitest';
import { voiceStatusLayout } from '../../src/desktop/renderer/voice-status.js';

describe('voice status bubble', () => {
  it('labels listening and thinking to the right of Dot', () => {
    for (const [state, label] of [
      ['listening', 'Listening'],
      ['thinking', 'Thinking'],
    ] as const) {
      const bubble = voiceStatusLayout(state, { x: 160, y: 200 });
      expect(bubble).toMatchObject({ label, side: 'right' });
      expect(bubble!.x).toBeGreaterThan(160 + 56);
      expect(bubble!.x + 88).toBeLessThanOrEqual(320);
    }
  });
  it('uses the left side at the screen edge without moving Dot or clipping the label', () => {
    const root = { x: 268, y: 320 };
    const bubble = voiceStatusLayout('listening', root)!;
    expect(bubble.side).toBe('left');
    expect(bubble.x + 88).toBeLessThan(root.x - 56);
    expect(bubble.y + 30).toBeLessThanOrEqual(320);
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
