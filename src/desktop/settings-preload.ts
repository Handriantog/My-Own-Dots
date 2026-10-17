import { contextBridge, ipcRenderer } from 'electron';
import type { Preferences } from './shared/contracts.js';

contextBridge.exposeInMainWorld('dotSettings', {
  read: (): Promise<Preferences> => ipcRenderer.invoke('dot:preferences:read'),
  update: (change: Partial<Preferences>): Promise<Preferences> =>
    ipcRenderer.invoke('dot:preferences:update', change),
});
