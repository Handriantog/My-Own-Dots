import type { DesktopWorkspaceBridge } from '../desktop/shared/workspace-contract';
import type { DesktopStorageBridge } from '../desktop/shared/storage-contract';
declare global {
  interface Window {
    dotWorkspace?: DesktopWorkspaceBridge;
    dotStorage?: DesktopStorageBridge;
  }
}
