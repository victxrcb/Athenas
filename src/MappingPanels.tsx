import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Activity, ArrowDownToLine, ArrowRight, CalendarClock, ChevronDown, ChevronUp, Clock3, Crosshair, Cpu, MemoryStick, Pause, Play, Power, TerminalSquare, X } from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { renameSession, sessionLabel, useActivityStore } from './activity';
import { confirmAction } from './confirm';
import type { AgentLink } from './links';
import { mappingEventDescription, MAPPING_EVENT_KINDS, useMappingEvents } from './mappingActivity';
import { displayPath } from './path';
import { useScheduleStore } from './schedule';
import { useLiveStatus } from './SessionName';
import { formatDuration, StatusBadge } from './status';
import { useAppStore, type ProjectInfo, type SessionInfo, type SessionMetrics } from './store';

export const formatMemory = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
export const formatCpu = (cpu: number | null) => cpu === null ? '—' : `${cpu.toFixed(1)}%`;
export const eventTime = (time: number) => new Date(time).toLocaleTimeString('pt-BR', { hour12: false });

export function useMappingStatus(session: SessionInfo) {
  const status = useLiveStatus(session);
  const suspended = useAppStore((state) => state.memory.sessions?.[session.id]?.suspended ?? false);
  return suspended && session.status === 'rodando' ? { tone: 'waiting' as const, label: 'Pausado', live: false } : status;
}

function Sparkline({ samples, ceiling }: { samples: (number | null)[]; ceiling?: number }) {
  const known = samples.filter((value): value is number => value !== null);
  if (known.length < 2) return null;
  const max = Math.max(1, ceiling ?? Math.max(...known));
  const path = samples.map((value, index) => value === null ? '' :
    `${index === 0 || samples[index - 1] === null ? 'M' : 'L'} ${index * 100 / (samples.length - 1)} ${26 - value * 24 / max}`).join(' ');
  return <svg className="mapping-sparkline" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>;
}

const AgentMetrics = memo(function AgentMetrics({ id }: { id: string }) {
  const metrics = useAppStore((state) => state.memory.sessions?.[id]);
  const [samples, setSamples] = useState<SessionMetrics[]>([]);
  useEffect(() => {
    if (metrics) setSamples((previous) => previous.at(-1) === metrics ? previous : [...previous.slice(-29), metrics]);
  }, [metrics]);
  return <div className="mapping-metrics" aria-label="Métricas da sessão">
    <div><span><Cpu size={14} /> CPU</span><strong>{metrics ? formatCpu(metrics.cpuPercent) : '—'}</strong><Sparkline samples={samples.map((sample) => sample.cpuPercent)} ceiling={100} /></div>
    <div><span><MemoryStick size={14} /> Memória</span><strong>{metrics ? formatMemory(metrics.bytes) : '—'}</strong><Sparkline samples={samples.map((sample) => sample.bytes)} /></div>
    <div><span><Clock3 size={14} /> Tempo ativo</span><strong>{metrics ? formatDuration(metrics.runtimeSeconds) : '—'}</strong></div>
  </div>;
});

