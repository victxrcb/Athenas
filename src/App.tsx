import { confirmAction } from './confirm';
import { displayPath, sameFolder } from './path';
import { deleteSession } from './panes';
import { LayoutPicker } from './LayoutPicker';
import { Select, UncontrolledSelect } from './Select';
import { AgentIcon } from './AgentIcon';
import { ProjectIcon } from './ProjectIcon';
import { UsageBar } from './UsageBar';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { ProjectEditor } from './ProjectEditor';
import { ConfirmHost } from './ConfirmHost';
import { applyTheme, loadTheme } from './themes';
import { PanelActions } from './PanelActions';
import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { lazy, Suspense } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { MoreHorizontal, Copy, FolderOpen, Pencil, Trash2, ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, ChevronRight, Clock3, Code2, Command, FileText, Folder, GitBranch, Home, Minus, Plus, Search, Send, Settings2, Square, Terminal, X } from 'lucide-react';
import logo from './assets/brand/ui-logo.png';
import ascii from './assets/brand/hera-ascii.svg';
import source from './assets/brand/hera-source.jpg';
import { Agent, Mode, useAppStore, type WorkspaceSnapshot } from './store';
const TerminalView = lazy(() => import('./TerminalView').then((module) => ({ default: module.TerminalView })));
const ToolsView = lazy(() => import('./ToolsView').then((module) => ({ default: module.ToolsView })));
const OrchestratorView = lazy(() => import('./OrchestratorView').then((module) => ({ default: module.OrchestratorView })));
const SettingsView = lazy(() => import('./SettingsView').then((module) => ({ default: module.SettingsView })));

const agentOptions: Agent[] = ['Claude Code', 'Codex', 'Shell'];
const modeOptions: Mode[] = ['Normal', 'Plan', 'Auto-aceitar'];
const memoryLabel = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
}

function WindowBar() {
  const action = (name: 'minimize' | 'toggleMaximize' | 'close') => {
    if (isTauri()) void getCurrentWindow()[name]();
  };
  return <div className="window-bar" data-tauri-drag-region>
    <div className="window-brand" data-tauri-drag-region><img src={logo} alt="" /> <span>Athenas Agent</span></div>
    <div className="window-center" data-tauri-drag-region>ESPAÇO DE TRABALHO <span>·</span> LOCAL</div>
    <div className="window-controls">
      <button aria-label="Minimizar" onClick={() => action('minimize')}><Minus size={15} /></button>
      <button aria-label="Maximizar" onClick={() => action('toggleMaximize')}><Square size={12} /></button>
      <button aria-label="Fechar" className="close-window" onClick={() => action('close')}><X size={16} /></button>
    </div>
  </div>;
}

