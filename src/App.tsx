import { startUpdateChecks } from './updater';
import { displayPath, sameFolder } from './path';
import { Select, SelectField, UncontrolledSelect } from './Select';
import { AgentIcon } from './AgentIcon';
import { ProjectIcon } from './ProjectIcon';
import { UsageBar } from './UsageBar';
import { ConfirmHost } from './ConfirmHost';
import { applyTheme, loadTheme } from './themes';
import { PanelActions } from './PanelActions';
import { Sidebar } from './Sidebar';
import { Home } from './Home';
import { chooseFolder } from './folder';
import { StatusDot, sessionStatus } from './status';
import { useWorkerSummaryPolling } from './useWorkerSummary';
import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { lazy, Suspense } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { ArrowUpRight, ChevronDown, ChevronRight, FileText, GitBranch, Home as HomeIcon, Minus, Network, Plug, Plus, Search, Sparkles, Square, Terminal, X } from 'lucide-react';
import logo from './assets/brand/ui-logo.png';
import { Agent, Mode, useAppStore, type PaneInfo, type ProjectInfo, type Section, type SessionInfo, type WorkspaceSnapshot } from './store';
const TerminalView = lazy(() => import('./TerminalView').then((module) => ({ default: module.TerminalView })));
const ToolsView = lazy(() => import('./ToolsView').then((module) => ({ default: module.ToolsView })));
const OrchestratorView = lazy(() => import('./OrchestratorView').then((module) => ({ default: module.OrchestratorView })));
const SettingsView = lazy(() => import('./SettingsView').then((module) => ({ default: module.SettingsView })));

const agentOptions: Agent[] = ['Claude Code', 'Codex', 'Shell'];
const modeOptions: Mode[] = ['Normal', 'Plan', 'Auto-aceitar'];
const SECTION_TABS: Record<Exclude<Section, 'home'>, { label: string; icon: React.ReactNode }> = {
  orchestrator: { label: 'Orquestração', icon: <Network size={14} /> },
  git: { label: 'Git', icon: <GitBranch size={14} /> },
  mcp: { label: 'MCP', icon: <Plug size={14} /> },
  skills: { label: 'Skills', icon: <Sparkles size={14} /> },
};

function WindowBar() {
  const action = (name: 'minimize' | 'toggleMaximize' | 'close') => {
    if (isTauri()) void getCurrentWindow()[name]();
  };
  return <div className="window-bar" data-tauri-drag-region>
    <div className="window-brand" data-tauri-drag-region><img src={logo} alt="" /> <span>Athenas Agent</span></div>
    <div className="window-center" data-tauri-drag-region>Espaço de trabalho <span>·</span> Local</div>
    <div className="window-controls">
      <button aria-label="Minimizar" onClick={() => action('minimize')}><Minus size={15} /></button>
      <button aria-label="Maximizar" onClick={() => action('toggleMaximize')}><Square size={12} /></button>
      <button aria-label="Fechar" className="close-window" onClick={() => action('close')}><X size={16} /></button>
    </div>
  </div>;
}

function EndedSession({ session, onResume }: { session: SessionInfo; onResume: () => void }) {
  return <div className="terminal-ended"><div className="ended-card">
    <span className="ended-icon"><AgentIcon agent={session.agent} size={20} /></span>
    <h2>{session.agent}</h2>
    <p>Esta sessão terminou ({sessionStatus(session.status).label.toLowerCase()}).</p>
    <small>{displayPath(session.folder)}</small>
    {session.agent !== 'Shell' && <button className="button-primary" onClick={onResume}>Retomar</button>}
  </div></div>;
}

