import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopVoiceBridge } from './shared/voice-contract.js';
import type { DesktopFolderBridge } from './shared/folder-contract.js';

// Connection configuration remains exclusive to the bundled connection page.
if (location.href === 'dots://app/chat.html') {
  contextBridge.exposeInMainWorld('dotChat', {
    status: () => ipcRenderer.invoke('dot:chat:status'),
    connect: (address: string) =>
      ipcRenderer.invoke('dot:chat:connect', address),
  });
}

// Main verifies the exact configured workspace and frame before exposing this
// intentionally narrow boundary. No generic IPC, credentials, or audio cross it.
if (
  process.isMainFrame &&
  /^https?:$/.test(location.protocol) &&
  ipcRenderer.sendSync('dot:voice:context') === true
) {
  let pendingTalk = false;
  let windowless = false;
  const talkListeners = new Set<() => void>();
  ipcRenderer.on('dot:voice:talk', (_event, background: unknown) => {
    windowless = background === true;
    if (!talkListeners.size) pendingTalk = true;
    else for (const listener of talkListeners) listener();
  });
  ipcRenderer.on('dot:voice:stop', () => {
    pendingTalk = false;
    windowless = false;
  });
  const bridge: DesktopVoiceBridge = {
    setReady: (ready) =>
      ipcRenderer.invoke('dot:voice:ready', ready).catch(() => {}),
    activate: () => ipcRenderer.invoke('dot:voice:activate'),
    cancelTalk: () => {
      void ipcRenderer.invoke('dot:voice:cancel-talk').catch(() => {});
    },
    cancelStart: () => ipcRenderer.invoke('dot:voice:cancel-start'),
    begin: (callId) => ipcRenderer.invoke('dot:voice:begin', callId),
    end: (callId) => {
      windowless = false;
      return ipcRenderer.invoke('dot:voice:end', callId);
    },
    isWindowless: () => windowless,
    phase: (callId, phase) =>
      ipcRenderer.invoke('dot:voice:phase', { callId, phase }),
    reportError: (message) => {
      void ipcRenderer
        .invoke('dot:voice:error', String(message).slice(0, 500))
        .catch(() => {});
    },
    onStop(callback) {
      const listener = (_event: unknown, reason: string) => callback(reason);
      ipcRenderer.on('dot:voice:stop', listener);
      return () => {
        ipcRenderer.removeListener('dot:voice:stop', listener);
      };
    },
    onTalk(callback) {
      talkListeners.add(callback);
      if (pendingTalk) {
        pendingTalk = false;
        callback();
      }
      return () => {
        talkListeners.delete(callback);
      };
    },
  };
  contextBridge.exposeInMainWorld('dotVoice', bridge);
}

if (
  process.isMainFrame &&
  /^https?:$/.test(location.protocol) &&
  ipcRenderer.sendSync('dot:folders:context') === true
) {
  const bridge: DesktopFolderBridge = {
    choose: () => {
      // Check before any await: only a fresh UI gesture may open native chrome.
      if (!navigator.userActivation?.isActive)
        return Promise.reject(
          new Error('Choose a folder using the folder button.'),
        );
      return ipcRenderer.invoke('dot:folders:choose');
    },
  };
  contextBridge.exposeInMainWorld('dotFolders', bridge);
}
