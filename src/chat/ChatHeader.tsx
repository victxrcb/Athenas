import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { CalendarClock, Check, Download, FileDiff, GitBranch, Layers, MoreHorizontal, PanelLeft, Play, Power, Search } from 'lucide-react';
import { AgentIcon } from '../AgentIcon';
import { useActivityStore } from '../activity';
import { confirmAction } from '../confirm';
import { ContextMenu } from '../ContextMenu';
import { sameFolder } from '../path';
import { useScheduleStore } from '../schedule';
import { LiveBadge, SessionName } from '../SessionName';
import { toggleSidebarHidden } from '../sidebarPrefs';
import { useAppStore, type SessionInfo } from '../store';
import { notice } from './actions';
import { ContextPopover, type ContextInfo } from './Context';
import { chooseFiles } from './Composer';
import { setChatWidth, useChatPrefs, type ChatWidth } from './prefs';
import type { SessionChat } from './store';
import { ViewSwitch } from './ViewSwitch';

const WIDTHS: [ChatWidth, string][] = [['compact', 'Largura compacta'], ['default', 'Largura padrão'], ['wide', 'Largura expandida']];

const timer = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const rest = `${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${rest}` : rest;
};

/** Time of the current turn; ticks only while one is running. */
export function Elapsed({ sessionId }: { sessionId: string }) {
  const since = useActivityStore((state) => (state.activity[sessionId]?.state === 'working' ? state.activity[sessionId].since : null));
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [since]);
  return since === null ? null : <time className="chat-elapsed" title="Duração do turno atual">{timer(Math.max(0, Math.floor((now - since) / 1000)))}</time>;
}

export function ChatHeader({ session, chat, info, changedFiles, searching, split, onSearch, onFiles, onExport, onResume }: {
  session: SessionInfo; chat: SessionChat; info: ContextInfo | null; changedFiles: number; searching: boolean; split: boolean;
  onSearch: () => void; onFiles: () => void; onExport: () => void; onResume?: () => void;
}) {
  const project = useAppStore((state) => state.workspace.projects.find((item) => sameFolder(item.folder, session.folder)));
  const width = useChatPrefs((state) => state.width);
  const [context, setContext] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeContext = useCallback(() => setContext(false), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const running = session.status === 'rodando';
  const model = chat.model ?? chat.transcript.meta.model;
  const branch = info?.branch ?? chat.transcript.meta.branch;
  return <header className="chat-header">
    <span className="chat-header-icon"><AgentIcon agent={session.agent} size={20} /></span>
    <div className="chat-header-title">
      <h2><SessionName session={session} />{project && <span> · {project.name}</span>}</h2>
      <p><LiveBadge session={session} /><Elapsed sessionId={session.id} />
        {model && <code title="Modelo informado pelo agente">{model}</code>}
        {branch && <code className="chat-branch" title="Branch Git da pasta"><GitBranch size={11} /> {branch}</code>}
      </p>
    </div>
    <div className="chat-header-actions">
      <ViewSwitch sessionId={session.id} split={split} />
      {!running && onResume && <button type="button" className="chat-primary" onClick={onResume}><Play size={13} /> Retomar</button>}
      {changedFiles > 0 && <button type="button" className="chat-tool" title="Arquivos modificados pelo agente" aria-label={`Arquivos modificados: ${changedFiles}`} onClick={onFiles}><FileDiff size={14} /><b>{changedFiles}</b></button>}
      <button type="button" className="chat-tool" data-context-toggle title="Contexto" aria-label="Ver contexto" aria-expanded={context} onClick={() => setContext(!context)}><Layers size={14} /></button>
      <button type="button" className="chat-tool" title="Buscar na conversa (Ctrl F)" aria-label="Buscar na conversa" aria-pressed={searching} onClick={onSearch}><Search size={14} /></button>
      <button type="button" className="chat-tool" title="Mais opções" aria-label="Mais opções" aria-haspopup="menu" onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        setMenu({ x: box.right - 230, y: box.bottom + 4 });
      }}><MoreHorizontal size={15} /></button>
    </div>
    {context && <ContextPopover session={session} chat={chat} info={info} placement="below" onAddFiles={() => void chooseFiles(session.id)} onClose={closeContext} />}
    {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} autoFocus onClose={closeMenu} items={[
      { label: 'Agendar prompt', icon: <CalendarClock size={14} />, disabled: !running, onSelect: () => useScheduleStore.getState().open({ target: 'session', sessionId: session.id }) },
      { label: 'Exportar conversa carregada', icon: <Download size={14} />, onSelect: onExport },
      { label: 'Expandir conversa / barra lateral (Ctrl B)', icon: <PanelLeft size={14} />, onSelect: toggleSidebarHidden },
      { type: 'separator' },
      ...WIDTHS.map(([id, label]) => ({ label, icon: width === id ? <Check size={14} /> : <span style={{ width: 14 }} />, onSelect: () => setChatWidth(id) })),
      { type: 'separator' },
      { label: 'Encerrar sessão', icon: <Power size={14} />, danger: true, disabled: !running, onSelect: () => void confirmAction('Encerrar este processo?').then((ok) => (ok ? invoke('terminal_stop', { id: session.id }) : undefined)).catch((error) => notice(String(error))) },
    ]} />, document.body)}
  </header>;
}
