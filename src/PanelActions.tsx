import { confirmAction } from './confirm';
import { deleteSession } from './panes';
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowLeftRight, Code2, History, Maximize2, PanelRight, Pin, RotateCcw, Trash2 } from 'lucide-react';
import { useAppStore, type PaneInfo, type ProjectInfo, type SessionInfo, type WorkspaceSnapshot } from './store';

export function PanelActions({ pane, project, active, tabs, onActivate }: {
  pane: PaneInfo; project: ProjectInfo; active?: SessionInfo; tabs: SessionInfo[]; onActivate: (id: string) => void;
}) {
  const state = useAppStore();
  const persisted = state.workspace.panes.some((item) => item.id === pane.id);
  const [historyOpen, setHistoryOpen] = useState(false);
  const run = async (task: () => Promise<unknown>) => { try { await task(); } catch (error) { state.setNotice(String(error)); } };
  const restart = async () => {
    if (!active) return;
    if (active.status === 'rodando') {
      await invoke('terminal_stop', { id: active.id });
      let ended = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const sessions = await invoke<SessionInfo[]>('terminal_list');
        if (sessions.find((item) => item.id === active.id)?.status !== 'rodando') { ended = true; break; }
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      if (!ended) throw new Error('O terminal ainda está encerrando. Tente novamente.');
    }
    const next = await invoke<SessionInfo>('terminal_start', { agent: active.agent, folder: active.folder,
      command: active.command, resumeId: active.resumeId, paneId: active.paneId,
      resume: active.agent !== 'Shell', mode: 'Normal', initialPrompt: null, cols: 100, rows: 30 });
    state.upsertSession(next);
    onActivate(next.id);
  };
  return <div className="panel-action-wrap"><div className="panel-actions">
    <button aria-label={pane.pinned ? 'Desafixar painel' : 'Fixar painel'} title={pane.pinned ? 'Desafixar' : 'Fixar'} disabled={!persisted} className={pane.pinned ? 'active' : ''} onClick={() => void run(async () => state.setWorkspace(await invoke<WorkspaceSnapshot>('pane_set_pinned', { id: pane.id, pinned: !pane.pinned })))}><Pin size={13} /></button>
    <button aria-label="Painel lateral" title="Painel lateral" onClick={() => void run(async () => state.setWorkspace(await invoke<WorkspaceSnapshot>('project_set_layout', { id: project.id, layout: project.layout === 'sidebar' ? 'auto' : 'sidebar' })))}><PanelRight size={13} /></button>
    <button aria-label="Histórico do painel" title="Histórico do painel" className={historyOpen ? 'active' : ''} onClick={() => setHistoryOpen(!historyOpen)}><History size={13} /></button>
    <button aria-label="Trocar sub-aba" title="Trocar sub-aba" disabled={tabs.length < 2} onClick={() => { const index = tabs.findIndex((item) => item.id === active?.id); onActivate(tabs[(index + 1) % tabs.length].id); }}><ArrowLeftRight size={13} /></button>
    <button aria-label="Abrir no VS Code" title="Abrir no VS Code" disabled={!project.folder} onClick={() => void run(() => invoke('project_open_vscode', { folder: project.folder }))}><Code2 size={13} /></button>
    <button aria-label="Tela cheia" title="Tela cheia" onClick={() => void run(async () => { const window = getCurrentWindow(); await window.setFullscreen(!(await window.isFullscreen())); })}><Maximize2 size={13} /></button>
    <button aria-label="Reiniciar terminal" title="Reiniciar terminal" disabled={!active} onClick={() => void run(restart)}><RotateCcw size={13} /></button>
    <button aria-label={active ? 'Excluir sessão' : 'Excluir painel'} title={active ? 'Excluir sessão' : 'Excluir painel'} onClick={() => {
      void run(async () => {
        if (!(await confirmAction(active ? 'Encerrar e excluir esta sessão e seu scrollback?' : 'Excluir este painel vazio?'))) return; if (active) { await deleteSession(active.id); }
        else state.setWorkspace(await invoke<WorkspaceSnapshot>('pane_delete', { id: pane.id })); });
    }}><Trash2 size={13} /></button>
  </div>{historyOpen && <div className="panel-history"><strong>Sessões do painel</strong>{tabs.map((session) => <button key={session.id} onClick={() => { onActivate(session.id); setHistoryOpen(false); }}>{session.agent} · {session.status}</button>)}</div>}</div>;
}
