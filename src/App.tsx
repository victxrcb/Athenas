import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { lazy, Suspense } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, ChevronRight, Clock3, Code2, Command, FileText, Folder, GitBranch, Home, Minus, PanelLeft, Plus, Search, Send, Settings2, Square, Terminal, X } from 'lucide-react';
import logo from './assets/brand/ui-logo.png';
import ascii from './assets/brand/hera-ascii.svg';
import source from './assets/brand/hera-source.jpg';
import { Agent, Mode, useAppStore } from './store';
const TerminalView = lazy(() => import('./TerminalView').then((module) => ({ default: module.TerminalView })));

const agentOptions: Agent[] = ['Claude Code', 'Codex', 'Shell'];
const modeOptions: Mode[] = ['Normal', 'Plan', 'Auto-aceitar'];

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
}

function WindowBar() {
  const action = (name: 'minimize' | 'toggleMaximize' | 'close') => {
    if (isTauri()) void getCurrentWindow()[name]();
  };
  return <div className="window-bar" data-tauri-drag-region>
    <div className="window-brand" data-tauri-drag-region><img src={logo} alt="" /> <span>Hera Agent</span></div>
    <div className="window-center" data-tauri-drag-region>ESPAÇO DE TRABALHO <span>·</span> LOCAL</div>
    <div className="window-controls">
      <button aria-label="Minimizar" onClick={() => action('minimize')}><Minus size={15} /></button>
      <button aria-label="Maximizar" onClick={() => action('toggleMaximize')}><Square size={12} /></button>
      <button aria-label="Fechar" className="close-window" onClick={() => action('close')}><X size={16} /></button>
    </div>
  </div>;
}

function Sidebar() {
  const { openSession, openProject, sessions, activeSessionId, setActiveSessionId, upsertSession, setNotice } = useAppStore();
  return <aside className="sidebar">
    <div className="sidebar-top">
      <button className="sidebar-icon active" aria-label="Início"><Home size={18} /></button>
      <button className="sidebar-icon" aria-label="Arquivos" onClick={openProject}><Folder size={18} /></button>
      <button className="sidebar-icon" aria-label="Git" onClick={() => useAppStore.getState().setNotice('Git ainda não está disponível nesta versão.')}><GitBranch size={18} /></button>
      <button className="sidebar-icon" aria-label="Buscar" onClick={() => useAppStore.getState().setNotice('Busca ainda não está disponível nesta versão.')}><Search size={18} /></button>
    </div>
    <div className="sidebar-content">
      <div className="section-kicker">SEU ESPAÇO</div>
      <button className="new-agent" onClick={openSession}><Plus size={16} /> Novo agente <kbd>Ctrl T</kbd></button>
      <div className="sidebar-heading"><span>PROJETOS</span><button aria-label="Novo projeto" onClick={openProject}><Plus size={15} /></button></div>
      {sessions.length ? <div className="session-list">{sessions.map((session) => <div className="session-row" key={session.id}><button className={activeSessionId === session.id ? 'selected' : ''} onClick={() => setActiveSessionId(session.id)}><Terminal size={14} /><span>{session.agent}<small>{session.folder.split(/[\\/]/).pop()}</small></span><i className={session.status} title={session.status} /></button>{session.status !== 'rodando' && session.agent !== 'Shell' && <button className="resume-button" onClick={async () => { try { const resumed = await invoke<import('./store').SessionInfo>('terminal_start', { agent: session.agent, folder: session.folder, command: session.command, resumeId: session.resumeId, resume: true, cols: 100, rows: 30 }); upsertSession(resumed); setActiveSessionId(resumed.id); } catch (error) { setNotice(String(error)); } }}>Retomar</button>}</div>)}</div> : <div className="sidebar-empty"><span className="empty-mark">✧</span><p>Seu próximo projeto começa aqui.</p><small>Crie uma sessão para começar.</small></div>}
    </div>
    <div className="sidebar-bottom"><button className="layout-select" onClick={() => useAppStore.getState().setNotice('Layouts ainda não estão disponíveis nesta versão.')}><PanelLeft size={15} /> Organização <ChevronDown size={14} /></button><div className="account"><img src={logo} alt="" /><span>conta local <b>· Default</b></span><Settings2 size={15} /></div></div>
  </aside>;
}

function SelectField<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: T[]; onChange: (value: T) => void }) {
  return <label className="select-field"><span>{label}</span><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select><ChevronDown size={14} /></label>;
}

async function chooseFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  const chosen = await open({ directory: true, multiple: false, title: 'Escolher pasta do projeto' });
  return typeof chosen === 'string' ? chosen : null;
}

