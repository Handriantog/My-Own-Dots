import './chat.css';

declare global {
  interface Window {
    dotChat: {
      status(): Promise<{ address: string; error: string }>;
      connect(address: string): Promise<{ error: string }>;
    };
  }
}
const address = document.querySelector<HTMLInputElement>('#address')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const button = document.querySelector<HTMLButtonElement>('button')!;
try {
  const state = await window.dotChat.status();
  address.value = state.address;
  status.textContent = state.error || 'Connecting to your workspace…';
  document.querySelector('form')!.hidden = !state.error;
} catch {
  status.textContent =
    'Could not read the workspace connection. Close this window and try again.';
}
document.querySelector('form')!.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = 'Connecting to your workspace…';
  try {
    const result = await window.dotChat.connect(address.value);
    if (result.error) {
      status.textContent = result.error;
      button.disabled = false;
    }
  } catch {
    status.textContent = 'Could not connect. Please try again.';
    button.disabled = false;
  }
});
