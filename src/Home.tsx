import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { AlertTriangle, ArrowRight, ArrowUpRight, ChevronDown, Clock3, Command, Folder, FolderPlus, Layers, Network, Send, Terminal } from 'lucide-react';
import logo from './assets/brand/ui-logo.png';
import ascii from './assets/brand/hera-ascii.svg';
import source from './assets/brand/hera-source.jpg';
import { AgentIcon } from './AgentIcon';
import { SelectField } from './Select';
import { chooseFolder } from './folder';
import { displayPath, sameFolder } from './path';
import { StatusBadge, sessionStatus } from './status';
import { useAppStore, type Agent, type Mode, type SessionInfo } from './store';

const agentOptions: Agent[] = ['Claude Code', 'Codex', 'Shell'];
const modeOptions: Mode[] = ['Normal', 'Plan', 'Auto-aceitar'];
const folderName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
}

export function Home() {
  const state = useAppStore();
  const [agent, setAgent] = useState<Agent>('Claude Code');
  const [mode, setMode] = useState<Mode>('Normal');
  const [prompt, setPrompt] = useState('');
  const [folder, setFolder] = useState('');
  const [date, setDate] = useState(new Date());
  const [reduced, setReduced] = useState(false);
  useEffect(() => setReduced(state.preferences.reducedEffects), [state.preferences.reducedEffects]);
  useEffect(() => { const timer = setInterval(() => setDate(new Date()), 60000); return () => clearInterval(timer); }, []);
  const formatted = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  const activeProject = state.workspace.projects.find((item) => item.id === state.activeProjectId);
  const target = folder || activeProject?.folder || '';

  const submitHome = async () => {
    if (!prompt.trim()) { state.openSession(); return; }
    if (!isTauri()) { state.setNotice('Abra o aplicativo desktop para iniciar um agente.'); return; }
    if (!target) { state.setNotice('Escolha uma pasta antes de enviar o comando.'); return; }
    try {
      const session = await invoke<SessionInfo>('terminal_start', {
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

  const recent = [...state.workspace.projects].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 4);
  const live = state.sessions.filter((session) => session.status === 'rodando' || session.status === 'iniciando');
  const { waiting, active } = state.workerSummary;

  return <div className="home">
    <div className="hero-art" aria-hidden="true" style={{ backgroundImage: `url(${reduced ? ascii : source})` }} />
    <div className="hero-veil" aria-hidden="true" />
    <div className="home-content">
      <header className="home-header">
        <div className="welcome"><img src={logo} alt="Logo Athenas Agent" /><div><div className="wordmark">ATHENAS <span>AGENT</span></div><span>Seu ateliê de agentes</span></div></div>
        <h1>{greeting()}, Victor<span>.</span></h1>
        <div className="date-line"><Clock3 size={14} /> {formatted} <span>·</span> {date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
      </header>

      {(waiting > 0 || active > 0) && <button className={`home-alert ${waiting > 0 ? 'attention' : ''}`} onClick={() => state.setSection('orchestrator')}>
        {waiting > 0 ? <AlertTriangle size={15} /> : <Network size={15} />}
        <span>{waiting > 0 ? `${waiting} worker(s) precisando da sua atenção` : `${active} worker(s) em execução`}</span>
        <b>Abrir orquestração <ArrowRight size={13} /></b>
      </button>}

      <div className="command-box">
        <div className="command-top"><Command size={14} /><span>Novo comando</span><span className="command-status" title={target ? displayPath(target) : undefined}>{target ? <>em <b>{folderName(target)}</b></> : 'Escolha uma pasta'}</span></div>
        <textarea aria-label="O que você quer construir?" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="O que você quer construir?" rows={3}
          onKeyDown={(event) => { if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); event.stopPropagation(); void submitHome(); } }} />
        <div className="command-bottom">
          <SelectField label="Agente" value={agent} options={agentOptions} onChange={setAgent} icon={(item) => <AgentIcon agent={item} />} />
          <button className="folder-select" title={folder ? displayPath(folder) : 'Escolher pasta'} onClick={async () => { const result = await chooseFolder(); if (result) setFolder(result); else if (!isTauri()) state.setNotice('Escolha a pasta no aplicativo desktop.'); }}><Folder size={14} /> <span>{folder ? folderName(folder) : activeProject ? activeProject.name : 'Pasta'}</span> <ChevronDown size={13} /></button>
          <SelectField label="Modo" value={mode} options={modeOptions} onChange={setMode} />
          <div className="command-grow" />
          <span className="command-hint" aria-hidden="true"><kbd>Ctrl</kbd><kbd>↵</kbd></span>
          <button className="send-button" aria-label="Enviar comando" title="Enviar (Ctrl Enter)" onClick={() => void submitHome()}><Send size={15} /></button>
        </div>
      </div>

      <div className="quick-actions">
        <button onClick={state.openSession}><Terminal size={15} /> Novo terminal <kbd>Ctrl T</kbd></button>
        <button onClick={state.openProject}><FolderPlus size={15} /> Novo projeto <kbd>Ctrl Shift P</kbd></button>
        <button onClick={state.openGroup}><Layers size={15} /> Novo grupo <kbd>Ctrl Shift G</kbd></button>
        <button onClick={() => state.setSection('orchestrator')}><Network size={15} /> Orquestração</button>
      </div>

      <div className="home-sections">
        <section>
          <div className="section-head"><h2>Projetos recentes</h2><span>{state.workspace.projects.length} no total</span></div>
          {recent.length ? <div className="home-list">{recent.map((project) => {
            const own = state.sessions.filter((session) => sameFolder(session.folder, project.folder));
            const running = own.filter((session) => session.status === 'rodando').length;
            return <button className="home-row" key={project.id} onClick={() => { state.setActiveSessionId(null); state.setActiveProjectId(project.id); }}>
              <div className="recent-avatar">{project.icon ? <img src={project.icon} alt="" draggable={false} /> : project.name.charAt(0).toUpperCase()}</div>
              <div className="home-row-text"><strong>{project.name}</strong><small>{displayPath(project.folder ?? '') || 'Sem pasta'}</small></div>
              <span className={`home-row-meta ${running ? 'live' : ''}`}>{running ? <><i />{running} ativo(s)</> : `${own.length} terminal(is)`}</span>
              <ArrowUpRight size={15} />
            </button>;
          })}</div> : <div className="empty-state compact"><div className="recent-avatar">A</div><div><strong>Um começo em branco.</strong><p>Seus projetos vão aparecer aqui assim que você criar o primeiro.</p></div><button className="button-quiet button-sm" onClick={state.openProject} aria-label="Criar primeiro projeto">Criar projeto</button></div>}
        </section>
        <section>
          <div className="section-head"><h2>Agentes em execução</h2><span>{live.length} ativo(s)</span></div>
          {live.length ? <div className="home-list">{live.slice(0, 5).map((session) => <button className="home-row" key={session.id} onClick={() => { state.setSection('home'); state.setActiveProjectId(null); state.setActiveSessionId(session.id); }}>
            <span className="home-row-icon"><AgentIcon agent={session.agent} size={16} /></span>
            <div className="home-row-text"><strong>{session.agent}</strong><small>{displayPath(session.folder)}</small></div>
            <StatusBadge info={sessionStatus(session.status)} />
          </button>)}</div> : <div className="empty-state compact"><span className="home-row-icon"><Terminal size={16} /></span><div><strong>Nenhum agente rodando.</strong><p>Envie um comando acima ou abra um terminal para começar.</p></div></div>}
        </section>
      </div>

      <footer className="home-footer"><span>Feito para ideias que merecem espaço</span><button onClick={() => setReduced(!reduced)}>{reduced ? 'Usar imagem' : 'Usar arte ASCII'}</button></footer>
    </div>
  </div>;
}
