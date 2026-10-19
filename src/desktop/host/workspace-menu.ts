import { Menu } from 'electron';
import type { WorkspaceWindow } from './workspace-window.js';

export function installWorkspaceMenu(
  workspace: WorkspaceWindow,
  openPreferences: () => void,
): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'My Own Dots',
        submenu: [
          { role: 'about' },
          {
            label: 'Settings…',
            accelerator: 'CmdOrCtrl+,',
            click: () => void workspace.command('settings'),
          },
          {
            label: 'Workspace Setup…',
            click: () => void workspace.openBackendSettings(),
          },
          { label: 'Customize Companion…', click: openPreferences },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [
          { label: 'Open Workspace', click: () => void workspace.open() },
          {
            label: 'New Chat',
            accelerator: 'CmdOrCtrl+N',
            click: () => void workspace.command('new-chat'),
          },
          { role: 'close' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          {
            label: 'Quick Navigation',
            accelerator: 'CmdOrCtrl+K',
            click: () => void workspace.command('quick-navigation'),
          },
          {
            label: 'Toggle Sidebar',
            accelerator: 'CmdOrCtrl+Shift+B',
            click: () => void workspace.command('toggle-sidebar'),
          },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}
