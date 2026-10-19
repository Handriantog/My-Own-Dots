import './recovery.css';
import type { DesktopWorkspaceBridge } from '../shared/workspace-contract.js';
const bridge = (window as unknown as { dotWorkspace: DesktopWorkspaceBridge })
  .dotWorkspace;
const status = document.querySelector<HTMLElement>('#status')!;
const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
async function action(callback: () => Promise<unknown>) {
  buttons.forEach((button) => (button.disabled = true));
  try {
    await callback();
  } catch (error) {
    status.textContent =
      error instanceof Error
        ? error.message
            .replace(/^Error invoking remote method '[^']+': Error: /, '')
            .slice(0, 500)
        : 'Could not complete that action. Check the configuration and try again.';
  } finally {
    buttons.forEach((button) => (button.disabled = false));
  }
}
bridge.onStatus((value) => {
  status.textContent = value.message;
});
void bridge.status().then((value) => {
  status.textContent = value.message;
});
document
  .querySelector('#retry')!
  .addEventListener('click', () => void action(() => bridge.retry()));
document
  .querySelector('#choose')!
  .addEventListener('click', () => void action(() => bridge.chooseWorkspace()));
document
  .querySelector<HTMLFormElement>('#configuration')!
  .addEventListener('submit', (event) => {
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
      status.textContent =
        'Configuration saved. Retry to connect. Externally managed services must be restarted in their launcher.';
    });
  });
