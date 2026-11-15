import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { History, MessageSquare, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { ago } from './inbox';
import { displayPath, sameFolder } from './path';
import { useAppStore, type SessionInfo } from './store';
import {
  USAGE_AGENTS, compactTokens, formatUsd, totalTokens, usageByDay, usageByFolder,
  type Conversation, type PreviewMessage, type UsageReport,
} from './history';
import './history.css';

type Tab = 'conversations' | 'usage';
const AGENT_FILTERS = [{ value: '', label: 'Todos' }, { value: 'Claude Code', label: 'Claude Code' }, { value: 'Codex', label: 'Codex' }];
const PERIODS = [7, 30, 90];

function useProjectName() {
  const projects = useAppStore((state) => state.workspace.projects);
  return (folder: string) => projects.find((project) => sameFolder(project.folder, folder))?.name ?? (displayPath(folder).split(/[\\/]/).filter(Boolean).at(-1) || folder);
}

export function HistoryView() {
  const [tab, setTab] = useState<Tab>('conversations');
  if (!isTauri()) return <div className="tools-empty">Abra o aplicativo desktop para ver o histórico.</div>;
  return <div className="tools-content history-view">
    <div className="tools-heading">
      <div><span className="section-kicker">Claude Code e Codex</span><h1>Histórico</h1><p>Todas as conversas salvas neste computador, inclusive as abertas fora do Athenas.</p></div>
      <div className="segmented history-tabs" role="tablist" aria-label="Seções do histórico">
        <button role="tab" aria-selected={tab === 'conversations'} className={tab === 'conversations' ? 'active' : ''} onClick={() => setTab('conversations')}><MessageSquare size={13} /> Conversas</button>
        <button role="tab" aria-selected={tab === 'usage'} className={tab === 'usage' ? 'active' : ''} onClick={() => setTab('usage')}><History size={13} /> Consumo</button>
      </div>
    </div>
    {tab === 'conversations' ? <Conversations /> : <Usage />}
  </div>;
}

function Conversations() {
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState('');
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const projectName = useProjectName();
  const request = useRef(0);

  const load = (text: string, filter: string) => {
    const id = ++request.current;
    setLoading(true);
    invoke<Conversation[]>('history_search', { query: text.trim() || null, agent: filter || null, limit: 300 })
      .then((result) => { if (id === request.current) { setItems(result); setError(null); } })
      .catch((reason) => { if (id === request.current) setError(String(reason)); })
      .finally(() => { if (id === request.current) setLoading(false); });
  };
  // Typing waits a moment before searching; the agent filter applies at once.
  useEffect(() => { const timer = window.setTimeout(() => load(query, agent), query ? 250 : 0); return () => window.clearTimeout(timer); }, [query, agent]);

  return <div className="history-layout">
    <section className="history-list-panel">
      <div className="history-search">
        <Search size={14} />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar em pedidos e respostas…" aria-label="Buscar conversas" />
        <button className="icon-button small" title="Atualizar" aria-label="Atualizar histórico" onClick={() => load(query, agent)}><RefreshCw size={13} className={loading ? 'spin' : ''} /></button>
      </div>
      <div className="segmented history-filter" role="radiogroup" aria-label="Agente">
        {AGENT_FILTERS.map((item) => <button key={item.value} role="radio" aria-checked={agent === item.value} className={agent === item.value ? 'active' : ''} onClick={() => setAgent(item.value)}>{item.value && <AgentIcon agent={item.value} size={12} />}{item.label}</button>)}
      </div>
      {error && <p className="tools-error" role="alert">{error}</p>}
      <div className="history-count">{loading && !items.length ? 'Lendo conversas…' : `${items.length}${items.length >= 300 ? '+' : ''} conversa(s)`}</div>
      <div className="history-list" role="listbox" aria-label="Conversas">
        {items.map((item) => <button key={`${item.agent}:${item.id}`} role="option" aria-selected={selected?.id === item.id} className={`history-item ${selected?.id === item.id ? 'selected' : ''}`} onClick={() => setSelected(item)}>
          <span className="history-item-icon"><AgentIcon agent={item.agent} size={14} /></span>
          <span className="history-item-text">
            <strong>{item.title}</strong>
            {item.snippet && <span className="history-snippet">{item.snippet}</span>}
            <small>{projectName(item.folder)} · {ago(item.updatedAt)} · {item.prompts} pedido(s) · {compactTokens(totalTokens(item.tokens))} tokens</small>
          </span>
        </button>)}
        {!loading && !items.length && !error && <div className="inbox-empty compact"><p>{query ? 'Nenhuma conversa com esses termos.' : 'Nenhuma conversa encontrada em ~/.claude ou ~/.codex.'}</p></div>}
      </div>
    </section>
    <section className="history-preview-panel">{selected ? <Preview conversation={selected} /> : <div className="inbox-empty"><MessageSquare size={20} /><strong>Escolha uma conversa.</strong><p>Veja os pedidos e respostas e retome de onde parou.</p></div>}</section>
  </div>;
}

function Preview({ conversation }: { conversation: Conversation }) {
  const [messages, setMessages] = useState<PreviewMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectName = useProjectName();
  const { setNotice, upsertSession, setSection, setActiveProjectId, setActiveSessionId } = useAppStore();
  useEffect(() => {
    setMessages(null); setError(null);
    let alive = true;
    invoke<PreviewMessage[]>('history_messages', { agent: conversation.agent, id: conversation.id })
      .then((result) => { if (alive) setMessages(result); })
      .catch((reason) => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, [conversation.agent, conversation.id]);

  const resume = async () => {
    try {
      const session = await invoke<SessionInfo>('terminal_start', {
        agent: conversation.agent, folder: conversation.folder, command: '', resumeId: conversation.id, paneId: null,
        resume: true, mode: null, initialPrompt: null, cols: 100, rows: 30, title: conversation.title.slice(0, 60),
      });
      upsertSession(session);
      setSection('home'); setActiveProjectId(null); setActiveSessionId(session.id);
    } catch (reason) { setNotice(String(reason)); }
  };

  return <div className="history-preview">
    <header>
      <span className="history-item-icon"><AgentIcon agent={conversation.agent} size={16} /></span>
      <div><h2>{conversation.title}</h2><small title={displayPath(conversation.folder)}>{projectName(conversation.folder)} · {new Date(conversation.updatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}{conversation.model ? ` · ${conversation.model}` : ''}</small></div>
      <button className="button-primary button-sm" onClick={() => void resume()}><RotateCcw size={13} /> Retomar</button>
    </header>
    <div className="history-stats">
      <span><b>{conversation.prompts}</b> pedidos</span>
      <span><b>{compactTokens(totalTokens(conversation.tokens))}</b> tokens</span>
      <span title="Tokens lidos do cache do modelo"><b>{compactTokens(conversation.tokens.cacheRead)}</b> em cache</span>
      {conversation.costUsd != null && <span title="Estimativa registrada pelo Claude Code"><b>{formatUsd(conversation.costUsd)}</b> estimado</span>}
    </div>
    <div className="history-messages">
      {error && <p className="tools-error" role="alert">{error}</p>}
      {!messages && !error && <p className="history-loading">Carregando conversa…</p>}
      {messages?.map((message, index) => <div key={index} className={`history-message ${message.role}`}>
        <small>{message.role === 'user' ? 'Você' : conversation.agent}{message.at ? ` · ${new Date(message.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}</small>
        <p>{message.text}</p>
      </div>)}
      {messages && messages.length === 0 && <p className="history-loading">Sem mensagens de texto nesta conversa.</p>}
    </div>
  </div>;
}

function Usage() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const projectName = useProjectName();
  useEffect(() => {
    let alive = true;
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
    invoke<UsageReport>('history_usage', { since: since.getTime() })
      .then((result) => { if (alive) { setReport(result); setError(null); } })
      .catch((reason) => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, [days]);
  const daily = useMemo(() => (report ? usageByDay(report.buckets, days) : []), [report, days]);
  const folders = useMemo(() => (report ? usageByFolder(report.buckets).slice(0, 10) : []), [report]);
  const totals = useMemo(() => {
    const byAgent: Record<string, number> = {};
    for (const day of daily) for (const [agent, value] of Object.entries(day.byAgent)) byAgent[agent] = (byAgent[agent] ?? 0) + value;
    return { byAgent, total: Object.values(byAgent).reduce((sum, value) => sum + value, 0) };
  }, [daily]);
  const max = Math.max(1, ...daily.map((day) => day.total));
  const scale = niceMax(max);
  const label = (day: string) => { const [, month, date] = day.split('-'); return `${date}/${month}`; };

  return <div className="usage-view">
    <div className="usage-toolbar">
      <div className="segmented" role="radiogroup" aria-label="Período">
        {PERIODS.map((value) => <button key={value} role="radio" aria-checked={days === value} className={days === value ? 'active' : ''} onClick={() => setDays(value)}>{value} dias</button>)}
      </div>
    </div>
    {error && <p className="tools-error" role="alert">{error}</p>}
    {!report && !error && <p className="history-loading">Calculando consumo…</p>}
    {report && <>
      <div className="usage-tiles">
        <div className="usage-tile"><small>Tokens no período</small><strong>{compactTokens(totals.total)}</strong><span>{report.conversations} conversa(s)</span></div>
        {USAGE_AGENTS.map((agent) => <div className="usage-tile" key={agent}><small><i className={`usage-swatch ${agent === 'Codex' ? 'codex' : 'claude'}`} />{agent}</small><strong>{compactTokens(totals.byAgent[agent] ?? 0)}</strong><span>{totals.total ? `${Math.round(((totals.byAgent[agent] ?? 0) / totals.total) * 100)}% do total` : '—'}</span></div>)}
        <div className="usage-tile" title="Soma das estimativas que o Claude Code registra por conversa (conversas inteiras com uso no período). Em planos de assinatura, é uma referência, não uma cobrança."><small>Custo estimado (Claude)</small><strong>{formatUsd(report.claudeCostUsd)}</strong><span>referência do Claude Code</span></div>
      </div>

      <section className="usage-card">
        <div className="usage-card-head">
          <h2>Tokens por dia</h2>
          <div className="usage-legend">{USAGE_AGENTS.map((agent) => <span key={agent}><i className={`usage-swatch ${agent === 'Codex' ? 'codex' : 'claude'}`} />{agent}</span>)}</div>
          <button className="button-ghost button-sm" aria-pressed={table} onClick={() => setTable(!table)}>{table ? 'Ver gráfico' : 'Ver tabela'}</button>
        </div>
        {table
          ? <table className="usage-table"><thead><tr><th>Dia</th>{USAGE_AGENTS.map((agent) => <th key={agent}>{agent}</th>)}<th>Total</th></tr></thead>
            <tbody>{[...daily].reverse().map((day) => <tr key={day.day}><td>{label(day.day)}</td>{USAGE_AGENTS.map((agent) => <td key={agent}>{compactTokens(day.byAgent[agent] ?? 0)}</td>)}<td>{compactTokens(day.total)}</td></tr>)}</tbody></table>
          : <div className="usage-chart" role="img" aria-label={`Tokens por dia nos últimos ${days} dias; máximo de ${compactTokens(max)} em um dia. Use "Ver tabela" para os valores.`}>
            <div className="usage-axis" aria-hidden="true">{[1, 0.5, 0].map((step) => <span key={step} style={{ bottom: `${step * 100}%` }}>{compactTokens(Math.round(scale * step))}</span>)}</div>
            <div className="usage-plot" onMouseLeave={() => setHover(null)}>
              {[1, 0.5].map((step) => <i key={step} className="usage-gridline" style={{ bottom: `${step * 100}%` }} />)}
              {daily.map((day, index) => <div key={day.day} className={`usage-column ${hover === index ? 'hover' : ''}`} onMouseEnter={() => setHover(index)}>
                <div className="usage-stack" style={{ height: `${(day.total / scale) * 100}%` }}>
                  {USAGE_AGENTS.map((agent) => day.byAgent[agent] ? <span key={agent} className={`usage-segment ${agent === 'Codex' ? 'codex' : 'claude'}`} style={{ flexGrow: day.byAgent[agent] }} /> : null)}
                </div>
                {hover === index && <div className={`usage-tooltip ${index > daily.length * 0.7 ? 'left' : ''}`} role="status">
                  <strong>{new Date(`${day.day}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })}</strong>
                  {USAGE_AGENTS.map((agent) => <span key={agent}><i className={`usage-swatch ${agent === 'Codex' ? 'codex' : 'claude'}`} />{agent}<b>{compactTokens(day.byAgent[agent] ?? 0)}</b></span>)}
                  <span className="usage-tooltip-total">Total<b>{compactTokens(day.total)}</b></span>
                </div>}
              </div>)}
            </div>
            <div className="usage-xlabels" aria-hidden="true">{daily.map((day, index) => <span key={day.day}>{index === 0 || index === daily.length - 1 || index % Math.ceil(daily.length / 6) === 0 ? label(day.day) : ''}</span>)}</div>
          </div>}
      </section>

      <div className="usage-columns">
        <section className="usage-card">
          <div className="usage-card-head"><h2>Por projeto</h2></div>
          {folders.length ? <table className="usage-table projects"><thead><tr><th>Projeto</th>{USAGE_AGENTS.map((agent) => <th key={agent}>{agent}</th>)}<th>Total</th></tr></thead>
            <tbody>{folders.map((item) => <tr key={item.folder}><td title={displayPath(item.folder)}><span className="usage-project">{projectName(item.folder)}</span><span className="usage-share"><i style={{ width: `${(item.total / (folders[0]?.total || 1)) * 100}%` }} /></span></td>{USAGE_AGENTS.map((agent) => <td key={agent}>{compactTokens(item.byAgent[agent] ?? 0)}</td>)}<td>{compactTokens(item.total)}</td></tr>)}</tbody></table>
            : <p className="history-loading">Sem uso no período.</p>}
        </section>
        <section className="usage-card">
          <div className="usage-card-head"><h2>Conversas que mais consumiram</h2></div>
          {report.top.length ? <div className="usage-top">{report.top.map((item) => <div key={`${item.agent}:${item.id}`} className="usage-top-row">
            <AgentIcon agent={item.agent} size={13} />
            <span><strong>{item.title}</strong><small>{projectName(item.folder)} · {ago(item.updatedAt)}</small></span>
            <b>{compactTokens(totalTokens(item.tokens))}</b>
          </div>)}</div> : <p className="history-loading">Sem uso no período.</p>}
        </section>
      </div>
      <p className="usage-note">Tokens incluem entrada, saída e cache (leitura e escrita). O cache costuma ser a maior parte e custa bem menos que a entrada normal.</p>
    </>}
  </div>;
}

/** Round axis maximum: 1, 2 or 5 times a power of ten, at least the value. */
export function niceMax(value: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(value, 1)));
  for (const step of [1, 2, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}
