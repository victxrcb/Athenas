import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/cinzel/latin-600.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import './styles.css';
import './orchestrator.css';
import './permissions.css';
import './settings.css';
import './panel-actions.css';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
