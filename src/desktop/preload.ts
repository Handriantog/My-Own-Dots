import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, PresentationFrame } from './shared/contracts.js';

const bridge: DesktopBridge = {
  onFrame(callback) {
    const listener = (
      _event: Electron.IpcRendererEvent,
      frame: PresentationFrame,
    ) => callback(frame);
    ipcRenderer.on('dot:frame', listener);
    return () => ipcRenderer.removeListener('dot:frame', listener);
  },
  ack: (sequence) => ipcRenderer.send('dot:ack', sequence),
  pointer: (input) => ipcRenderer.send('dot:pointer', input),
  ready: () => ipcRenderer.send('dot:ready'),
  reportError: (message) =>
    ipcRenderer.send('dot:error', String(message).slice(0, 400)),
};
contextBridge.exposeInMainWorld('dot', bridge);
