import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FolderApprovalApp } from './FolderApprovalApp';
import './style.css';
import './editor.css';
import './desktop-chat.css';
import './workspace.css';
import './settings-page.css';
import './dot-configuration.css';
import './folder-approval.css';
import './chat.css';
import './chat-list.css';
import { surfaceFromSearch } from './workspace-navigation';
import { watchSystemTheme } from './theme';
watchSystemTheme();
if (new URLSearchParams(location.search).get('surface') === 'approval')
  document.title = 'Dot folder approval';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).get('surface') === 'approval' &&
    window.dotApproval ? (
      <FolderApprovalApp />
    ) : (
      <App surface={surfaceFromSearch(location.search)} />
    )}
  </React.StrictMode>,
);