function SessionModal() {
  const { sessionOpen, closeSession, setNotice, openSession, activeProjectId, workspace, targetPaneId, setWorkspace } = useAppStore();
  const [agent, setAgent] = useState<Agent>('Claude Code');
  const [mode, setMode] = useState<Mode>('Normal');
  const [folder, setFolder] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [command, setCommand] = useState('');
  useEffect(() => {
    if (sessionOpen) setFolder(displayPath(workspace.projects.find((project) => project.id === activeProjectId)?.folder ?? ''));
  }, [sessionOpen, activeProjectId, workspace.projects]);
  if (!sessionOpen) return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!folder.trim()) { setNotice('Escolha uma pasta antes de abrir a sessão.'); return; }
    if (!isTauri()) { setNotice('Abra o aplicativo desktop para iniciar um terminal real.'); return; }
    try {
      let paneId = targetPaneId;
      const project = workspace.projects.find((item) => item.id === activeProjectId);
      if (!paneId && project && sameFolder(project?.folder, folder)) {
        const snapshot = await invoke<WorkspaceSnapshot>('pane_create', { projectId: project.id });
        paneId = snapshot.panes.filter((pane) => pane.projectId === project.id).at(-1)?.id ?? null;
        setWorkspace(snapshot);
      }
      const session = await invoke<SessionInfo>('terminal_start', { agent, folder, command, resumeId: null, paneId, resume: false, mode, initialPrompt: null, cols: 100, rows: 30 });
      useAppStore.getState().upsertSession(session);
      if (!activeProjectId) useAppStore.getState().setActiveSessionId(session.id);
    } catch (error) { setNotice(String(error)); return; }
    if (!createMore) closeSession();
    else openSession();
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSession(); }}>
    <form className="modal" role="dialog" aria-modal="true" aria-label="Nova sessão" onSubmit={submit}>
      <div className="modal-top"><span className="section-kicker">Nova sessão</span><button type="button" className="icon-button" aria-label="Fechar modal" onClick={closeSession}><X size={16} /></button></div>
      <h2>Abra um novo caminho.</h2><p className="modal-intro">Escolha seu agente e a pasta onde o trabalho vai acontecer.</p>
      <div className="form-field"><span>Abrir como</span><div className="mode-card"><Terminal size={16} /> Terminal <span>Sessão interativa local</span></div></div>
      <div className="form-grid"><SelectField label="Agente" value={agent} options={agentOptions} onChange={setAgent} icon={(item) => <AgentIcon agent={item} />} /><SelectField label="Modo" value={mode} options={modeOptions} onChange={setMode} /></div>
      <label className="form-field"><span>Pasta</span><div className="folder-row"><input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={'C:\\caminho\\do\\projeto'} aria-label="Pasta" /><button type="button" className="button-quiet" onClick={async () => { const result = await chooseFolder(); if (result) setFolder(result); else if (!isTauri()) setNotice('O seletor de pasta funciona no app desktop. Digite o caminho para testar no navegador.'); }}>Escolher pasta</button></div></label>
      <button className="advanced-toggle" type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Avançado</button>
      {advanced && <div className="advanced-fields">
        <div className="advanced-select"><span>Permissões</span><UncontrolledSelect label="Permissões" options={["Padrão", "Solicitar confirmação", "Auto-aceitar"]} /></div>
        <div className="advanced-select"><span>Runtime</span><UncontrolledSelect label="Runtime" options={["Local"]} /></div>
        <label>Caminho do comando<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={agent === 'Claude Code' ? 'claude' : agent === 'Codex' ? 'codex' : 'powershell.exe'} /></label>
      </div>}
      <div className="modal-footer"><label className="checkbox"><input type="checkbox" checked={createMore} onChange={(event) => setCreateMore(event.target.checked)} /> Criar mais</label><div><button type="button" className="button-quiet" onClick={closeSession}>Cancelar</button><button className="button-primary" type="submit">Abrir {agent} <span>Ctrl ↵</span></button></div></div>
    </form>
  </div>;
}

