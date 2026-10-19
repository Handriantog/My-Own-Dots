import './recovery.css';
import { recoveryView, watchWorkspaceStatus } from './recovery-state.js';
import type {
  DesktopWorkspaceBridge,
  WorkspaceStatus,
} from '../shared/workspace-contract.js';
const bridge = (window as unknown as { dotWorkspace: DesktopWorkspaceBridge })
  .dotWorkspace;
const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const setup = location.hash === '#setup';
const panel = element<HTMLDetailsElement>('setup-panel');
const scene = element('scene');
const mascot = element<HTMLButtonElement>('mascot');
const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
const steps = [...document.querySelectorAll<HTMLElement>('[data-step]')];
const motion = matchMedia('(prefers-reduced-motion: reduce)');
let status: WorkspaceStatus = {
  phase: 'idle',
  message: 'Preparing your local workspace…',
};
let started = performance.now();
let busy = false;
let disposed = false;
let greetingTimer: ReturnType<typeof setTimeout> | undefined;
let pointerFrame = 0;
let pointerX = 0;
let pointerY = 0;
const tips = [
  ['⌘ K', 'Jump to a Dot, Space, or conversation'],
  ['⌘ N', 'Start a fresh conversation'],
  ['⌘ ,', 'Make this workspace yours'],
];
let shownTip = 0;
function text(id: string, value: string) {
  const node = element(id);
  if (node.textContent !== value) node.textContent = value;
}
function render() {
  if (disposed) return;
  const elapsedMs = performance.now() - started;
  const view = recoveryView(status, { setup, elapsedMs });
  document.body.dataset.state = view.mode;
  document.body.dataset.phase = status.phase;
  document.body.dataset.warning = String(view.warning);
  document.body.dataset.loading = String(view.loading);
  document.body.dataset.actions = String(view.showActions || panel.open);
  text('eyebrow', view.eyebrow);
  text('headline', view.headline);
  text('description', view.description);
  text('status', view.status);
  text(
    'status-detail',
    status.phase === 'idle' ? 'Preparing your local workspace…' : view.detail,
  );
  element('recovery-actions').hidden = !view.showActions && !panel.open;
  element<HTMLButtonElement>('retry').textContent =
    status.phase === 'ready' || status.phase === 'stopped'
      ? 'Open workspace ↗'
      : 'Try again ↗';
  for (const [index, step] of steps.entries()) {
    step.dataset.active = String(index === view.activeStep);
    step.dataset.complete = String(view.activeStep > index);
    if (index === view.activeStep) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  }
  buttons.forEach((button) => {
    button.disabled = busy;
  });
  if (!setup && view.loading && !motion.matches) {
    const nextTip = Math.floor(elapsedMs / 8000) % tips.length;
    if (nextTip !== shownTip) {
      const [key, description] = tips[nextTip];
      const tip = element('tip');
      const shortcut = document.createElement('kbd');
      shortcut.textContent = key;
      tip.replaceChildren(shortcut, document.createTextNode(` ${description}`));
      shownTip = nextTip;
    }
  }
}
function applyStatus(next: WorkspaceStatus) {
  if (
    !['idle', 'starting'].includes(status.phase) &&
    ['idle', 'starting'].includes(next.phase)
  )
    started = performance.now();
  status = next;
  render();
}
async function action(callback: () => Promise<unknown>) {
  if (busy || disposed) return;
  busy = true;
  render();
  try {
    await callback();
  } catch (error) {
    applyStatus({
      phase: 'error',
      message:
        error instanceof Error
          ? error.message
              .replace(/^Error invoking remote method '[^']+': Error: /, '')
              .slice(0, 500)
          : 'Could not complete that action. Check workspace setup and try again.',
    });
  } finally {
    busy = false;
    render();
  }
}
document.body.dataset.view = setup ? 'setup' : 'startup';
panel.open = setup;
panel.addEventListener('toggle', render);
element('retry').addEventListener(
  'click',
  () => void action(() => bridge.retry()),
);
element('choose').addEventListener(
  'click',
  () => void action(() => bridge.chooseWorkspace()),
);
element<HTMLFormElement>('configuration').addEventListener(
  'submit',
  (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const values = Object.fromEntries(
      [...new FormData(form)].filter(
        ([, value]) => typeof value === 'string' && value.length,
      ),
    ) as Record<string, string>;
    void action(async () => {
      await bridge.configure(values);
      form.reset();
      applyStatus({
        phase: 'stopped',
        message:
          'Configuration saved. Open the workspace to reconnect. If another launcher manages the backend, restart it there first.',
      });
    });
  },
);
mascot.addEventListener('click', () => {
  if (greetingTimer) return;
  scene.dataset.greeting = 'true';
  greetingTimer = setTimeout(() => {
    delete scene.dataset.greeting;
    greetingTimer = undefined;
  }, 1800);
});
function resetPointer() {
  if (pointerFrame) cancelAnimationFrame(pointerFrame);
  pointerFrame = 0;
  scene.style.removeProperty('--look-x');
  scene.style.removeProperty('--look-y');
}
function point(event: PointerEvent) {
  if (
    motion.matches ||
    setup ||
    document.hidden ||
    event.pointerType === 'touch'
  )
    return;
  pointerX = Math.max(-6, Math.min(6, (event.clientX / innerWidth - 0.5) * 12));
  pointerY = Math.max(-4, Math.min(4, (event.clientY / innerHeight - 0.5) * 8));
  if (!pointerFrame)
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = 0;
      scene.style.setProperty('--look-x', `${pointerX}px`);
      scene.style.setProperty('--look-y', `${pointerY}px`);
    });
}
function visibility() {
  document.body.dataset.hidden = String(document.hidden);
  if (document.hidden) resetPointer();
  else render();
}
document.addEventListener('pointermove', point, { passive: true });
document.addEventListener('pointerleave', resetPointer);
document.addEventListener('visibilitychange', visibility);
motion.addEventListener('change', resetPointer);
render();
visibility();
const unsubscribe = watchWorkspaceStatus(bridge, applyStatus);
const timer = setInterval(() => {
  if (!document.hidden) render();
}, 1000);
window.addEventListener(
  'pagehide',
  () => {
    disposed = true;
    clearInterval(timer);
    if (greetingTimer) clearTimeout(greetingTimer);
    resetPointer();
    unsubscribe();
    document.removeEventListener('pointermove', point);
    document.removeEventListener('pointerleave', resetPointer);
    document.removeEventListener('visibilitychange', visibility);
    motion.removeEventListener('change', resetPointer);
  },
  { once: true },
);