function Sidebar() {
  const { openSession, openProject, sessions, activeSessionId, setActiveSessionId, upsertSession, setNotice, workspace, activeProjectId, setActiveProjectId, memory, setMemory, setSection, section } = useAppStore();
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number; project: import('./store').ProjectInfo } | null>(null);
  const [editingProject, setEditingProject] = useState<import('./store').ProjectInfo | null>(null);
  const projectMenuItems = (project: import('./store').ProjectInfo): MenuItem[] => {
    const folder = project.folder ?? '';
    const run = (task: () => Promise<unknown>) => { void task().catch((error) => setNotice(String(error))); };
    return [
      { label: 'Novo agente aqui', icon: <Plus size={14} />, onSelect: () => { setActiveSessionId(null); setActiveProjectId(project.id); openSession(); } },
      { type: 'separator' },
      { label: 'Editar projeto', icon: <Pencil size={14} />, onSelect: () => setEditingProject(project) },
      { label: 'Abrir no VS Code', icon: <Code2 size={14} />, disabled: !folder, onSelect: () => run(() => invoke('project_open_vscode', { folder })) },
      { label: 'Mostrar na pasta', icon: <FolderOpen size={14} />, disabled: !folder, onSelect: () => run(() => invoke('project_reveal', { folder })) },
      { label: 'Copiar caminho', icon: <Copy size={14} />, disabled: !folder, onSelect: () => run(async () => { await navigator.clipboard.writeText(displayPath(folder)); setNotice('Caminho copiado.'); }) },
      { type: 'separator' },
      { label: 'Excluir projeto', icon: <Trash2 size={14} />, danger: true, onSelect: () => run(async () => {
        if (!(await confirmAction(`Excluir o projeto "${project.name}"? Os arquivos e terminais não são apagados.`))) return;
        useAppStore.getState().setWorkspace(await invoke<WorkspaceSnapshot>('project_delete', { id: project.id }));
        if (activeProjectId === project.id) setActiveProjectId(null);
      }) },
    ];
  };
  const projectsFor = (groupId: string | null) => workspace.projects.filter((project) => project.groupId === groupId);
  const projectButton = (project: import('./store').ProjectInfo) => <div className="project-row" key={project.id}><button className={`project-link ${activeProjectId === project.id ? 'selected' : ''}`} onContextMenu={(event) => { event.preventDefault(); setProjectMenu({ x: event.clientX, y: event.clientY, project }); }} onClick={() => { setActiveSessionId(null); setActiveProjectId(project.id); }}><ProjectIcon icon={project.icon} /><span>{project.name}</span><small>{sessions.filter((session) => sameFolder(session.folder, project.folder)).length}</small></button><button className="project-more" aria-label={`Opções de ${project.name}`} title="Opções" aria-haspopup="menu" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setProjectMenu({ x: box.right - 4, y: box.bottom + 4, project }); }}><MoreHorizontal size={15} /></button></div>;
  return <aside className="sidebar">
    <div className="sidebar-top">
      <button className={`sidebar-icon ${section === 'home' ? 'active' : ''}`} aria-label="Início" onClick={() => { setSection('home'); setActiveProjectId(null); setActiveSessionId(null); }}><Home size={18} /></button>
      <button className="sidebar-icon" aria-label="Arquivos" onClick={openProject}><Folder size={18} /></button>
      <button className={`sidebar-icon ${section === 'git' ? 'active' : ''}`} aria-label="Git" onClick={() => setSection('git')}><GitBranch size={18} /></button>
      <button className="sidebar-icon" aria-label="Buscar" onClick={() => useAppStore.getState().setPaletteOpen(true)}><Search size={18} /></button>
    </div>
    <div className="sidebar-content">
      <div className="section-kicker">SEU ESPAÇO</div>
      <button className="new-agent" onClick={openSession}><Plus size={16} /> Novo agente <kbd>Ctrl T</kbd></button>
      <div className="sidebar-tool-links"><button onClick={() => setSection('orchestrator')}>Orquestração <ChevronRight size={13} /></button><button onClick={() => setSection('skills')}>Skills <ChevronRight size={13} /></button></div>
      <div className="sidebar-heading"><span>PROJETOS</span><button aria-label="Novo projeto" onClick={openProject}><Plus size={15} /></button></div>
      {workspace.groups.map((group) => { const metric = memory.groups.find((item) => item.groupId === group.id); return <div className="project-group" key={group.id}><div className="project-group-title"><span>{group.name}</span><small>{memoryLabel(metric?.bytes ?? 0)}</small><button aria-label={`${metric?.suspended ? 'Retomar' : 'Suspender'} grupo ${group.name}`} onClick={async () => { if (!isTauri()) return; try { await invoke('group_suspend', { groupId: group.id, suspend: !metric?.suspended }); setMemory(await invoke<import('./store').MemorySnapshot>('group_metrics')); } catch (error) { setNotice(String(error)); } }}>{metric?.suspended ? 'Retomar' : 'Suspender'}</button></div>{projectsFor(group.id).map(projectButton)}</div>; })}
      {projectsFor(null).map(projectButton)}
      {sessions.length ? <div className="session-list">{sessions.map((session) => <div className="session-row" key={session.id}><button className={activeSessionId === session.id ? 'selected' : ''} onClick={() => { setSection('home'); setActiveProjectId(null); setActiveSessionId(session.id); }}><AgentIcon agent={session.agent} size={14} /><span>{session.agent}<small>{session.folder.split(/[\\/]/).pop()}</small></span><i className={session.status} title={session.status} /></button>{session.status !== 'rodando' && session.agent !== 'Shell' && <button className="resume-button" onClick={async () => { try { const resumed = await invoke<import('./store').SessionInfo>('terminal_start', { agent: session.agent, folder: session.folder, command: session.command, resumeId: session.resumeId, paneId: session.paneId, resume: true, cols: 100, rows: 30 }); upsertSession(resumed); setSection('home'); setActiveSessionId(resumed.id); } catch (error) { setNotice(String(error)); } }}>Retomar</button>}<button className="session-delete" aria-label="Excluir sessão" title="Excluir sessão" onClick={async () => { try { if (!(await confirmAction('Encerrar e excluir esta sessão e seu scrollback?'))) return; await deleteSession(session.id); if (activeSessionId === session.id) setActiveSessionId(null); } catch (error) { setNotice(String(error)); } }}><X size={12} /></button></div>)}</div> : workspace.projects.length === 0 && <div className="sidebar-empty"><p>Crie um projeto</p></div>}
    </div>
    <div className="sidebar-bottom">{projectMenu && <ContextMenu x={projectMenu.x} y={projectMenu.y} items={projectMenuItems(projectMenu.project)} onClose={() => setProjectMenu(null)} />}{editingProject && <ProjectEditor project={editingProject} onClose={() => setEditingProject(null)} />}<LayoutPicker /><div className="account"><img src={logo} alt="" /><span>conta local <b>· Default</b></span><button className="account-settings" aria-label="Ajustes" title="Ajustes" onClick={() => useAppStore.getState().setSettingsOpen(true)}><Settings2 size={15} /></button></div></div>
  </aside>;
}

