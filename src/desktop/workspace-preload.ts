import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopWorkspaceBridge,
  WorkspaceDestination,
  WorkspaceCommand,
} from './shared/workspace-contract.js';
import type { DesktopStorageBridge } from './shared/storage-contract.js';

if (
  process.isMainFrame &&
  location.protocol === 'dots:' &&
  ipcRenderer.sendSync('dot:workspace:context') === true
) {
  const navigation = new Set<(value: WorkspaceDestination) => void>();
  const commands = new Set<(value: WorkspaceCommand) => void>();
  let pendingNavigation: WorkspaceDestination | undefined;
  const pendingCommands: WorkspaceCommand[] = [];
  ipcRenderer.on(
    'dot:workspace:navigate',
    (_event, value: WorkspaceDestination) => {
      if (!navigation.size) pendingNavigation = value;
      else for (const callback of navigation) callback(value);
    },
  );
  ipcRenderer.on('dot:workspace:command', (_event, value: WorkspaceCommand) => {
    if (!commands.size) pendingCommands.push(value);
    else for (const callback of commands) callback(value);
  });
  const bridge: DesktopWorkspaceBridge = {
    openWorkspace: (destination = {}) =>
      ipcRenderer.invoke('dot:workspace:open', destination),
    status: () => ipcRenderer.invoke('dot:workspace:status'),
    retry: () => ipcRenderer.invoke('dot:workspace:retry'),
    chooseWorkspace: () => {
      if (!navigator.userActivation?.isActive)
        return Promise.reject(new Error('Use the Choose workspace button.'));
      return ipcRenderer.invoke('dot:workspace:choose');
    },
    configure: (values) =>
      ipcRenderer.invoke('dot:workspace:configure', values),
    openPreferences: () => ipcRenderer.invoke('dot:workspace:preferences'),
    openBackendSettings: () =>
      ipcRenderer.invoke('dot:workspace:backend-settings'),
    onNavigate(callback) {
      navigation.add(callback);
      if (pendingNavigation) {
        const value = pendingNavigation;
        pendingNavigation = undefined;
        callback(value);
      }
      return () => {
        navigation.delete(callback);
      };
    },
    onCommand(callback) {
      commands.add(callback);
      for (const value of pendingCommands.splice(0)) callback(value);
      return () => {
        commands.delete(callback);
      };
    },
    onStatus(callback) {
      const listener = (
        _event: unknown,
        value: Parameters<typeof callback>[0],
      ) => callback(value);
      ipcRenderer.on('dot:workspace:status', listener);
      return () => {
        ipcRenderer.removeListener('dot:workspace:status', listener);
      };
    },
  };
  contextBridge.exposeInMainWorld('dotWorkspace', bridge);
  const userAction = (channel: string, value?: unknown) => {
    if (!navigator.userActivation?.isActive)
      return Promise.reject(
        new Error('Use the storage controls in the workspace.'),
      );
    return ipcRenderer.invoke(`dot:storage:${channel}`, value);
  };
  const storage: DesktopStorageBridge = {
    status: () => ipcRenderer.invoke('dot:storage:status'),
    chooseBackupDirectory: () => userAction('chooseBackupDirectory'),
    backupNow: (value) => userAction('backupNow', value),
    setAutomatic: (value) => userAction('setAutomatic', value),
    previewRestore: (value) => userAction('previewRestore', value),
    previewMigration: (value) => userAction('previewMigration', value),
    migrate: (value) => userAction('migrate', value),
    restore: (value) => userAction('restore', value),
    cancel: (id) => userAction('cancel', id),
    onStatus(callback) {
      const listener = (
        _event: unknown,
        value: Parameters<typeof callback>[0],
      ) => callback(value);
      ipcRenderer.on('dot:storage:status', listener);
      return () => {
        ipcRenderer.removeListener('dot:storage:status', listener);
      };
    },
  };
  contextBridge.exposeInMainWorld('dotStorage', storage);
}