function SessionModal() {
  const { sessionOpen, closeSession, setNotice, openSession } = useAppStore();
  const [agent, setAgent] = useState<Agent>('Claude Code');
  const [mode, setMode] = useState<Mode>('Normal');
  const [folder, setFolder] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [command, setCommand] = useState('');
  if (!sessionOpen) return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!folder.trim()) { setNotice('Escolha uma pasta antes de abrir a sessão.'); return; }
    if (mode !== 'Normal') { setNotice('Os modos Plan e Auto-aceitar ainda não estão disponíveis. Escolha Normal.'); return; }
    if (!isTauri()) { setNotice('Abra o aplicativo desktop para iniciar um terminal real.'); return; }
    try {
      const session = await invoke<import('./store').SessionInfo>('terminal_start', { agent, folder, command, resumeId: null, resume: false, cols: 100, rows: 30 });
      useAppStore.getState().upsertSession(session);
      useAppStore.getState().setActiveSessionId(session.id);
    } catch (error) { setNotice(String(error)); return; }
    if (!createMore) closeSession();
    else openSession();
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSession(); }}>
    <form className="modal" role="dialog" aria-modal="true" aria-label="Nova sessão" onSubmit={submit}>
      <div className="modal-top"><span className="section-kicker">NOVA SESSÃO</span><button type="button" aria-label="Fechar modal" onClick={closeSession}><X size={18} /></button></div>
      <h2>Abra um novo caminho.</h2><p className="modal-intro">Escolha seu agente e a pasta onde o trabalho vai acontecer.</p>
      <div className="form-field"><span>Abrir como</span><div className="mode-card"><Terminal size={18} /> Terminal</div></div>
      <div className="form-grid"><SelectField label="Agente" value={agent} options={agentOptions} onChange={setAgent} /><SelectField label="Modo" value={mode} options={modeOptions} onChange={setMode} /></div>
      <label className="form-field"><span>Pasta</span><div className="folder-row"><input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="C:\\caminho\\do\\projeto" aria-label="Pasta" /><button type="button" onClick={async () => { const result = await chooseFolder(); if (result) setFolder(result); else if (!isTauri()) setNotice('O seletor de pasta funciona no app desktop. Digite o caminho para testar no navegador.'); }}>Escolher pasta</button></div></label>
      <button className="advanced-toggle" type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? <ChevronDown size={15} /> : <ChevronRight size={15} />} Avançado</button>
      {advanced && <div className="advanced-fields">
        <label>Permissões<select defaultValue="Padrão"><option>Padrão</option><option>Solicitar confirmação</option><option>Auto-aceitar</option></select></label>
        <label>Runtime<select defaultValue="Local"><option>Local</option></select></label>
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
  if (!openModal) return null;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><form className="modal small-modal" role="dialog" aria-modal="true" aria-label={kind === 'project' ? 'Novo projeto' : 'Novo grupo'} onSubmit={(event) => { event.preventDefault(); if (name.trim()) { state.setNotice(`${kind === 'project' ? 'Projetos' : 'Grupos'} ainda não estão disponíveis nesta versão.`); close(); setName(''); } }}><div className="modal-top"><span className="section-kicker">{kind === 'project' ? 'NOVO PROJETO' : 'NOVO GRUPO'}</span><button type="button" onClick={close} aria-label="Fechar modal"><X size={18} /></button></div><h2>Nomeie seu espaço.</h2><label className="form-field"><span>Nome</span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus required /></label><div className="modal-footer"><span /><div><button type="button" className="button-quiet" onClick={close}>Cancelar</button><button className="button-primary">Criar</button></div></div></form></div>;
}

