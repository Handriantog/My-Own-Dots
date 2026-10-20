import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import './editor.css';
import './desktop-chat.css';
import './workspace.css';
import './settings-page.css';
import { surfaceFromSearch } from './workspace-navigation';
import { watchSystemTheme } from './theme';
watchSystemTheme();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App surface={surfaceFromSearch(location.search)} />
  </React.StrictMode>,
);
