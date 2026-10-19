import type { DesktopWorkspaceBridge } from '../desktop/shared/workspace-contract';
declare global {
  interface Window {
    dotWorkspace?: DesktopWorkspaceBridge;
  }
}
