import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dotMenu', {
  choose: (action: 'chat' | 'talk' | 'hide' | 'dismiss') =>
    ipcRenderer.send('dot:menu:action', action),
});
