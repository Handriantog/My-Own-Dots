import { contextBridge, ipcRenderer } from 'electron';
import {
  approvalPage,
  type DesktopApprovalBridge,
} from './shared/approval-contract.js';
import type { DesktopFolderBridge } from './shared/folder-contract.js';

if (
  process.isMainFrame &&
  location.href === approvalPage &&
  ipcRenderer.sendSync('dot:approval:context') === true
) {
  const bridge: DesktopApprovalBridge = {
    state: () => ipcRenderer.invoke('dot:approval:state'),
    dismiss: () => ipcRenderer.invoke('dot:approval:dismiss'),
    next: () => ipcRenderer.invoke('dot:approval:next'),
    onState(callback) {
      const listener = (
        _event: unknown,
        state: Parameters<typeof callback>[0],
      ) => callback(state);
      ipcRenderer.on('dot:approval:changed', listener);
      return () => {
        ipcRenderer.removeListener('dot:approval:changed', listener);
      };
    },
  };
  const folders: DesktopFolderBridge = {
    choose: () => {
      if (!navigator.userActivation?.isActive)
        return Promise.reject(
          new Error('Choose a folder using the folder button.'),
        );
      return ipcRenderer.invoke('dot:approval-folders:choose');
    },
  };
  contextBridge.exposeInMainWorld('dotApproval', bridge);
  contextBridge.exposeInMainWorld('dotFolders', folders);
}
