import './workspace-preload.js';
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopVoiceBridge } from './shared/voice-contract.js';
import type { DesktopFolderBridge } from './shared/folder-contract.js';

const nativeWorkspace =
  location.protocol === 'dots:' &&
  location.hostname === 'workspace' &&
  location.pathname === '/' &&
  ['workspace', 'companion'].includes(
    new URL(location.href).searchParams.get('surface') || '',
  );
const mainWorkspace =
  nativeWorkspace &&
  new URL(location.href).searchParams.get('surface') === 'workspace';
const voiceChannel = mainWorkspace ? 'dot:workspace-voice' : 'dot:voice';
const folderChannel = mainWorkspace ? 'dot:workspace-folders' : 'dot:folders';

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
  (/^https?:$/.test(location.protocol) || nativeWorkspace) &&
  ipcRenderer.sendSync(`${voiceChannel}:context`) === true
) {
  let pendingTalk = false;
  let pendingChat = false;
  const chatListeners = new Set<() => void>();
  ipcRenderer.on(`${voiceChannel}:chat`, () => {
    if (!chatListeners.size) pendingChat = true;
    else for (const listener of chatListeners) listener();
  });
  let windowless = false;
  const talkListeners = new Set<() => void>();
  ipcRenderer.on(`${voiceChannel}:talk`, (_event, background: unknown) => {
    pendingChat = false;
    windowless = background === true;
    if (!talkListeners.size) pendingTalk = true;
    else for (const listener of talkListeners) listener();
  });
  ipcRenderer.on(`${voiceChannel}:stop`, () => {
    pendingTalk = false;
    windowless = false;
  });
  const bridge: DesktopVoiceBridge = {
    onChat(callback) {
      chatListeners.add(callback);
      if (pendingChat) {
        pendingChat = false;
        callback();
      }
      return () => {
        chatListeners.delete(callback);
      };
    },
    setReady: (ready) =>
      ipcRenderer.invoke(`${voiceChannel}:ready`, ready).catch(() => {}),
    activate: () => ipcRenderer.invoke(`${voiceChannel}:activate`),
    cancelTalk: () => {
      void ipcRenderer.invoke(`${voiceChannel}:cancel-talk`).catch(() => {});
    },
    cancelStart: () => ipcRenderer.invoke(`${voiceChannel}:cancel-start`),
    begin: async (callId, quality, dotId) => {
      await ipcRenderer.invoke(
        `${voiceChannel}:begin`,
        quality || dotId
          ? { callId, quality: quality ?? 'medium', dotId }
          : callId,
      );
      if (quality === 'basic') windowless = false;
    },
    end: (callId) => {
      windowless = false;
      return ipcRenderer.invoke(`${voiceChannel}:end`, callId);
    },
    isWindowless: () => windowless,
    playback: (callId, active) =>
      ipcRenderer.invoke(`${voiceChannel}:playback`, { callId, active }),
    phase: (callId, phase) =>
      ipcRenderer.invoke(`${voiceChannel}:phase`, { callId, phase }),
    reviewFolders: (callId) =>
      ipcRenderer.invoke(`${voiceChannel}:review-folders`, callId),
    reportError: (message) => {
      void ipcRenderer
        .invoke(`${voiceChannel}:error`, String(message).slice(0, 500))
        .catch(() => {});
    },
    onStop(callback) {
      const listener = (_event: unknown, reason: string) => callback(reason);
      ipcRenderer.on(`${voiceChannel}:stop`, listener);
      return () => {
        ipcRenderer.removeListener(`${voiceChannel}:stop`, listener);
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
  (/^https?:$/.test(location.protocol) || nativeWorkspace) &&
  ipcRenderer.sendSync(`${folderChannel}:context`) === true
) {
  const bridge: DesktopFolderBridge = {
    choose: () => {
      // Check before any await: only a fresh UI gesture may open native chrome.
      if (!navigator.userActivation?.isActive)
        return Promise.reject(
          new Error('Choose a folder using the folder button.'),
        );
      return ipcRenderer.invoke(`${folderChannel}:choose`);
    },
  };
  contextBridge.exposeInMainWorld('dotFolders', bridge);
}
