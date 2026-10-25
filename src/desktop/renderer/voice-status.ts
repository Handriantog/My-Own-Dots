import type { Point } from '../shared/contracts.js';
import type { CompanionVoiceState } from '../shared/voice-contract.js';

export function voiceStatusLayout(
  state: CompanionVoiceState | undefined,
  root: Point,
) {
  const label =
    state === 'connecting'
      ? 'Connecting…'
      : state === 'listening'
        ? 'Listening'
        : state === 'thinking'
          ? 'Thinking'
          : null;
  if (!label) return null;
  // The companion surface is 320px square. Prefer the right; at the display
  // edge use the available side, keeping both Dot and the label on screen.
  const width = state === 'connecting' ? 96 : 88;
  const gap = state === 'connecting' ? 56 : 60;
  const side = root.x + gap + width <= 312 ? 'right' : 'left';
  return {
    label,
    side,
    width,
    x: Math.max(
      8,
      Math.min(
        312 - width,
        side === 'right' ? root.x + gap : root.x - gap - width,
      ),
    ),
    y: Math.max(8, Math.min(282, root.y - 98)),
  };
}

export class VoiceStatusBubble {
  readonly element = document.createElement('div');

  constructor() {
    this.element.className = 'voice-status';
    this.element.setAttribute('role', 'status');
    this.element.setAttribute('aria-live', 'polite');
    this.element.hidden = true;
  }

  update(
    state: CompanionVoiceState | undefined,
    root: Point,
    visible: boolean,
  ) {
    const bubble = visible ? voiceStatusLayout(state, root) : null;
    this.element.hidden = !bubble;
    if (!bubble) {
      if (this.element.textContent) this.element.textContent = '';
      return;
    }
    if (this.element.textContent !== bubble.label)
      this.element.textContent = bubble.label;
    this.element.dataset.side = bubble.side;
    this.element.style.width = `${bubble.width}px`;
    this.element.style.transform = `translate(${bubble.x}px, ${bubble.y}px)`;
  }
}
