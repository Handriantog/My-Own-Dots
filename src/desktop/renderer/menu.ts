import './menu.css';
import type { CompanionMenuLayout } from '../host/interaction.js';

declare global {
  interface Window {
    dotMenu: { choose(action: 'chat' | 'talk' | 'hide' | 'dismiss'): void };
  }
}
const params = new URLSearchParams(location.search);
const layout = JSON.parse(params.get('layout')!) as CompanionMenuLayout;
const voiceReady = params.get('voice') === '1';
const talk = document.querySelector<HTMLButtonElement>('[data-action="talk"]')!;
talk.setAttribute('aria-label', 'Talk');
talk.querySelector('.hint')!.textContent = voiceReady ? '' : 'Connect';
document.body.dataset.still = String(params.get('still') === '1');
const buttons = [
  ...document.querySelectorAll<HTMLButtonElement>('.cloud-button'),
];
buttons.forEach((button) => {
  const rect = layout.items[button.dataset.action as keyof typeof layout.items];
  button.style.left = `${rect.x - layout.bounds.x}px`;
  button.style.top = `${rect.y - layout.bounds.y}px`;
  button.style.width = `${rect.width}px`;
  button.style.height = `${rect.height}px`;
  button.dataset.mirrored = String(rect.x + rect.width / 2 < layout.root.x);
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'chat' || action === 'hide' || action === 'talk')
      window.dotMenu.choose(action);
  });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.dotMenu.choose('dismiss');
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) %
            buttons.length;
    buttons[next].focus();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!(event.target as Element).closest('button'))
    window.dotMenu.choose('dismiss');
});
buttons[0].focus({ preventScroll: true });