export function App() {
  const state = useAppStore();
  const [agent, setAgent] = useState<Agent>('Claude Code');
  const [mode, setMode] = useState<Mode>('Normal');
  const [prompt, setPrompt] = useState('');
  const [folder, setFolder] = useState('');
  const [date, setDate] = useState(new Date());
  const [reduced, setReduced] = useState(false);
  useEffect(() => { if (isTauri()) void invoke<import('./store').SessionInfo[]>('terminal_list').then(state.setSessions).catch((error) => state.setNotice(String(error))); }, [state.setSessions, state.setNotice]);
  useEffect(() => { const timer = setInterval(() => setDate(new Date()), 60000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { state.closeSession(); state.closeProject(); state.closeGroup(); state.setNotice(null); }
      if (!event.ctrlKey) return;
      if (event.key.toLowerCase() === 't') { event.preventDefault(); state.openSession(); }
      if (event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); state.openProject(); }
      if (event.shiftKey && event.key.toLowerCase() === 'g') { event.preventDefault(); state.openGroup(); }
      if (event.key === 'Enter' && state.sessionOpen) { event.preventDefault(); (document.querySelector('.modal button[type="submit"]') as HTMLButtonElement | null)?.click(); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [state]);
  const formatted = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  const activeSession = state.sessions.find((item) => item.id === state.activeSessionId);
  return <div className="app-shell">
    <WindowBar />
    <div className="workspace"><Sidebar /><main className="main-area"><div className="tab-bar"><div className="history-buttons"><button aria-label="Voltar" disabled><ArrowLeft size={16} /></button><button aria-label="Avançar" disabled><ArrowRight size={16} /></button></div><button className="app-tab" onClick={() => state.setActiveSessionId(null)}><Home size={15} /> Início <span className="tab-count">{state.sessions.filter((item) => item.status === 'rodando').length}</span></button>{activeSession && <div className="app-tab"><Terminal size={15} /> {activeSession.agent}<button aria-label="Ocultar terminal" onClick={() => state.setActiveSessionId(null)}><X size={13} /></button></div>}<button className="tab-plus" aria-label="Nova sessão" onClick={state.openSession}><Plus size={16} /></button><div className="tab-spacer" /><span className="local-badge"><span /> Local</span></div>
      {activeSession && activeSession.status === 'rodando' ? <Suspense fallback={<div className="terminal-ended">Carregando terminal…</div>}><TerminalView session={activeSession} onStatus={state.upsertSession} /></Suspense> : activeSession ? <div className="terminal-ended"><h2>{activeSession.agent}</h2><p>Esta sessão terminou ({activeSession.status}).</p>{activeSession.agent !== 'Shell' && <button className="button-primary" onClick={async () => { try { const resumed = await invoke<import('./store').SessionInfo>('terminal_start', { agent: activeSession.agent, folder: activeSession.folder, command: activeSession.command, resumeId: activeSession.resumeId, resume: true, cols: 100, rows: 30 }); state.upsertSession(resumed); state.setActiveSessionId(resumed.id); } catch (error) { state.setNotice(String(error)); } }}>Retomar</button>}</div> : <div className="home"><div className="hero-art" aria-hidden="true" style={{ backgroundImage: `url(${reduced ? source : ascii})` }} />
        <div className="home-content"><div className="home-eyebrow"><span className="eyebrow-line" /> O ESPAÇO ENTRE A IDEIA E O FEITO</div><div className="welcome"><img src={logo} alt="Logo Hera Agent" /><div><div className="wordmark">HERA <span>AGENT</span></div><span>SEU ATELIÊ DE AGENTES</span></div></div><h1>{greeting()}, Victor<span>.</span></h1><div className="date-line"><Clock3 size={15} /> {formatted} <span>·</span> {date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
          <div className="command-box"><div className="command-top"><Command size={16} /><span>NOVO COMANDO</span><span className="command-status">PRONTO PARA COMEÇAR</span></div><textarea aria-label="O que você quer construir?" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="O que você quer construir?" rows={3} /><div className="command-bottom"><SelectField label="Agente" value={agent} options={agentOptions} onChange={setAgent} /><button className="folder-select" onClick={async () => { const result = await chooseFolder(); if (result) setFolder(result); else if (!isTauri()) state.setNotice('Escolha a pasta no aplicativo desktop.'); }}><Folder size={15} /> {folder ? folder.split(/[\\/]/).pop() : 'Pasta'} <ChevronDown size={13} /></button><SelectField label="Modo" value={mode} options={modeOptions} onChange={setMode} /><div className="command-grow" /><button className="send-button" aria-label="Enviar comando" onClick={() => { if (!prompt.trim()) { state.openSession(); return; } state.setNotice('O envio ao agente ainda não está disponível nesta versão. Seu texto permanece nesta caixa.'); }}><Send size={17} /></button></div></div>
          <div className="quick-actions"><button onClick={state.openSession}><Terminal size={16} /> Novo terminal <ArrowUpRight size={14} /></button><button onClick={state.openProject}><Folder size={16} /> Novo projeto <ArrowUpRight size={14} /></button></div>
          <div className="home-sections"><section><div className="section-head"><h2>Projetos recentes</h2><span>SEU TRABALHO, À MÃO</span></div><div className="recent-empty"><div className="recent-avatar">H</div><div><strong>Um começo em branco.</strong><p>Seus projetos vão aparecer aqui assim que você criar o primeiro.</p></div><button onClick={state.openProject} aria-label="Criar primeiro projeto"><ArrowUpRight size={18} /></button></div></section><section><div className="section-head"><h2>Comece algo</h2><span>ATALHOS</span></div><div className="start-list"><button onClick={state.openSession}><Terminal size={18} /><span>Novo terminal</span><kbd>Ctrl T</kbd><ChevronRight size={15} /></button><button onClick={state.openProject}><Folder size={18} /><span>Novo projeto</span><kbd>Ctrl Shift P</kbd><ChevronRight size={15} /></button><button onClick={state.openGroup}><Code2 size={18} /><span>Novo grupo</span><kbd>Ctrl Shift G</kbd><ChevronRight size={15} /></button></div></section></div>
          <div className="home-footer"><span>✦</span> FEITO PARA IDEIAS QUE MERECEM ESPAÇO <button onClick={() => setReduced(!reduced)}>{reduced ? 'Usar arte ASCII' : 'Reduzir efeitos'}</button></div></div></div>}
    </main></div>
    <SessionModal /><SmallModal kind="project" /><SmallModal kind="group" />
    {state.notice && <div className="toast" role="status"><FileText size={16} />{state.notice}<button aria-label="Fechar aviso" onClick={() => state.setNotice(null)}><X size={16} /></button></div>}
  </div>;
}
