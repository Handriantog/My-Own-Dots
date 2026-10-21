import { useMemo, useSyncExternalStore } from 'react';
import {
  accessoriesFromKey,
  DEFAULT_ACCESSORIES_KEY,
} from '../desktop/shared/accessories';

export function companionColorFromSearch(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (
    params.get('desktop') !== '1' &&
    !['workspace', 'companion'].includes(params.get('surface') ?? '')
  )
    return undefined;
  const color = params.get('dotColor') ?? '';
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '#45a7ff';
}

export function useCompanionColor(): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () =>
      typeof location === 'undefined'
        ? undefined
        : companionColorFromSearch(location.search),
    () => undefined,
  );
}

export function useCompanionAccessories() {
  const key = useSyncExternalStore(
    subscribe,
    () =>
      typeof location === 'undefined'
        ? DEFAULT_ACCESSORIES_KEY
        : (new URLSearchParams(location.search).get('dotAccessories') ??
          DEFAULT_ACCESSORIES_KEY),
    () => DEFAULT_ACCESSORIES_KEY,
  );
  return useMemo(() => accessoriesFromKey(key), [key]);
}

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
function subscribe(update: () => void) {
  if (typeof window === 'undefined') return () => {};
  const target = window;
  if (!listeners.size) target.addEventListener('dot:appearance', notify);
  listeners.add(update);
  return () => {
    listeners.delete(update);
    if (!listeners.size) target.removeEventListener('dot:appearance', notify);
  };
}