function SelectField<T extends string>({ label, value, options, onChange, icon }: { label: string; value: T; options: T[]; onChange: (value: T) => void; icon?: (value: T) => React.ReactNode }) {
  return <div className="select-field"><span>{label}</span><Select label={label} value={value} options={options.map((option) => ({ value: option, label: option, icon: icon?.(option) }))} onChange={(next) => onChange(next as T)} /></div>;
}

async function chooseFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const chosen = await open({ directory: true, multiple: false, title: 'Escolher pasta do projeto' });
  return typeof chosen === 'string' ? chosen : null;
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
      const session = await invoke<import('./store').SessionInfo>('terminal_start', { agent, folder, command, resumeId: null, paneId, resume: false, mode, initialPrompt: null, cols: 100, rows: 30 });
      useAppStore.getState().upsertSession(session);
      if (!activeProjectId) useAppStore.getState().setActiveSessionId(session.id);
    } catch (error) { setNotice(String(error)); return; }
    if (!createMore) closeSession();
    else openSession();
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSession(); }}>
    <form className="modal" role="dialog" aria-modal="true" aria-label="Nova sessão" onSubmit={submit}>
      <div className="modal-top"><span className="section-kicker">NOVA SESSÃO</span><button type="button" aria-label="Fechar modal" onClick={closeSession}><X size={18} /></button></div>
      <h2>Abra um novo caminho.</h2><p className="modal-intro">Escolha seu agente e a pasta onde o trabalho vai acontecer.</p>
      <div className="form-field"><span>Abrir como</span><div className="mode-card"><Terminal size={18} /> Terminal</div></div>
      <div className="form-grid"><SelectField label="Agente" value={agent} options={agentOptions} onChange={setAgent} icon={(item) => <AgentIcon agent={item} />} /><SelectField label="Modo" value={mode} options={modeOptions} onChange={setMode} /></div>
      <label className="form-field"><span>Pasta</span><div className="folder-row"><input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="C:\\caminho\\do\\projeto" aria-label="Pasta" /><button type="button" onClick={async () => { const result = await chooseFolder(); if (result) setFolder(result); else if (!isTauri()) setNotice('O seletor de pasta funciona no app desktop. Digite o caminho para testar no navegador.'); }}>Escolher pasta</button></div></label>
      <button className="advanced-toggle" type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? <ChevronDown size={15} /> : <ChevronRight size={15} />} Avançado</button>
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
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><form className="modal small-modal" role="dialog" aria-modal="true" aria-label={kind === 'project' ? 'Novo projeto' : 'Novo grupo'} onSubmit={submit}><div className="modal-top"><span className="section-kicker">{kind === 'project' ? 'NOVO PROJETO' : 'NOVO GRUPO'}</span><button type="button" onClick={close} aria-label="Fechar modal"><X size={18} /></button></div><h2>Nomeie seu espaço.</h2><label className="form-field"><span>Nome</span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus required /></label>{kind === 'project' && <><div className="form-field"><span>Grupo</span><Select label="Grupo" value={groupId} onChange={setGroupId} options={[{ value: "", label: "Sem grupo" }, ...state.workspace.groups.map((group) => ({ value: group.id, label: group.name }))]} /></div><label className="form-field"><span>Pasta</span><div className="folder-row"><input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="C:\\caminho\\do\\projeto" required /><button type="button" onClick={async () => { const selected = await chooseFolder(); if (selected) setFolder(selected); }}>Escolher pasta</button></div></label></>}<div className="modal-footer"><span /><div><button type="button" className="button-quiet" onClick={close}>Cancelar</button><button className="button-primary">Criar</button></div></div></form></div>;
}

