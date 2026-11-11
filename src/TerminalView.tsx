import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import type { SessionInfo } from './store';

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
      cursorBlink: true, fontFamily: 'JetBrains Mono, monospace', fontSize: 13, scrollback: 10000,
      theme: { background: '#0b0b0d', foreground: '#d8d2c4', cursor: '#8b1e2d', selectionBackground: '#8b1e2d59',
        black: '#17171a', red: '#a74452', green: '#668d6a', yellow: '#ae9258', blue: '#6a7fa0', magenta: '#937096', cyan: '#6b9294', white: '#d8d2c4',
        brightBlack: '#5a5750', brightRed: '#c25a68', brightGreen: '#85ab89', brightYellow: '#c2a96f', brightBlue: '#8ea2bd', brightMagenta: '#aa89ae', brightCyan: '#87adae', brightWhite: '#f1ede4' }
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = '11';
    search.current = searchAddon;
    terminal.open(host.current);
    fit.fit();
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
      terminal.write(decode(content));
      replaying = false;
      outputQueue.sort((a, b) => a.sequence - b.sequence).forEach(writeChunk);
    }).catch((reason) => setError(String(reason)));
    const input = terminal.onData((data) => { void invoke('terminal_write', { id: session.id, data }).catch((reason) => setError(String(reason))); });
    const resize = new ResizeObserver(() => {
      fit.fit();
      void invoke('terminal_resize', { id: session.id, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
    });
    resize.observe(host.current);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.ctrlKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true); return false; }
      return true;
    });
    terminal.focus();
    return () => { resize.disconnect(); input.dispose(); void outputListener.then((unlisten) => unlisten()); void statusListener.then((unlisten) => unlisten()); terminal.dispose(); search.current = null; };
  }, [session.id, onStatus]);

  return <div className="terminal-view">
    <div className="terminal-toolbar"><span>{session.agent} · {session.folder}</span><div><span className={`terminal-status ${session.status}`}>{session.status}</span><button onClick={() => setSearchOpen(!searchOpen)}>Buscar <kbd>Ctrl F</kbd></button><button onClick={() => { if (window.confirm('Encerrar este processo?')) void invoke('terminal_stop', { id: session.id }).catch((reason) => setError(String(reason))); }}>Encerrar</button></div></div>
    {searchOpen && <div className="terminal-search"><input autoFocus aria-label="Buscar no terminal" placeholder="Buscar no terminal" value={query} onChange={(event) => { setQuery(event.target.value); search.current?.findNext(event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter') search.current?.findNext(query); if (event.key === 'Escape') setSearchOpen(false); }} /><button onClick={() => setSearchOpen(false)}>Fechar</button></div>}
    <div ref={host} className="terminal-canvas" onPaste={(event) => { void pasteImage(event); }} />
    {error && <div className="terminal-error" role="alert">{error}</div>}
  </div>;
}
