import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentIcon } from '../AgentIcon';
import logo from '../assets/brand/ui-logo.png';
import { StatusDot, formatDuration, type StatusTone } from '../status';
import { THEMES } from '../themes';
import { ApiError, api, type AgentCard, type Overview } from './api';
import { ConversationView } from './ConversationView';
import { Notifications } from './Notifications';
import { dropLocal, registerWorker } from './push';

const REFRESH = 3_000;
const PAIR_POLL = 1_500;
const WAITING_KEY = 'athenas-pairing';

type Waiting = { requestId: string; verification: string };
type Screen =
  | { kind: 'loading' }
  | { kind: 'unpaired'; message?: string }
  | { kind: 'offer'; code: string }
  | ({ kind: 'waiting' } & Waiting)
  | { kind: 'agents' };

/** The pairing code arrives after `#`; it is removed from the address as soon as it is read. */
export function takeCode(): string | null {
  const code = /^#pair=([0-9a-f]{64})$/.exec(window.location.hash)?.[1] ?? null;
  if (window.location.hash.startsWith('#pair=')) window.history.replaceState(null, '', window.location.pathname);
  return code;
}

/** A tapped notification opens the page at `#agent=<session>`. */
export function takeAgent(): string | null {
  const match = /^#agent=([0-9a-zA-Z-]{1,64})$/.exec(window.location.hash);
  if (window.location.hash.startsWith('#agent=')) window.history.replaceState(null, '', window.location.pathname);
  return match?.[1] ?? null;
}

function remember(waiting: Waiting | null) {
  try {
    if (waiting) sessionStorage.setItem(WAITING_KEY, JSON.stringify(waiting));
    else sessionStorage.removeItem(WAITING_KEY);
  } catch { /* without storage a reload only asks for a new code */ }
}

function remembered(): Waiting | null {
  try { return JSON.parse(sessionStorage.getItem(WAITING_KEY) ?? 'null') as Waiting | null; } catch { return null; }
}