function SmallModal({ kind }: { kind: 'project' | 'group' }) {
  const state = useAppStore();
  const openModal = kind === 'project' ? state.projectOpen : state.groupOpen;
  const close = kind === 'project' ? state.closeProject : state.closeGroup;
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [groupId, setGroupId] = useState('');
  if (!openModal) return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isTauri()) { state.setNotice('Crie espaços no aplicativo desktop.'); return; }
    try {
      const workspace = await invoke<WorkspaceSnapshot>(kind === 'project' ? 'project_create' : 'group_create', kind === 'project' ? { name, folder: folder || null, groupId: groupId || null } : { name });
      state.setWorkspace(workspace);
      if (kind === 'project') state.setActiveProjectId(workspace.projects[0]?.id ?? null);
      close(); setName(''); setFolder(''); setGroupId('');
    } catch (error) { state.setNotice(String(error)); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <form className="modal small-modal" role="dialog" aria-modal="true" aria-label={kind === 'project' ? 'Novo projeto' : 'Novo grupo'} onSubmit={submit}>
      <div className="modal-top"><span className="section-kicker">{kind === 'project' ? 'Novo projeto' : 'Novo grupo'}</span><button type="button" className="icon-button" onClick={close} aria-label="Fechar modal"><X size={16} /></button></div>
      <h2>Nomeie seu espaço.</h2>
      <label className="form-field"><span>Nome</span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus required /></label>
      {kind === 'project' && <>
        <div className="form-field"><span>Grupo</span><Select label="Grupo" value={groupId} onChange={setGroupId} options={[{ value: "", label: "Sem grupo" }, ...state.workspace.groups.map((group) => ({ value: group.id, label: group.name }))]} /></div>
        <label className="form-field"><span>Pasta</span><div className="folder-row"><input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder={'C:\\caminho\\do\\projeto'} required /><button type="button" className="button-quiet" onClick={async () => { const selected = await chooseFolder(); if (selected) setFolder(selected); }}>Escolher pasta</button></div></label>
      </>}
      <div className="modal-footer"><span /><div><button type="button" className="button-quiet" onClick={close}>Cancelar</button><button className="button-primary">Criar</button></div></div>
    </form>
  </div>;
}

