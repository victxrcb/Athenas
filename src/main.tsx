import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './themes.css';
import './tokens.css';
import './components.css';
import './shell.css';
import './home.css';
import './workspace.css';
import './tools.css';
import './orchestrator.css';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>,
);