function applyPhoneTheme(theme: string | null) {
  if (!theme || !THEMES.some((item) => item.id === theme)) return;
  document.documentElement.dataset.theme = theme;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim();
  if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

const needsYou = (agent: AgentCard) => agent.tone === 'waiting';

function Card({ agent, now, onOpen }: { agent: AgentCard; now: number; onOpen?: (id: string) => void }) {
  const elapsed = agent.since && (agent.tone === 'running' || agent.tone === 'waiting') ? formatDuration((now - agent.since) / 1000) : null;
  return <li><button type="button" className={`phone-card tone-${agent.tone}`} disabled={!onOpen} onClick={() => onOpen?.(agent.id)}>
    <span className="phone-card-icon"><AgentIcon agent={agent.agent} size={22} /></span>
    <span className="phone-card-body">
      <strong>{agent.title?.trim() || agent.agent}</strong>
      <small>{[agent.agent, agent.project ?? agent.folder].filter(Boolean).join(' · ')}</small>
      {agent.tone === 'waiting' && agent.message && <span className="phone-card-message">{agent.message}</span>}
    </span>
    <span className="phone-card-status">
      <span><StatusDot info={{ tone: agent.tone as StatusTone, label: agent.label, live: agent.tone === 'running' }} />{agent.label}</span>
      {elapsed && <small>{elapsed}</small>}
    </span>
  </button></li>;
}

function Agents({ overview, offline, onOpen, onRefresh, onLogout }: { overview: Overview; offline: boolean; onOpen: (id: string) => void; onRefresh: () => void; onLogout: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const now = Date.now();
  const urgent = overview.agents.filter(needsYou);
  const others = overview.agents.filter((agent) => !needsYou(agent));
  return <main className="phone">
    <header className="phone-header">
      <img src={logo} alt="" />
      <div><h1>Agentes</h1><small>{overview.computer || 'Seu computador'}</small></div>
      <span className={`phone-link ${offline ? 'tone-error' : 'tone-done'}`} role="status"><i />{offline ? 'Sem conexão' : 'Conectado'}</span>
    </header>
    {offline && <p className="phone-banner">Não foi possível falar com o computador. Confira se ele está ligado, com o Athenas aberto, e se o Tailscale está ativo. A lista abaixo pode estar desatualizada.</p>}
    {!overview.canControl && <p className="phone-banner">Para abrir conversas, enviar mensagens e aprovar, libere este aparelho no computador: <b>Ajustes → Celular → Pode conversar e aprovar</b>.</p>}
    <Notifications registered={overview.notifications} onChange={onRefresh} />
    {urgent.length > 0 && <section><h2>Precisam de você</h2><ul>{urgent.map((agent) => <Card key={agent.id} agent={agent} now={now} onOpen={overview.canControl ? onOpen : undefined} />)}</ul></section>}
    {others.length > 0 && <section><h2>{urgent.length > 0 ? 'Outros agentes' : 'Em execução'}</h2><ul>{others.map((agent) => <Card key={agent.id} agent={agent} now={now} onOpen={overview.canControl ? onOpen : undefined} />)}</ul></section>}
    {overview.agents.length === 0 && <p className="phone-empty">Nenhum agente em execução no momento.</p>}
    <footer>
      {leaving
        ? <div className="phone-actions"><button type="button" onClick={() => setLeaving(false)}>Cancelar</button><button type="button" className="danger" onClick={onLogout}>Confirmar desconexão</button></div>
        : <button type="button" onClick={() => setLeaving(true)}>Desconectar este aparelho</button>}
    </footer>
  </main>;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="phone phone-center"><img src={logo} alt="" /><h1>{title}</h1>{children}</main>;
}

export function PhoneApp() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [overview, setOverview] = useState<Overview | null>(null);
  const [offline, setOffline] = useState(false);
  const [name, setName] = useState('Meu celular');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const code = useRef<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** The open agent as last listed, so its conversation survives the agent ending. */
  const shown = useRef<AgentCard | null>(null);

  // Android's back button leaves the conversation instead of the app.
  const open = useCallback((id: string) => {
    if (window.history.state?.agent) window.history.replaceState({ agent: id }, '');
    else window.history.pushState({ agent: id }, '');
    setSelected(id);
  }, []);
  const back = useCallback(() => {
    if (window.history.state?.agent) window.history.back();
    else setSelected(null);
  }, []);

  /** `justPaired` is what to say if the computer does not recognise a device it has just accepted. */
  const load = useCallback(async (justPaired?: string) => {
    try {
      const next = await api.agents();
      applyPhoneTheme(next.theme);
      remember(null);
      setOverview(next);
      setOffline(false);
      setScreen({ kind: 'agents' });
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        setOverview(null);
        const waiting = remembered();
        if (justPaired) setScreen({ kind: 'unpaired', message: justPaired });
        else if (code.current) setScreen({ kind: 'offer', code: code.current });
        else if (waiting) setScreen({ kind: 'waiting', ...waiting });
        // Polling stops on this screen, so a message set here stays.
        else setScreen((current) => (current.kind === 'unpaired' ? current : { kind: 'unpaired', message: current.kind === 'agents' ? 'O acesso deste aparelho foi revogado.' : undefined }));
      } else {
        setOffline(true);
        // The device is accepted; keep trying until the list arrives.
        if (justPaired) setScreen({ kind: 'loading' });
      }
    }
  }, []);

  useEffect(() => {
    code.current = takeCode() ?? code.current;
    const tapped = takeAgent();
    if (tapped) open(tapped);
    registerWorker();
    void load();
    // Scanning again, or tapping a notification, with the page already open only changes the part after `#`.
    const scanned = () => {
      const next = takeCode();
      if (next) { code.current = next; setError(''); void load(); }
      const agent = takeAgent();
      if (agent) open(agent);
    };
    const moved = (event: PopStateEvent) => setSelected((event.state as { agent?: string } | null)?.agent ?? null);
    const told = (event: MessageEvent) => {
      if (event.data?.type !== 'open-agent' || typeof event.data.session !== 'string') return;
      open(event.data.session);
      void load();
    };
    window.addEventListener('hashchange', scanned);
    window.addEventListener('popstate', moved);
    navigator.serviceWorker?.addEventListener('message', told);
    return () => {
      window.removeEventListener('hashchange', scanned);
      window.removeEventListener('popstate', moved);
      navigator.serviceWorker?.removeEventListener('message', told);
    };
  }, [load, open]);

  // A notification tapped on a locked device must not open the conversation later, out of nowhere.
  const locked = overview !== null && !overview.canControl;
  useEffect(() => { if (locked && selected) back(); }, [locked, selected, back]);

  // Keeps the list fresh while the page is on screen, and retries a first load that failed.
  const polling = screen.kind === 'agents' || (screen.kind === 'loading' && offline);
  useEffect(() => {
    if (!polling) return;
    let active = true;
    let timer = 0;
    const loop = async () => {
      if (document.visibilityState === 'visible') await load();
      if (active) timer = window.setTimeout(loop, REFRESH);
    };
    timer = window.setTimeout(loop, REFRESH);
    const wake = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', wake);
    return () => { active = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', wake); };
  }, [polling, load]);

  const requestId = screen.kind === 'waiting' ? screen.requestId : null;
  useEffect(() => {
    if (!requestId) return;
    let active = true;
    let timer = 0;
    const give = (message: string) => { remember(null); setScreen({ kind: 'unpaired', message }); };
    const loop = async () => {
      try {
        const { status } = await api.pairStatus(requestId);
        if (!active) return;
        setOffline(false);
        if (status === 'paired') {
          remember(null);
          // Not being recognised now means the browser did not keep the cookie.
          await load('O navegador não guardou o acesso. Abra o link no Chrome, fora da guia anônima.');
          return;
        }
        if (status === 'denied') return give('O pedido foi recusado no computador.');
        if (status === 'expired') return give('O pedido expirou. Gere um novo código no computador.');
      } catch { if (active) setOffline(true); }
      if (active) timer = window.setTimeout(loop, PAIR_POLL);
    };
    timer = window.setTimeout(loop, PAIR_POLL);
    return () => { active = false; window.clearTimeout(timer); };
  }, [requestId, load]);

  const pair = async (event: React.FormEvent) => {
    event.preventDefault();
    if (screen.kind !== 'offer' || sending) return;
    setSending(true);
    setError('');
    try {
      const answer = await api.pair(screen.code, name);
      code.current = null;
      remember(answer);
      setScreen({ kind: 'waiting', ...answer });
    } catch (failure) {
      if (failure instanceof ApiError) { code.current = null; setScreen({ kind: 'unpaired', message: failure.message }); }
      else setError('Sem conexão com o computador. Confira o Tailscale e tente de novo.');
    } finally { setSending(false); }
  };

  const logout = () => void api.logout()
    .then(() => { void dropLocal().catch(() => undefined); setOverview(null); setSelected(null); setScreen({ kind: 'unpaired', message: 'Aparelho desconectado.' }); })
    .catch(() => setOffline(true));

  if (screen.kind === 'agents' && overview) {
    const listed = overview.agents.find((agent) => agent.id === selected);
    if (listed) shown.current = listed;
    const agent = listed ?? (shown.current?.id === selected ? shown.current : null);
    if (agent && overview.canControl) return <ConversationView key={agent.id} agent={agent} ended={!listed} onBack={back} onUnauthorized={() => { setSelected(null); void load(); }} />;
    return <Agents overview={overview} offline={offline} onOpen={open} onRefresh={() => void load()} onLogout={logout} />;
  }
  if (screen.kind === 'offer') return <Notice title="Parear este aparelho">
    <p>Dê um nome para reconhecê-lo no computador.</p>
    <form onSubmit={pair}>
      <label>Nome do aparelho<input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></label>
      <button className="primary" disabled={sending}>{sending ? 'Enviando…' : 'Parear'}</button>
    </form>
    {error && <p className="phone-banner" role="alert">{error}</p>}
  </Notice>;
  if (screen.kind === 'waiting') return <Notice title="Confirme no computador">
    <p>No Athenas, confira se o número é este e toque em <b>Permitir</b>.</p>
    <output className="phone-number">{screen.verification}</output>
    {offline && <p className="phone-banner" role="alert">Sem conexão com o computador. Tentando de novo…</p>}
  </Notice>;
  if (screen.kind === 'unpaired') return <Notice title="Aparelho não pareado">
    {screen.message && <p className="phone-banner" role="alert">{screen.message}</p>}
    <p>No computador, abra <b>Configurações → Celular</b>, toque em <b>Parear celular</b> e escaneie o QR code.</p>
  </Notice>;
  return <Notice title="Athenas Agent"><p role="status">{offline ? 'Sem conexão com o computador. Tentando de novo…' : 'Conectando…'}</p></Notice>;
}
