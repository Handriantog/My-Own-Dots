import { contextBridge, ipcRenderer } from 'electron';
import type { Preferences } from './shared/contracts.js';

contextBridge.exposeInMainWorld('dotSettings', {
  read: (): Promise<Preferences & { dotId: string; dotName: string }> =>
    ipcRenderer.invoke('dot:preferences:read'),
  update: (change: Partial<Preferences>): Promise<Preferences> =>
    ipcRenderer.invoke('dot:preferences:update', change),
  shortcutStatus: (): Promise<string> =>
    ipcRenderer.invoke('dot:preferences:shortcut-status'),
  captureShortcut: (active: boolean): Promise<void> =>
    ipcRenderer.invoke('dot:preferences:capture-shortcut', active),
  onShortcutCaptureReset(callback: () => void): () => void {
    const listener = () => callback();
    ipcRenderer.on('dot:preferences:capture-reset', listener);
    return () =>
      ipcRenderer.removeListener('dot:preferences:capture-reset', listener);
  },
});
