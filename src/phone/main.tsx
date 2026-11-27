/** Entry of the phone page (`mobile.html`), served by the desktop app. It never talks to Tauri. */
import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '../themes.css';
import '../tokens.css';
import './phone.css';
import { PhoneApp } from './PhoneApp';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><PhoneApp /></React.StrictMode>);
