import { useSyncExternalStore } from 'react';

export function companionColorFromSearch(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (params.get('desktop') !== '1') return undefined;
  const color = params.get('dotColor') ?? '';
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '#45a7ff';
}

export function useCompanionColor(desktop: boolean): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (desktop ? companionColorFromSearch(location.search) : undefined),
    () => undefined,
  );
}

function subscribe(update: () => void) {
  window.addEventListener('dot:appearance', update);
  return () => window.removeEventListener('dot:appearance', update);
}
