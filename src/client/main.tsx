import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import './editor.css';
import './desktop-chat.css';
import { watchSystemTheme } from './theme';
watchSystemTheme();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App
      desktop={new URLSearchParams(location.search).get('desktop') === '1'}
    />
  </React.StrictMode>,
);