export const AgentInspector = memo(function AgentInspector({ session, project, links, onClose, onFocus, onTerminal, onConnection, onHistory }: {
  session: SessionInfo; project?: ProjectInfo; links: AgentLink[]; onClose: () => void;
  onFocus: (id: string) => void; onTerminal: (id: string) => void; onConnection: (link: AgentLink) => void; onHistory: () => void;
}) {
  const [tab, setTab] = useState<'overview' | 'config' | 'history'>('overview');
  const status = useMappingStatus(session);
  const activity = useActivityStore((state) => state.activity[session.id]);
  const events = useMappingEvents((state) => state.events);
  const sessionEvents = events.filter((event) => event.sessionId === session.id || event.relatedId === session.id);
  const latest = sessionEvents.at(-1);
  const sessions = useAppStore((state) => state.sessions);
  const pid = useAppStore((state) => state.memory.sessions?.[session.id]?.pid);
  const group = useAppStore((state) => state.memory.groups.find((item) => item.groupId === project?.groupId));
  const canSuspendGroup = isTauri() && navigator.userAgent.includes('Windows') && Boolean(group) && session.status === 'rodando';
  const [tokens, setTokens] = useState<number | null>(null);
  const providerActivity = sessionEvents.filter((event) => event.kind === 'done' || event.kind === 'ended').at(-1)?.id;
  useEffect(() => {
    if (!isTauri() || !session.resumeId || session.agent === 'Shell') return;
    let active = true;
    const timer = window.setTimeout(() => {
      void invoke<number | null>('history_session_tokens', { agent: session.agent, id: session.resumeId })
        .then((result) => { if (active) setTokens(result); }).catch(() => undefined);
    }, 350);
    return () => { active = false; window.clearTimeout(timer); };
  }, [session.agent, session.resumeId, providerActivity]);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    try { await action(); } catch (error) { useAppStore.getState().setNotice(String(error)); }
  };
  return <aside className="mapping-inspector" aria-label="Detalhes do agente">
    <header className="mapping-inspector-head">
      <span className="mapping-agent-icon"><AgentIcon agent={session.agent} size={25} /></span>
      <div><h2>{sessionLabel(session)}</h2><p>{session.agent} · {project?.name ?? 'Sessão avulsa'}</p><StatusBadge info={status} /></div>
      <button className="mapping-icon-button" aria-label="Fechar inspetor" title="Fechar inspetor (Esc)" onClick={onClose}><X size={17} /></button>
    </header>
    <nav className="mapping-inspector-tabs" aria-label="Abas do inspetor">
      {([['overview', 'Visão geral'], ['config', 'Configuração'], ['history', 'Histórico']] as const).map(([id, label]) =>
        <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    <div className="mapping-inspector-body">
      {tab === 'overview' && <>
        <section><h3>Recursos do processo</h3><AgentMetrics id={session.id} />{tokens !== null && <p className="mapping-token-usage">Tokens da conversa <code>{tokens.toLocaleString('pt-BR')}</code></p>}</section>
        <section><h3>Conexões</h3>
          {links.length === 0 && <p>Nenhum vínculo configurado.</p>}
          {links.map((link) => {
            const outgoing = link.fromId === session.id;
            const peerId = outgoing ? link.toId : link.fromId;
            const peer = sessions.find((item) => item.id === peerId);
            return <div className="mapping-peer" key={`${link.fromId}:${link.toId}`}>
              <button onClick={() => onFocus(peerId)} disabled={!peer}><ArrowRight size={13} className={outgoing ? '' : 'incoming'} />{peer ? sessionLabel(peer) : 'Sessão indisponível'}</button>
              <button onClick={() => onConnection(link)} title="Inspecionar vínculo">Comando</button>
            </div>;
          })}
        </section>
        <section><h3>Última atividade</h3><p>{latest ? <><time>{eventTime(latest.at)}</time> · {MAPPING_EVENT_KINDS[latest.kind][0]}</> : activity ? <time>{eventTime(activity.since)}</time> : 'Nenhum evento registrado.'}</p>
          {activity?.message && <p className="mapping-live-message">{activity.message}</p>}
        </section>
      </>}
      {tab === 'config' && <dl className="mapping-config">
        <dt>Projeto</dt><dd>{project?.name ?? 'Sessão avulsa'}</dd>
        <dt>Pasta</dt><dd>{displayPath(session.folder)}</dd>
        <dt>ID</dt><dd><code>{session.id}</code></dd>
        <dt>PID</dt><dd><code>{pid ?? '—'}</code></dd>
      </dl>}
      {tab === 'config' && canSuspendGroup && group && <section><h3>Grupo do projeto</h3>
        <button className="mapping-action" onClick={() => void run(async () => {
          if (!group.suspended && !(await confirmAction('Pausar os processos do grupo deste projeto?'))) return;
          await invoke('group_suspend', { groupId: group.groupId, suspend: !group.suspended });
        })}>{group.suspended ? <Play size={14} /> : <Pause size={14} />}{group.suspended ? 'Retomar grupo' : 'Pausar grupo'}</button>
      </section>}
      {tab === 'history' && <section><h3>Eventos da sessão</h3>
        {sessionEvents.length === 0 && <p>Nenhum evento registrado.</p>}
        {[...sessionEvents].reverse().map((event) => <p key={event.id}><time>{eventTime(event.at)}</time> · {MAPPING_EVENT_KINDS[event.kind][0]}</p>)}
        <button className="mapping-action" onClick={onHistory}>Ver na timeline</button>
      </section>}
      {renaming && <form className="mapping-rename" onSubmit={(event) => { event.preventDefault(); void run(async () => { await renameSession(session.id, draft); setRenaming(false); }); }}>
        <label>Nome da sessão<input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={60} /></label>
        <button className="mapping-action" type="submit">Salvar</button>
        <button className="mapping-action" type="button" onClick={() => setRenaming(false)}>Cancelar</button>
      </form>}
    </div>
    <footer className="mapping-inspector-actions">
      <button className="mapping-action mapping-create" onClick={() => onTerminal(session.id)}><TerminalSquare size={15} /> Abrir terminal</button>
      <button className="mapping-icon-button" aria-label="Centralizar agente" title="Centralizar agente" onClick={() => onFocus(session.id)}><Crosshair size={16} /></button>
      <button className="mapping-action" disabled={!isTauri()} onClick={() => { setDraft(session.title ?? ''); setRenaming(true); }}>Renomear</button>
      {session.status === 'rodando' && <>
        <button className="mapping-icon-button" aria-label="Agendar prompt" title="Agendar prompt" onClick={() => useScheduleStore.getState().open({ target: 'session', sessionId: session.id })}><CalendarClock size={16} /></button>
        <button className="mapping-icon-button mapping-danger" aria-label="Encerrar sessão" title="Encerrar sessão" onClick={() => void run(async () => {
          if (await confirmAction('Encerrar este processo?')) await invoke('terminal_stop', { id: session.id });
        })}><Power size={16} /></button>
      </>}
    </footer>
  </aside>;
});

export const AgentTimeline = memo(function AgentTimeline({ open, onToggle, sessions, focusedAgent, onSelect }: {
  open: boolean; onToggle: () => void; sessions: SessionInfo[]; focusedAgent: string | null;
  onSelect: (id: string, center: boolean) => void;
}) {
  const events = useMappingEvents((state) => state.events);
  const [agent, setAgent] = useState('');
  const [kind, setKind] = useState('');
  const [paused, setPaused] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  const visibleEvents = useMemo(() => events.filter((event) =>
    (!agent || event.sessionId === agent || event.relatedId === agent) && (!kind || event.kind === kind)), [events, agent, kind]);
  const current = visibleEvents.find((item) => item.id === selected);
  useEffect(() => { if (focusedAgent) { setAgent(focusedAgent); setKind(''); setSelected(null); } }, [focusedAgent]);
  useEffect(() => {
    if (open && !paused && !playing && rail.current) rail.current.scrollLeft = rail.current.scrollWidth;
  }, [visibleEvents, open, paused, playing]);
  useEffect(() => {
    if (!playing || !open) return;
    const index = visibleEvents.findIndex((event) => event.id === selected) + 1;
    const timer = window.setTimeout(() => {
      const event = visibleEvents[index];
      if (!event) { setPlaying(false); return; }
      setSelected(event.id);
      onSelect(event.sessionId, false);
    }, index === 0 ? 0 : 900);
    return () => window.clearTimeout(timer);
  }, [playing, open, selected, visibleEvents, onSelect]);
  const agentOptions = new Map(events.map((event) => [event.sessionId, event.agent]));
  for (const session of sessions) agentOptions.set(session.id, sessionLabel(session));
  return <section className="mapping-timeline" aria-label="Timeline de atividades">
    <header>
      <button className="mapping-action mapping-timeline-title" aria-expanded={open} onClick={onToggle}><Activity size={15} /> Atividade {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}</button>
      {open && <div className="mapping-timeline-tools">
        <select aria-label="Filtrar eventos por agente" value={agent} onChange={(event) => { setAgent(event.target.value); setSelected(null); setPlaying(false); }}><option value="">Todos os agentes</option>{[...agentOptions].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        <select aria-label="Filtrar eventos por tipo" value={kind} onChange={(event) => { setKind(event.target.value); setSelected(null); setPlaying(false); }}><option value="">Todos os eventos</option>{Object.entries(MAPPING_EVENT_KINDS).map(([id, [label]]) => <option key={id} value={id}>{label}</option>)}</select>
        <button className="mapping-icon-button" aria-label={playing ? 'Parar reprodução' : 'Reproduzir histórico'} title={playing ? 'Parar reprodução' : 'Reproduzir histórico'} disabled={!visibleEvents.length} onClick={() => { if (!playing) { setPaused(true); setSelected(null); if (rail.current) rail.current.scrollLeft = 0; } setPlaying(!playing); }}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
        <button className="mapping-action" onClick={() => { setPlaying(false); setPaused(!paused); }} aria-pressed={paused}>{paused ? 'Retomar' : 'Pausar'}</button>
        <button className="mapping-icon-button" aria-label="Eventos mais recentes" title="Eventos mais recentes" onClick={() => { setPlaying(false); setPaused(false); setSelected(null); if (rail.current) rail.current.scrollLeft = rail.current.scrollWidth; }}><ArrowDownToLine size={15} /></button>
      </div>}
    </header>
    {open && <><div className="mapping-event-rail" ref={rail}>
      {visibleEvents.length === 0 && <p>Nenhum evento registrado para este filtro.</p>}
      {visibleEvents.map((event) => {
        const [label, tone] = MAPPING_EVENT_KINDS[event.kind];
        return <button key={event.id} aria-pressed={selected === event.id} ref={selected === event.id && playing ? (element) => element?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) : undefined}
          onClick={() => { setPlaying(false); setSelected(event.id); onSelect(event.sessionId, false); }}>
          <time>{eventTime(event.at)}</time><strong><i className={`status-dot tone-${tone}`} aria-hidden="true" />{label}</strong><span>{mappingEventDescription(event, sessions)}</span>
        </button>;
      })}
    </div>
    {current && <div className="mapping-event-detail">
      <span><time>{eventTime(current.at)}</time> · {MAPPING_EVENT_KINDS[current.kind][0]} · {mappingEventDescription(current, sessions)}</span>
      <button className="mapping-action" disabled={!sessions.some((session) => session.id === current.sessionId)} onClick={() => onSelect(current.sessionId, true)}><Crosshair size={14} /> Centralizar</button>
      <button className="mapping-icon-button" aria-label="Fechar detalhes do evento" onClick={() => setSelected(null)}><X size={14} /></button>
    </div>}</>}
  </section>;
});