function ProjectWorkspace({ project }: { project: ProjectInfo }) {
  const state = useAppStore();
  const sessions = state.sessions.filter((session) => sameFolder(session.folder, project.folder));
  const panes = state.workspace.panes.filter((pane) => pane.projectId === project.id && state.sessions.some((session) => session.paneId === pane.id));
  const legacy = sessions.filter((session) => !session.paneId).map((session, index) => ({ id: session.id, projectId: project.id, position: panes.length + index, pinned: false }));
  const allPanes = [...panes, ...legacy];
  const [spotlightId, setSpotlightId] = useState<string | null>(null);
  const [activeTabs, setActiveTabs] = useState<Record<string, string>>({});
  const [ratio, setRatio] = useState(project.splitRatio);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  useEffect(() => setRatio(project.splitRatio), [project.id, project.splitRatio]);
  const pointerRatio = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return ratio;
    const next = Math.max(0.2, Math.min(0.8, (event.clientX - rect.left) / rect.width));
    setRatio(next);
    return next;
  };
  const single = project.layout === 'spotlight' || project.layout === 'sidebar';
  const visible = single ? allPanes.filter((pane) => pane.id === (spotlightId ?? allPanes[0]?.id)) : allPanes;
  const paneSessions = (id: string) => sessions.filter((session) => session.paneId === id || (!session.paneId && session.id === id));
  const running = sessions.filter((session) => session.status === 'rodando').length;
  const resume = async (active: SessionInfo, paneId: string) => {
    try {
      const resumed = await invoke<SessionInfo>('terminal_start', { agent: active.agent, folder: active.folder, command: active.command, resumeId: active.resumeId, paneId: active.paneId, resume: true, cols: 100, rows: 30 });
      state.upsertSession(resumed); setActiveTabs((current) => ({ ...current, [paneId]: resumed.id }));
    } catch (error) { state.setNotice(String(error)); }
  };
  const renderPane = (pane: PaneInfo) => {
    const tabs = paneSessions(pane.id);
    const active = tabs.find((session) => session.id === activeTabs[pane.id]) ?? tabs[0];
    return <div className="project-pane" key={pane.id} onDragOver={(event) => { if (panes.some((item) => item.id === pane.id)) event.preventDefault(); }} onDrop={async (event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); if (!id || !panes.some((item) => item.id === pane.id)) return; try { const moved = await invoke<SessionInfo>('terminal_set_pane', { id, paneId: pane.id }); state.upsertSession(moved); setActiveTabs((current) => ({ ...current, [pane.id]: id })); } catch (error) { state.setNotice(String(error)); } }}>
      <div className="pane-header">
        <div className="pane-tabs">{tabs.map((session) => <button key={session.id} aria-current={active?.id === session.id ? 'true' : undefined} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', session.id)} className={active?.id === session.id ? 'selected' : ''} onClick={() => setActiveTabs((current) => ({ ...current, [pane.id]: session.id }))}><AgentIcon agent={session.agent} size={12} />{session.agent}<StatusDot info={sessionStatus(session.status)} /></button>)}<button className="pane-add" aria-label="Nova sub-aba" title="Nova sub-aba" onClick={() => panes.some((item) => item.id === pane.id) ? state.openSessionInPane(pane.id) : state.openSession()}><Plus size={13} /></button></div>
        <PanelActions pane={pane} project={project} active={active} tabs={tabs} onActivate={(id) => setActiveTabs((current) => ({ ...current, [pane.id]: id }))} />
      </div>
      {active?.status === 'rodando'
        ? <Suspense fallback={<div className="terminal-loading">Carregando terminal…</div>}><TerminalView session={active} onStatus={state.upsertSession} /></Suspense>
        : active ? <EndedSession session={active} onResume={() => void resume(active, pane.id)} />
        : <div className="terminal-ended"><div className="ended-card"><p>Painel vazio.</p><button className="button-primary" onClick={() => state.openSessionInPane(pane.id)}>Nova sub-aba</button></div></div>}
    </div>;
  };
  return <div className={`project-workspace layout-${project.layout}`}>
    <header>
      <div className="project-title"><span className="project-title-icon"><ProjectIcon icon={project.icon} size={16} /></span><h1>{project.name}</h1><p title={displayPath(project.folder ?? '')}>{displayPath(project.folder ?? '')}</p></div>
      <div className="project-header-meta">{sessions.length > 0 && <span className={`meta-pill ${running ? 'live' : ''}`}>{running ? <><i />{running} ativo(s)</> : null}{running ? ' · ' : ''}{sessions.length} sessão(ões)</span>}<button className="button-primary button-sm" onClick={state.openSession}><Plus size={14} /> Novo agente</button></div>
    </header>
    {allPanes.length === 0
      ? <div className="project-empty"><span className="empty-icon"><Terminal size={22} /></span><h2>Nenhuma sessão neste projeto.</h2><p>Abra um agente na pasta do projeto para começar.</p><button className="button-primary" onClick={state.openSession}>Nova sessão</button></div>
      : <div className="project-main">{single && <div className="project-session-nav">{allPanes.map((pane) => <button key={pane.id} className={(spotlightId ?? allPanes[0]?.id) === pane.id ? 'selected' : ''} onClick={() => setSpotlightId(pane.id)}>Painel {pane.position + 1}<small>{paneSessions(pane.id).length} sub-abas</small></button>)}</div>}<div className="project-grid" ref={gridRef} style={project.layout === 'grid' && visible.length > 1 ? { gridTemplateColumns: `${Math.round(ratio * 100)}% ${Math.round((1 - ratio) * 100)}%` } : undefined}>{visible.map(renderPane)}{project.layout === 'grid' && visible.length > 1 && <div className="grid-divider" style={{ left: `${ratio * 100}%` }} role="separator" aria-label="Redimensionar painéis" onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (dragging.current) pointerRatio(event); }} onPointerUp={(event) => { if (!dragging.current) return; dragging.current = false; const next = pointerRatio(event); void invoke<WorkspaceSnapshot>('project_set_split', { id: project.id, ratio: next }).then(state.setWorkspace).catch((error) => state.setNotice(String(error))); }} />}</div></div>}
  </div>;
}