function ProjectWorkspace({ project }: { project: import('./store').ProjectInfo }) {
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
  const renderPane = (pane: import('./store').PaneInfo) => {
    const tabs = paneSessions(pane.id);
    const active = tabs.find((session) => session.id === activeTabs[pane.id]) ?? tabs[0];
    return <div className="project-pane" key={pane.id} onDragOver={(event) => { if (panes.some((item) => item.id === pane.id)) event.preventDefault(); }} onDrop={async (event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); if (!id || !panes.some((item) => item.id === pane.id)) return; try { const moved = await invoke<import('./store').SessionInfo>('terminal_set_pane', { id, paneId: pane.id }); state.upsertSession(moved); setActiveTabs((current) => ({ ...current, [pane.id]: id })); } catch (error) { state.setNotice(String(error)); } }}><div className="pane-tabs">{tabs.map((session) => <button key={session.id} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', session.id)} className={active?.id === session.id ? 'selected' : ''} onClick={() => setActiveTabs((current) => ({ ...current, [pane.id]: session.id }))}>{session.agent}<span className={session.status} /></button>)}<button className="pane-add" aria-label="Nova sub-aba" onClick={() => panes.some((item) => item.id === pane.id) ? state.openSessionInPane(pane.id) : state.openSession()}><Plus size={13} /></button></div><PanelActions pane={pane} project={project} active={active} tabs={tabs} onActivate={(id) => setActiveTabs((current) => ({ ...current, [pane.id]: id }))} />{active?.status === 'rodando' ? <Suspense fallback={<div className="terminal-ended">Carregando terminal…</div>}><TerminalView session={active} onStatus={state.upsertSession} /></Suspense> : active ? <div className="terminal-ended"><h2>{active.agent}</h2><p>Sessão {active.status}.</p>{active.agent !== 'Shell' && <button className="button-primary" onClick={async () => { try { const resumed = await invoke<import('./store').SessionInfo>('terminal_start', { agent: active.agent, folder: active.folder, command: active.command, resumeId: active.resumeId, paneId: active.paneId, resume: true, cols: 100, rows: 30 }); state.upsertSession(resumed); setActiveTabs((current) => ({ ...current, [pane.id]: resumed.id })); } catch (error) { state.setNotice(String(error)); } }}>Retomar</button>}</div> : <div className="terminal-ended"><p>Painel vazio.</p><button className="button-primary" onClick={() => state.openSessionInPane(pane.id)}>Nova sub-aba</button></div>}</div>;
  };
  return <div className={`project-workspace layout-${project.layout}`}><header><div className="project-title"><h1>{project.name}</h1><p title={displayPath(project.folder ?? '')}>{displayPath(project.folder ?? '')}</p></div><button className="button-primary" onClick={state.openSession}><Plus size={14} /> Novo agente</button></header>{allPanes.length === 0 ? <div className="project-empty"><Terminal size={30} /><h2>Nenhuma sessão neste projeto.</h2><p>Abra um agente na pasta do projeto para começar.</p><button className="button-primary" onClick={state.openSession}>Nova sessão</button></div> : <div className="project-main">{single && <div className="project-session-nav">{allPanes.map((pane) => <button key={pane.id} className={(spotlightId ?? allPanes[0]?.id) === pane.id ? 'selected' : ''} onClick={() => setSpotlightId(pane.id)}>Painel {pane.position + 1}<small>{paneSessions(pane.id).length} sub-abas</small></button>)}</div>}<div className="project-grid" ref={gridRef} style={project.layout === 'grid' && visible.length > 1 ? { gridTemplateColumns: `${Math.round(ratio * 100)}% ${Math.round((1 - ratio) * 100)}%` } : undefined}>{visible.map(renderPane)}{project.layout === 'grid' && visible.length > 1 && <div className="grid-divider" style={{ left: `${ratio * 100}%` }} role="separator" aria-label="Redimensionar painéis" onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (dragging.current) pointerRatio(event); }} onPointerUp={(event) => { if (!dragging.current) return; dragging.current = false; const next = pointerRatio(event); void invoke<WorkspaceSnapshot>('project_set_split', { id: project.id, ratio: next }).then(state.setWorkspace).catch((error) => state.setNotice(String(error))); }} />}</div></div>}</div>;
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
  return <div className="palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div className="palette" role="dialog" aria-modal="true" aria-label="Paleta de comandos"><div className="palette-search"><Search size={18} /><input autoFocus aria-label="Buscar comando" placeholder="Busque projetos, terminais ou ações…" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setSelected(Math.min(selected + 1, actions.length - 1)); } if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(Math.max(selected - 1, 0)); } if (event.key === 'Enter') { event.preventDefault(); run(selected); } }} /><kbd>ESC</kbd></div><div className="palette-results">{actions.length ? actions.map((item, index) => <button key={`${item.detail}-${index}`} className={selected === index ? 'selected' : ''} onMouseEnter={() => setSelected(index)} onClick={() => run(index)}><span>{item.label}<small>{item.detail}</small></span><ArrowUpRight size={14} /></button>) : <p>Nenhum resultado.</p>}</div></div></div>;
}

