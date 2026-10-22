import type { DesktopAbilities } from '../shared/abilities/desktop';
import type { DesktopWorkspaceBridge } from '../desktop/shared/workspace-contract';
import type { DesktopStorageBridge } from '../desktop/shared/storage-contract';
declare global {
  interface Window {
    dotWorkspace?: DesktopWorkspaceBridge;
    dotStorage?: DesktopStorageBridge;
    dotAbilities?: DesktopAbilities;
  }
}