function CommandPalette() {
  const state = useAppStore();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  if (!state.paletteOpen) return null;
  const close = () => { state.setPaletteOpen(false); setQuery(''); setSelected(0); };
  const actions = [
    { label: 'Início', detail: 'Abrir tela inicial', run: () => { state.setActiveProjectId(null); state.setActiveSessionId(null); } },
    { label: 'Nova sessão', detail: 'Abrir agente ou shell', run: state.openSession },
    { label: 'Novo projeto', detail: 'Criar projeto', run: state.openProject },
    { label: 'Novo grupo', detail: 'Criar grupo', run: state.openGroup },
    ...state.workspace.projects.map((project) => ({ label: project.name, detail: `Projeto · ${displayPath(project.folder ?? '')}`, run: () => { state.setActiveSessionId(null); state.setActiveProjectId(project.id); } })),
    ...state.sessions.map((session) => ({ label: session.agent, detail: `Terminal · ${displayPath(session.folder)}`, run: () => { state.setActiveProjectId(null); state.setActiveSessionId(session.id); } })),
  ].filter((item) => `${item.label} ${item.detail}`.toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR')));
  const run = (index: number) => { actions[index]?.run(); close(); };
  return <div className="palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div className="palette" role="dialog" aria-modal="true" aria-label="Paleta de comandos"><div className="palette-search"><Search size={16} /><input autoFocus aria-label="Buscar comando" placeholder="Busque projetos, terminais ou ações…" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setSelected(Math.min(selected + 1, actions.length - 1)); } if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(Math.max(selected - 1, 0)); } if (event.key === 'Enter') { event.preventDefault(); run(selected); } }} /><kbd>Esc</kbd></div><div className="palette-results">{actions.length ? actions.map((item, index) => <button key={`${item.detail}-${index}`} className={selected === index ? 'selected' : ''} onMouseEnter={() => setSelected(index)} onClick={() => run(index)}><span>{item.label}<small>{item.detail}</small></span><ArrowUpRight size={14} /></button>) : <p>Nenhum resultado.</p>}</div><div className="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navegar</span><span><kbd>↵</kbd> abrir</span></div></div></div>;
}

export function App() {
  const state = useAppStore();
  useEffect(() => { applyTheme(loadTheme()); }, []);
  useEffect(() => startUpdateChecks((message) => useAppStore.getState().setNotice(message)), []);
  useWorkerSummaryPolling();
  useEffect(() => { if (isTauri()) void invoke<import('./store').Preferences>('settings_get').then(state.setPreferences).catch((error) => state.setNotice(String(error))); }, [state.setPreferences, state.setNotice]);
  useEffect(() => { if (isTauri()) void invoke<SessionInfo[]>('terminal_list').then(state.setSessions).catch((error) => state.setNotice(String(error))); }, [state.setSessions, state.setNotice]);
  useEffect(() => { if (isTauri()) void invoke<WorkspaceSnapshot>('workspace_list').then(state.setWorkspace).catch((error) => state.setNotice(String(error))); }, [state.setWorkspace, state.setNotice]);
  useEffect(() => { if (!isTauri()) return; const refresh = () => { void invoke<import('./store').MemorySnapshot>('group_metrics').then(state.setMemory).catch(() => undefined); }; refresh(); const timer = window.setInterval(refresh, 2000); return () => window.clearInterval(timer); }, [state.setMemory]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { state.closeSession(); state.closeProject(); state.closeGroup(); state.setSettingsOpen(false); state.setPaletteOpen(false); state.setNotice(null); }
      if (!event.ctrlKey) return;
      if (event.key.toLowerCase() === 'p' && !event.shiftKey) { event.preventDefault(); state.setPaletteOpen(true); }
      if (event.key.toLowerCase() === 't') { event.preventDefault(); state.openSession(); }
      if (event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); state.openProject(); }
      if (event.shiftKey && event.key.toLowerCase() === 'g') { event.preventDefault(); state.openGroup(); }
      if (event.key === 'Enter' && state.sessionOpen) { event.preventDefault(); (document.querySelector('.modal button[type="submit"]') as HTMLButtonElement | null)?.click(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [state]);
  const activeSession = state.sessions.find((item) => item.id === state.activeSessionId);
  const activeProject = state.workspace.projects.find((item) => item.id === state.activeProjectId);
  const runningCount = state.sessions.filter((item) => item.status === 'rodando').length;
  const goHome = () => { state.setSection('home'); state.setActiveProjectId(null); state.setActiveSessionId(null); };
  const homeTabActive = state.section === 'home' && !activeSession && !activeProject;
  const resumeActive = async (session: SessionInfo) => {
    try { const resumed = await invoke<SessionInfo>('terminal_start', { agent: session.agent, folder: session.folder, command: session.command, resumeId: session.resumeId, paneId: session.paneId, resume: true, cols: 100, rows: 30 }); state.upsertSession(resumed); state.setActiveSessionId(resumed.id); }
    catch (error) { state.setNotice(String(error)); }
  };
  return <div className="app-shell">
    <WindowBar />
    <div className="workspace"><Sidebar /><main className="main-area">
      <div className="tab-bar" aria-label="Abas abertas">
        <button className={`app-tab ${homeTabActive ? 'active' : ''}`} aria-current={homeTabActive ? 'page' : undefined} onClick={goHome}><HomeIcon size={14} /> Início {runningCount > 0 && <span className="tab-count" title={`${runningCount} sessão(ões) ativa(s)`}><i />{runningCount}</span>}</button>
        {state.section !== 'home' && <div className="app-tab active" aria-current="page">{SECTION_TABS[state.section].icon} {SECTION_TABS[state.section].label}<button className="tab-close" aria-label="Fechar aba" onClick={() => state.setSection('home')}><X size={12} /></button></div>}
        {state.section === 'home' && activeSession && <div className="app-tab active" aria-current="page"><AgentIcon agent={activeSession.agent} size={13} /> {activeSession.agent}<StatusDot info={sessionStatus(activeSession.status)} /><button className="tab-close" aria-label="Ocultar terminal" onClick={() => state.setActiveSessionId(null)}><X size={12} /></button></div>}
        {state.section === 'home' && !activeSession && activeProject && <div className="app-tab active" aria-current="page"><ProjectIcon icon={activeProject.icon} size={13} /> {activeProject.name}<button className="tab-close" aria-label="Fechar projeto" onClick={() => state.setActiveProjectId(null)}><X size={12} /></button></div>}
        <button className="tab-plus" aria-label="Nova sessão" title="Nova sessão (Ctrl T)" onClick={state.openSession}><Plus size={15} /></button>
        <div className="tab-spacer" /><UsageBar />
      </div>
      {state.section === 'orchestrator' ? <Suspense fallback={<div className="tools-empty">Carregando…</div>}><OrchestratorView /></Suspense>
        : state.section !== 'home' ? <Suspense fallback={<div className="tools-empty">Carregando…</div>}><ToolsView /></Suspense>
        : activeSession && activeSession.status === 'rodando' ? <Suspense fallback={<div className="terminal-loading">Carregando terminal…</div>}><TerminalView session={activeSession} onStatus={state.upsertSession} /></Suspense>
        : activeSession ? <EndedSession session={activeSession} onResume={() => void resumeActive(activeSession)} />
        : activeProject ? <ProjectWorkspace project={activeProject} />
        : <Home />}
    </main></div>
    <SessionModal /><SmallModal kind="project" /><SmallModal kind="group" />
    <Suspense fallback={null}><SettingsView /></Suspense>
    <ConfirmHost />
    <CommandPalette />
    {state.notice && <div className="toast" role="status"><FileText size={15} /><span>{state.notice}</span><button className="icon-button small" aria-label="Fechar aviso" onClick={() => state.setNotice(null)}><X size={14} /></button></div>}
  </div>;
}