export function App() {
  const state = useAppStore();
  useEffect(() => { applyTheme(loadTheme()); }, []);
  const [agent, setAgent] = useState<Agent>('Claude Code');
  const [mode, setMode] = useState<Mode>('Normal');
  const [prompt, setPrompt] = useState('');
  const [folder, setFolder] = useState('');
  const [date, setDate] = useState(new Date());
  const [reduced, setReduced] = useState(false);
  useEffect(() => setReduced(state.preferences.reducedEffects), [state.preferences.reducedEffects]);
  useEffect(() => { if (isTauri()) void invoke<import('./store').Preferences>('settings_get').then(state.setPreferences).catch((error) => state.setNotice(String(error))); }, [state.setPreferences, state.setNotice]);
  useEffect(() => { if (isTauri()) void invoke<import('./store').SessionInfo[]>('terminal_list').then(state.setSessions).catch((error) => state.setNotice(String(error))); }, [state.setSessions, state.setNotice]);
  useEffect(() => { if (isTauri()) void invoke<WorkspaceSnapshot>('workspace_list').then(state.setWorkspace).catch((error) => state.setNotice(String(error))); }, [state.setWorkspace, state.setNotice]);
  useEffect(() => { if (!isTauri()) return; const refresh = () => { void invoke<import('./store').MemorySnapshot>('group_metrics').then(state.setMemory).catch(() => undefined); }; refresh(); const timer = window.setInterval(refresh, 2000); return () => window.clearInterval(timer); }, [state.setMemory]);
  useEffect(() => { const timer = setInterval(() => setDate(new Date()), 60000); return () => clearInterval(timer); }, []);
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
  const formatted = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  const activeSession = state.sessions.find((item) => item.id === state.activeSessionId);
  const activeProject = state.workspace.projects.find((item) => item.id === state.activeProjectId);
  const submitHome = async () => {
    if (!prompt.trim()) { state.openSession(); return; }
    if (!isTauri()) { state.setNotice('Abra o aplicativo desktop para iniciar um agente.'); return; }
    const target = folder || activeProject?.folder;
    if (!target) { state.setNotice('Escolha uma pasta antes de enviar o comando.'); return; }
    try {
      const session = await invoke<import('./store').SessionInfo>('terminal_start', {
        agent, folder: target, command: '', resumeId: null, paneId: null, resume: false,
        mode, initialPrompt: agent === 'Shell' ? null : prompt.trim(), cols: 100, rows: 30,
      });
      state.upsertSession(session);
      state.setSection('home');
      state.setActiveProjectId(null);
      state.setActiveSessionId(session.id);
      if (agent === 'Shell') await invoke('terminal_write', { id: session.id, data: prompt.trim() + '\r' });
      setPrompt('');
    } catch (error) { state.setNotice(String(error)); }
  };
  return <div className="app-shell">
    <WindowBar />
    <div className="workspace"><Sidebar /><main className="main-area"><div className="tab-bar"><div className="history-buttons"><button aria-label="Voltar" disabled><ArrowLeft size={16} /></button><button aria-label="Avançar" disabled><ArrowRight size={16} /></button></div><button className="app-tab" onClick={() => { state.setSection('home'); state.setActiveProjectId(null); state.setActiveSessionId(null); }}><Home size={15} /> Início <span className="tab-count">{state.sessions.filter((item) => item.status === 'rodando').length}</span></button>{state.section !== 'home' && <div className="app-tab">{state.section.toUpperCase()}</div>}{activeSession && state.section === 'home' && <div className="app-tab"><Terminal size={15} /> {activeSession.agent}<button aria-label="Ocultar terminal" onClick={() => state.setActiveSessionId(null)}><X size={13} /></button></div>}<button className="tab-plus" aria-label="Nova sessão" onClick={state.openSession}><Plus size={16} /></button><div className="tab-spacer" /><UsageBar /></div>
      {state.section === 'orchestrator' ? <Suspense fallback={<div className="tools-empty">Carregando…</div>}><OrchestratorView /></Suspense> : state.section !== 'home' ? <Suspense fallback={<div className="tools-empty">Carregando…</div>}><ToolsView /></Suspense> : activeSession && activeSession.status === 'rodando' ? <Suspense fallback={<div className="terminal-ended">Carregando terminal…</div>}><TerminalView session={activeSession} onStatus={state.upsertSession} /></Suspense> : activeSession ? <div className="terminal-ended"><h2>{activeSession.agent}</h2><p>Esta sessão terminou ({activeSession.status}).</p>{activeSession.agent !== 'Shell' && <button className="button-primary" onClick={async () => { try { const resumed = await invoke<import('./store').SessionInfo>('terminal_start', { agent: activeSession.agent, folder: activeSession.folder, command: activeSession.command, resumeId: activeSession.resumeId, paneId: activeSession.paneId, resume: true, cols: 100, rows: 30 }); state.upsertSession(resumed); state.setActiveSessionId(resumed.id); } catch (error) { state.setNotice(String(error)); } }}>Retomar</button>}</div> : activeProject ? <ProjectWorkspace project={activeProject} /> : <div className="home"><div className="hero-art" aria-hidden="true" style={{ backgroundImage: `url(${reduced ? ascii : source})` }} />
        <div className="home-content"><div className="welcome"><img src={logo} alt="Logo Athenas Agent" /><div><div className="wordmark">ATHENAS <span>AGENT</span></div><span>SEU ATELIÊ DE AGENTES</span></div></div><h1>{greeting()}, Victor<span>.</span></h1><div className="date-line"><Clock3 size={15} /> {formatted} <span>·</span> {date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
          <div className="command-box"><div className="command-top"><Command size={16} /><span>NOVO COMANDO</span><span className="command-status">PRONTO PARA COMEÇAR</span></div><textarea aria-label="O que você quer construir?" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="O que você quer construir?" rows={3} /><div className="command-bottom"><SelectField label="Agente" value={agent} options={agentOptions} onChange={setAgent} icon={(item) => <AgentIcon agent={item} />} /><button className="folder-select" onClick={async () => { const result = await chooseFolder(); if (result) setFolder(result); else if (!isTauri()) state.setNotice('Escolha a pasta no aplicativo desktop.'); }}><Folder size={15} /> {folder ? folder.split(/[\\/]/).pop() : 'Pasta'} <ChevronDown size={13} /></button><SelectField label="Modo" value={mode} options={modeOptions} onChange={setMode} /><div className="command-grow" /><button className="send-button" aria-label="Enviar comando" onClick={() => void submitHome()}><Send size={17} /></button></div></div>
          <div className="quick-actions"><button onClick={state.openSession}><Terminal size={16} /> Novo terminal <ArrowUpRight size={14} /></button><button onClick={state.openProject}><Folder size={16} /> Novo projeto <ArrowUpRight size={14} /></button></div>
          <div className="home-sections"><section><div className="section-head"><h2>Projetos recentes</h2><span>SEU TRABALHO, À MÃO</span></div>{state.workspace.projects.length ? state.workspace.projects.slice(0, 4).map((project) => <button className="recent-empty recent-project" key={project.id} onClick={() => state.setActiveProjectId(project.id)}><div className="recent-avatar">{project.icon ? <img src={project.icon} alt="" draggable={false} /> : project.name.charAt(0).toUpperCase()}</div><div><strong>{project.name}</strong><p>{state.sessions.filter((session) => sameFolder(session.folder, project.folder)).length} terminais · {displayPath(project.folder ?? '') || 'Sem pasta'}</p></div><ArrowUpRight size={18} /></button>) : <div className="recent-empty"><div className="recent-avatar">A</div><div><strong>Um começo em branco.</strong><p>Seus projetos vão aparecer aqui assim que você criar o primeiro.</p></div><button onClick={state.openProject} aria-label="Criar primeiro projeto"><ArrowUpRight size={18} /></button></div>}</section><section><div className="section-head"><h2>Comece algo</h2><span>ATALHOS</span></div><div className="start-list"><button onClick={state.openSession}><Terminal size={18} /><span>Novo terminal</span><kbd>Ctrl T</kbd><ChevronRight size={15} /></button><button onClick={state.openProject}><Folder size={18} /><span>Novo projeto</span><kbd>Ctrl Shift P</kbd><ChevronRight size={15} /></button><button onClick={state.openGroup}><Code2 size={18} /><span>Novo grupo</span><kbd>Ctrl Shift G</kbd><ChevronRight size={15} /></button></div></section></div>
          <div className="home-footer"><span>✦</span> FEITO PARA IDEIAS QUE MERECEM ESPAÇO <button onClick={() => setReduced(!reduced)}>{reduced ? 'Usar imagem' : 'Usar arte ASCII'}</button></div></div></div>}
    </main></div>
    <SessionModal /><SmallModal kind="project" /><SmallModal kind="group" />
    <Suspense fallback={null}><SettingsView /></Suspense>
    <ConfirmHost />
    <CommandPalette />
    {state.notice && <div className="toast" role="status"><FileText size={16} />{state.notice}<button aria-label="Fechar aviso" onClick={() => state.setNotice(null)}><X size={16} /></button></div>}
  </div>;
}
