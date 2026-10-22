import { ipcRenderer } from 'electron';
import {
  desktopAbilityMethods,
  type DesktopAbilities,
  type DesktopAbilityMethod,
} from '../shared/abilities/desktop.js';
const reads = new Set<DesktopAbilityMethod>([
  'list',
  'account',
  'results',
  'recent',
]);
export function createAbilitiesPreload(): DesktopAbilities {
  return Object.fromEntries(
    (Object.keys(desktopAbilityMethods) as DesktopAbilityMethod[]).map(
      (method) => [
        method,
        (input: unknown) => {
          if (!reads.has(method) && !navigator.userActivation?.isActive)
            return Promise.resolve({ ok: false, code: 'permission_denied' });
          return ipcRenderer.invoke(`dot:abilities:${method}`, input);
        },
      ],
    ),
  ) as DesktopAbilities;
}
