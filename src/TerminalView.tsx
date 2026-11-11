import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { confirmAction } from './confirm';
import { displayPath } from './path';
import { terminalPalette } from './themes';
import { useAppStore, type SessionInfo } from './store';

type OutputEvent = { id: string; sequence: number; data: string };

function decode(data: string): Uint8Array {
  const binary = atob(data);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function TerminalView({ session, onStatus }: { session: SessionInfo; onStatus: (session: SessionInfo) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const search = useRef<SearchAddon | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fontSize = useAppStore((state) => state.preferences.fontSize);
  const pasteImage = async (event: React.ClipboardEvent<HTMLDivElement>) => {
    const image = [...event.clipboardData.items].find((item) => item.type.startsWith('image/'))?.getAsFile();
    if (!image) return;
    event.preventDefault();
    try {
      const bitmap = await createImageBitmap(image);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close();
      const data = canvas.toDataURL('image/png').split(',')[1];
      const path = await invoke<string>('terminal_save_image', { data });
      await invoke('terminal_write', { id: session.id, data: `"${path}"` });
    } catch (reason) { setError(String(reason)); }
  };

  useEffect(() => {
    if (!host.current) return;
    const terminal = new Terminal({
      allowProposedApi: true, cursorBlink: true, fontFamily: "'Cascadia Mono','JetBrains Mono',Consolas,monospace", fontSize, scrollback: 10000,
      theme: terminalPalette()
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(new Unicode11Addon());
    terminal.loadAddon(new WebLinksAddon());
    try { terminal.unicode.activeVersion = '11'; } catch { /* keep default width table */ }
    search.current = searchAddon;
    const retheme = () => { terminal.options.theme = terminalPalette(); };
    window.addEventListener('athenas-theme', retheme);
    terminal.open(host.current);
    const loadCanvas = () => { try { terminal.loadAddon(new CanvasAddon()); } catch { /* The DOM renderer remains available. */ } };
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => { webgl.dispose(); loadCanvas(); });
      terminal.loadAddon(webgl);
    } catch { loadCanvas(); }
    const safeFit = () => { try { fit.fit(); } catch { /* host not measurable yet */ } };
    safeFit();
    const outputQueue: OutputEvent[] = [];
    let replaying = true;
    let lastSequence = 0;
    const writeChunk = (event: OutputEvent) => {
      if (event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      terminal.write(decode(event.data));
    };
    const outputListener = listen<OutputEvent>('terminal-output', (event) => {
      if (event.payload.id !== session.id) return;
      if (replaying) outputQueue.push(event.payload);
      else writeChunk(event.payload);
    });
    const statusListener = listen<SessionInfo>('terminal-status', (event) => {
      if (event.payload.id === session.id) onStatus(event.payload);
    });
    void invoke<string>('terminal_scrollback', { id: session.id }).then((content) => {
      try { terminal.write(decode(content)); } catch (reason) { setError(String(reason)); }
      replaying = false;
      outputQueue.sort((a, b) => a.sequence - b.sequence).forEach(writeChunk);
    }).catch((reason) => setError(String(reason)));
    const input = terminal.onData((data) => { void invoke('terminal_write', { id: session.id, data }).catch((reason) => setError(String(reason))); });
    const resize = new ResizeObserver(() => {
      safeFit();
      void invoke('terminal_resize', { id: session.id, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
    });
    resize.observe(host.current);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.ctrlKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true); return false; }
      return true;
    });
    terminal.focus();
    return () => { window.removeEventListener('athenas-theme', retheme); resize.disconnect(); input.dispose(); void outputListener.then((unlisten) => unlisten()); void statusListener.then((unlisten) => unlisten()); terminal.dispose(); search.current = null; };
  }, [session.id, onStatus, fontSize]);

  return <div className="terminal-view">
    <div className="terminal-toolbar"><span>{session.agent} · {displayPath(session.folder)}</span><div><span className={`terminal-status ${session.status}`}>{session.status}</span><button onClick={() => setSearchOpen(!searchOpen)}>Buscar <kbd>Ctrl F</kbd></button><button onClick={() => { void confirmAction('Encerrar este processo?').then((ok) => ok ? invoke('terminal_stop', { id: session.id }) : undefined).catch((reason) => setError(String(reason))); }}>Encerrar</button></div></div>
    {searchOpen && <div className="terminal-search"><input autoFocus aria-label="Buscar no terminal" placeholder="Buscar no terminal" value={query} onChange={(event) => { setQuery(event.target.value); search.current?.findNext(event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter') search.current?.findNext(query); if (event.key === 'Escape') setSearchOpen(false); }} /><button onClick={() => setSearchOpen(false)}>Fechar</button></div>}
    <div ref={host} className="terminal-canvas" onPaste={(event) => { void pasteImage(event); }} />
    {error && <div className="terminal-error" role="alert">{error}</div>}
  </div>;
}
