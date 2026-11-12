import { useState, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { ChevronRight, Code2, Copy, FolderOpen, GitBranch, Home, MoreHorizontal, Network, Pencil, Plus, Plug, RotateCcw, Search, Settings2, Sparkles, Trash2, Workflow, X } from 'lucide-react';
import logo from './assets/brand/ui-logo.png';
import { AgentIcon } from './AgentIcon';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { LayoutPicker } from './LayoutPicker';
import { ProjectEditor } from './ProjectEditor';
import { ProjectIcon } from './ProjectIcon';
import { SpotifyPlayer } from './SpotifyPlayer';
import { confirmAction } from './confirm';
import { deleteSession } from './panes';
import { displayPath, sameFolder } from './path';
import { StatusDot, sessionStatus } from './status';
import { useAppStore, type MemorySnapshot, type ProjectInfo, type Section, type SessionInfo, type WorkspaceSnapshot } from './store';

const memoryLabel = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const folderName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

function NavItem({ icon, label, active, onClick, badge, hint }: { icon: ReactNode; label: string; active: boolean; onClick: () => void; badge?: ReactNode; hint?: string }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} title={hint} onClick={onClick}>
    {icon}<span>{label}</span>{badge}
  </button>;
}

export function Sidebar() {
  const { openSession, openProject, sessions, activeSessionId, setActiveSessionId, upsertSession, setNotice, workspace, activeProjectId, setActiveProjectId, memory, setMemory, setSection, section, workerSummary } = useAppStore();
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number; project: ProjectInfo } | null>(null);
  const [editingProject, setEditingProject] = useState<ProjectInfo | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setCollapsed((current) => ({ ...current, [key]: !current[key] }));

  const goSection = (next: Section) => { setSection(next); };
  const goHome = () => { setSection('home'); setActiveProjectId(null); setActiveSessionId(null); };
  const openSessionView = (session: SessionInfo) => { setSection('home'); setActiveProjectId(null); setActiveSessionId(session.id); };

  const projectMenuItems = (project: ProjectInfo): MenuItem[] => {
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

  const resume = async (session: SessionInfo) => {
    try {
      const resumed = await invoke<SessionInfo>('terminal_start', { agent: session.agent, folder: session.folder, command: session.command, resumeId: session.resumeId, paneId: session.paneId, resume: true, cols: 100, rows: 30 });
      upsertSession(resumed); setSection('home'); setActiveSessionId(resumed.id);
    } catch (error) { setNotice(String(error)); }
  };
  const remove = async (session: SessionInfo) => {
    try {
      if (!(await confirmAction('Encerrar e excluir esta sessão e seu scrollback?'))) return;
      await deleteSession(session.id);
      if (activeSessionId === session.id) setActiveSessionId(null);
    } catch (error) { setNotice(String(error)); }
  };

  const sessionRow = (session: SessionInfo, nested: boolean) => {
    const info = sessionStatus(session.status);
    const selected = activeSessionId === session.id && section === 'home';
    return <div className={`session-row ${nested ? 'nested' : ''}`} key={session.id}>
      <button className={selected ? 'selected' : ''} aria-current={selected ? 'true' : undefined} onClick={() => openSessionView(session)} title={displayPath(session.folder)}>
        <AgentIcon agent={session.agent} size={14} />
        <span className="session-name">{session.agent}<small>{nested ? info.label : folderName(session.folder)}</small></span>
        <StatusDot info={info} />
      </button>
      <div className="row-actions">
        {session.status !== 'rodando' && session.agent !== 'Shell' && <button className="row-action" aria-label="Retomar sessão" title="Retomar" onClick={() => void resume(session)}><RotateCcw size={12} /></button>}
        <button className="row-action danger" aria-label="Excluir sessão" title="Excluir sessão" onClick={() => void remove(session)}><X size={12} /></button>
      </div>
    </div>;
  };

  const projectSessions = (project: ProjectInfo) => sessions.filter((session) => sameFolder(session.folder, project.folder));
  const looseSessions = sessions.filter((session) => !workspace.projects.some((project) => sameFolder(session.folder, project.folder)));
  const projectsFor = (groupId: string | null) => workspace.projects.filter((project) => project.groupId === groupId);

  const projectRow = (project: ProjectInfo) => {
    const own = projectSessions(project);
    const running = own.filter((session) => session.status === 'rodando').length;
    const key = `project:${project.id}`;
    const open = !collapsed[key];
    const selected = activeProjectId === project.id && !activeSessionId;
    return <div className="project-block" key={project.id}>
      <div className="project-row">
        {own.length > 0
          ? <button className={`tree-toggle ${open ? 'open' : ''}`} aria-label={`${open ? 'Recolher' : 'Expandir'} ${project.name}`} aria-expanded={open} onClick={() => toggle(key)}><ChevronRight size={12} /></button>
          : <span className="tree-spacer" />}
        <button className={`project-link ${selected ? 'selected' : ''}`} aria-current={selected ? 'true' : undefined}
          onContextMenu={(event) => { event.preventDefault(); setProjectMenu({ x: event.clientX, y: event.clientY, project }); }}
          onClick={() => { setActiveSessionId(null); setActiveProjectId(project.id); }}>
          <ProjectIcon icon={project.icon} /><span>{project.name}</span>
          {own.length > 0 && <small className={running ? 'live' : ''} title={`${running} ativa(s) de ${own.length} sessão(ões)`}>{running ? <><i />{running}</> : own.length}</small>}
        </button>
        <button className="project-more" aria-label={`Opções de ${project.name}`} title="Opções" aria-haspopup="menu" onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setProjectMenu({ x: box.right - 4, y: box.bottom + 4, project }); }}><MoreHorizontal size={15} /></button>
      </div>
      {open && own.length > 0 && <div className="project-sessions">{own.map((session) => sessionRow(session, true))}</div>}
    </div>;
  };

  const toggleSuspend = async (groupId: string, suspended: boolean) => {
    if (!isTauri()) return;
    try { await invoke('group_suspend', { groupId, suspend: !suspended }); setMemory(await invoke<MemorySnapshot>('group_metrics')); }
    catch (error) { setNotice(String(error)); }
  };

  const homeActive = section === 'home' && !activeProjectId && !activeSessionId;
  return <aside className="sidebar">
    <div className="sidebar-top">
      <button className="new-agent" onClick={openSession}><Plus size={15} /> Novo agente <kbd>Ctrl T</kbd></button>
      <button className="icon-button" aria-label="Buscar" title="Buscar (Ctrl P)" onClick={() => useAppStore.getState().setPaletteOpen(true)}><Search size={15} /></button>
    </div>
    <nav className="sidebar-nav" aria-label="Navegação principal">
      <NavItem icon={<Home size={15} />} label="Início" active={homeActive} onClick={goHome} />
      <NavItem icon={<Network size={15} />} label="Orquestração" active={section === 'orchestrator'} onClick={() => goSection('orchestrator')}
        hint={`${workerSummary.active} worker(s) em execução · ${workerSummary.waiting} precisando de atenção`}
        badge={workerSummary.waiting > 0 ? <span className="nav-badge attention" aria-label={`${workerSummary.waiting} aguardando`}>{workerSummary.waiting}</span>
          : workerSummary.active > 0 ? <span className="nav-badge live" aria-label={`${workerSummary.active} ativos`}><i />{workerSummary.active}</span> : undefined} />
      <NavItem icon={<Workflow size={15} />} label="Mapeamento" active={section === 'mapping'} onClick={() => goSection('mapping')} />
      <NavItem icon={<GitBranch size={15} />} label="Git" active={section === 'git'} onClick={() => goSection('git')} />
      <NavItem icon={<Plug size={15} />} label="MCP" active={section === 'mcp'} onClick={() => goSection('mcp')} />
      <NavItem icon={<Sparkles size={15} />} label="Skills" active={section === 'skills'} onClick={() => goSection('skills')} />
    </nav>
    <div className="sidebar-content">
      <div className="sidebar-heading"><span>Projetos</span><button className="icon-button small" aria-label="Novo projeto" title="Novo projeto (Ctrl Shift P)" onClick={openProject}><Plus size={14} /></button></div>
      {workspace.groups.map((group) => {
        const metric = memory.groups.find((item) => item.groupId === group.id);
        const key = `group:${group.id}`;
        const open = !collapsed[key];
        return <div className="project-group" key={group.id}>
          <div className="project-group-title">
            <button className={`group-toggle ${open ? 'open' : ''}`} aria-expanded={open} onClick={() => toggle(key)}><ChevronRight size={12} /><span>{group.name}</span></button>
            {metric?.suspended && <span className="group-state">Suspenso</span>}
            <small title="Memória dos terminais do grupo">{memoryLabel(metric?.bytes ?? 0)}</small>
            <button className="group-action" aria-label={`${metric?.suspended ? 'Retomar' : 'Suspender'} grupo ${group.name}`} onClick={() => void toggleSuspend(group.id, !!metric?.suspended)}>{metric?.suspended ? 'Retomar' : 'Suspender'}</button>
          </div>
          {open && <div className="project-group-items">{projectsFor(group.id).map(projectRow)}</div>}
        </div>;
      })}
      {projectsFor(null).map(projectRow)}
      {workspace.projects.length === 0 && <div className="sidebar-empty"><p>Nenhum projeto ainda.</p><button className="button-quiet button-sm" onClick={openProject}><Plus size={13} /> Criar projeto</button></div>}
      {looseSessions.length > 0 && <>
        <div className="sidebar-heading sessions-heading"><span>Sessões</span><small>{looseSessions.length}</small></div>
        <div className="session-list">{looseSessions.map((session) => sessionRow(session, false))}</div>
      </>}
    </div>
    <div className="sidebar-bottom">
      {projectMenu && <ContextMenu x={projectMenu.x} y={projectMenu.y} items={projectMenuItems(projectMenu.project)} onClose={() => setProjectMenu(null)} />}
      {editingProject && <ProjectEditor project={editingProject} onClose={() => setEditingProject(null)} />}
      <SpotifyPlayer />
      <LayoutPicker />
      <div className="account"><img src={logo} alt="" /><span>Conta local <b>· Default</b></span><button className="account-settings icon-button small" aria-label="Ajustes" title="Ajustes" onClick={() => useAppStore.getState().setSettingsOpen(true)}><Settings2 size={15} /></button></div>
    </div>
  </aside>;
}
