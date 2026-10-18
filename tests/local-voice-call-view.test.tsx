import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { CallView, type VoiceControls } from '../src/client/CallView';
import type { Dot } from '../src/shared/types';
vi.mock('../src/client/Mascot', () => ({
  Mascot: ({ companionColor }: { companionColor?: string }) =>
    createElement('span', { 'data-color': companionColor }),
}));
const dot = { id: 'dot', name: 'Dot' } as Dot;
const voice: VoiceControls = {
  status: 'active',
  phase: 'approval',
  error: '',
  muted: false,
  speakerMuted: false,
  startedAt: Date.now(),
  caption: '',
  userCaption: 'Save the page',
  start: async () => {},
  end: async () => {},
  toggleMute: () => {},
  toggleSpeaker: () => {},
  interrupt: () => {},
};
it('exposes the existing chat for approval while retaining visible call controls and chosen companion', () => {
  const html = renderToStaticMarkup(
    createElement(CallView, { dot, voice, companionColor: '#abcdef' }),
  );
  expect(html).toContain('call-view minimized approval');
  expect(html).toContain('Review the action in chat');
  expect(html).toContain('End voice call');
  expect(html).toContain('Interrupt response');
  expect(html).toContain('data-color="#abcdef"');
});

it('shows nonfatal recognition guidance alongside active mute and end controls', () => {
  const html = renderToStaticMarkup(
    createElement(CallView, {
      dot,
      voice: {
        ...voice,
        phase: 'listening',
        notice: 'Please try speaking again.',
      },
    }),
  );
  expect(html).toContain('role="status">Please try speaking again.');
  expect(html).toContain('Mute microphone');
  expect(html).toContain('End voice call');
  expect(html).not.toContain('role="alert"');
});
