import { lazy, memo, Suspense, useRef } from 'react';
import { Cable, Crosshair, EyeOff, Maximize2, Minus, MoreHorizontal, TerminalSquare, X } from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { sessionLabel, useActivityStore } from './activity';
import { formatCpu, formatMemory, eventTime, useMappingStatus } from './MappingPanels';
import { latestMappingEvent, useMappingEvents } from './mappingActivity';
import { nodeDisplaySize, type MappingMode, type MappingNode } from './mapping';
import { formatDuration, StatusBadge, StatusDot } from './status';
import { useAppStore, type ProjectInfo, type SessionInfo } from './store';

const TerminalView = lazy(() => import('./TerminalView').then((module) => ({ default: module.TerminalView })));
export type SemanticZoom = 'far' | 'normal' | 'near';

const AgentReadout = memo(function AgentReadout({ id }: { id: string }) {
  const metrics = useAppStore((state) => state.memory.sessions?.[id]);
  const activity = useActivityStore((state) => state.activity[id]?.since);
  const event = useMappingEvents((state) => latestMappingEvent(state.events, (item) => item.sessionId === id || item.relatedId === id)?.at);
  const lastActivity = Math.max(activity ?? 0, event ?? 0);
  return <div className="mapping-node-readout">
    {metrics && <><span title="CPU">{formatCpu(metrics.cpuPercent)} CPU</span><span title="Memória">{formatMemory(metrics.bytes)}</span><span title="Tempo ativo">{formatDuration(metrics.runtimeSeconds)}</span></>}
    {lastActivity > 0 && <time title="Última atividade">{eventTime(lastActivity)}</time>}
  </div>;
});

type AgentWindowProps = {
  session: SessionInfo; project?: ProjectInfo; node: MappingNode; terminalNode: MappingNode;
  mode: MappingMode; semanticZoom: SemanticZoom; selected: boolean; linkTarget: boolean; movable: boolean;
  keepTerminal: boolean; maximized: boolean; zoomRef: React.MutableRefObject<number>;
  onSelect: (id: string, multiple?: boolean) => void;
  onFocus: (id: string) => void;
  onTerminal: (id: string) => void;
  onArchitecture: (id: string) => void;
  onMaximize: (id: string) => void;
  onChange: (id: string, patch: Partial<MappingNode>, persist?: boolean) => void;
  onLinkStart: (id: string, event: React.PointerEvent<HTMLElement>) => void;
  onLinkTarget: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
};

export const AgentWindow = memo(function AgentWindow({
  session, project, node, terminalNode, mode, semanticZoom, selected, linkTarget, movable, keepTerminal, maximized, zoomRef,
  onSelect, onFocus, onTerminal, onArchitecture, onMaximize, onChange, onLinkStart, onLinkTarget, onMenu,
}: AgentWindowProps) {
  const interaction = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; node: MappingNode } | null>(null);
  const status = useMappingStatus(session);
  const label = sessionLabel(session);
  const terminalSize = nodeDisplaySize(terminalNode, 'terminal');
  const cardSize = nodeDisplaySize(node, 'architecture');
  const architecture = mode === 'architecture';
  const terminalVisible = !architecture && !node.hidden;
  const selectedClass = `${selected ? 'selected' : ''} ${linkTarget ? 'link-target' : ''}`;

  const begin = (kind: 'move' | 'resize', event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    event.stopPropagation();
    onSelect(session.id, event.shiftKey || event.ctrlKey || event.metaKey);
    if ((kind === 'move' && !movable) || maximized) return;
    interaction.current = { kind, startX: event.clientX, startY: event.clientY, node };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const current = interaction.current;
    if (!current) return;
    const dx = (event.clientX - current.startX) / zoomRef.current;
    const dy = (event.clientY - current.startY) / zoomRef.current;
    if (current.kind === 'move') onChange(session.id, { x: current.node.x + dx, y: current.node.y + dy });
    else onChange(session.id, {
      width: Math.min(1600, Math.max(420, current.node.width + dx)),
      height: Math.min(1200, Math.max(260, current.node.height + dy)),
    });
  };
  const end = (event: React.PointerEvent<HTMLElement>) => {
    if (!interaction.current) return;
    interaction.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onChange(session.id, {}, true);
  };
  const pointerHandlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };
  const linkButton = <button className="mapping-link-port" aria-label={`Linkar ${label} a outro agente`} title="Arraste para configurar um vínculo de comando"
    onPointerDown={(event) => { event.stopPropagation(); onLinkStart(session.id, event); }}><Cable size={14} /></button>;
  const contextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    onMenu(session.id, event.clientX, event.clientY);
  };
  const keyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      onSelect(session.id, event.shiftKey);
    }
  };
  return <>
    {architecture && !node.hidden && <article
      data-session-id={session.id} tabIndex={0} aria-label={`${label} · ${status.label}`}
      className={`mapping-node architecture-node semantic-${semanticZoom} ${selectedClass}`}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: cardSize.width, height: cardSize.height }}
      onKeyDown={keyboard} onContextMenu={contextMenu} onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest('button')) onTerminal(session.id); }}
      onPointerDown={(event) => onSelect(session.id, event.shiftKey || event.ctrlKey || event.metaKey)}
    >
      <header className="architecture-drag" onPointerDown={(event) => begin('move', event)} {...pointerHandlers}>
        <span className={`mapping-agent-icon provider-${session.agent === 'Claude Code' ? 'claude' : session.agent.toLowerCase()}`}><AgentIcon agent={session.agent} size={25} /></span>
        <div className="mapping-window-title"><strong>{label}</strong><small>{session.agent}</small></div>
        <StatusDot info={status} />
      </header>
      <div className="architecture-meta"><StatusBadge info={status} /><span title={project?.name}>{project?.name ?? 'Sessão avulsa'}</span></div>
      {semanticZoom === 'near' && <AgentReadout id={session.id} />}
      <div className="architecture-actions" onPointerDown={(event) => event.stopPropagation()}>
        <button className="mapping-icon-button" aria-label="Abrir terminal do agente" title="Abrir terminal" onClick={() => onTerminal(session.id)}><TerminalSquare size={14} /></button>
        <button className="mapping-icon-button" aria-label="Opções do agente" title="Opções do agente" aria-haspopup="menu" onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu(session.id, rect.left, rect.bottom + 3);
        }}><MoreHorizontal size={15} /></button>
        {linkButton}
      </div>
      <button tabIndex={-1} className="mapping-port" aria-label="Conectar ao agente" title="Porta de conexão"
        onPointerDown={(event) => { event.stopPropagation(); onLinkStart(session.id, event); }} onClick={() => onLinkTarget(session.id)} />
    </article>}
    {(terminalVisible || keepTerminal) && <article
      data-session-id={terminalVisible ? session.id : undefined}
      className={`mapping-node terminal-node ${selectedClass} ${terminalNode.minimized ? 'minimized' : ''} ${maximized ? 'maximized' : ''}`}
      hidden={!terminalVisible}
      style={{ transform: `translate(${terminalNode.x}px, ${terminalNode.y}px)`, width: terminalSize.width, height: terminalSize.height }}
      onPointerDown={() => onSelect(session.id)} onContextMenu={(event) => {
        if (!(event.target as HTMLElement).closest('.terminal-view')) contextMenu(event);
      }}
    >
      <header className="mapping-window-header" onPointerDown={(event) => begin('move', event)} {...pointerHandlers}
        onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest('button')) onMaximize(session.id); }}>
        <span className="mapping-agent-icon"><AgentIcon agent={session.agent} size={17} /></span>
        <div className="mapping-window-title"><strong>{label}</strong><small>{project?.name ?? 'Sessão avulsa'}</small></div>
        <StatusBadge info={status} />
        <div className="mapping-window-actions" onPointerDown={(event) => event.stopPropagation()}>
          {linkButton}
          <button aria-label="Focar janela" title="Focar janela" onClick={() => onFocus(session.id)}><Crosshair size={14} /></button>
          <button aria-label={maximized ? 'Restaurar tamanho da janela' : 'Maximizar janela'} title={maximized ? 'Restaurar tamanho' : 'Maximizar'} onClick={() => onMaximize(session.id)}><Maximize2 size={14} /></button>
          <button aria-label={terminalNode.minimized ? 'Restaurar janela' : 'Minimizar janela'} title={terminalNode.minimized ? 'Restaurar' : 'Minimizar'} onClick={() => onChange(session.id, { minimized: !terminalNode.minimized }, true)}><Minus size={14} /></button>
          <button aria-label="Voltar à arquitetura" title="Voltar à arquitetura" onClick={() => onArchitecture(session.id)}><X size={14} /></button>
          <button aria-label="Ocultar janela do mapa" title="Ocultar do mapa" onClick={() => onChange(session.id, { hidden: true }, true)}><EyeOff size={14} /></button>
        </div>
      </header>
      <div className="mapping-terminal-content" hidden={terminalNode.minimized || !terminalVisible}>
        {keepTerminal
          ? <Suspense fallback={<div className="terminal-loading">Carregando terminal…</div>}>
            <TerminalView session={session} onStatus={useAppStore.getState().upsertSession} active={terminalVisible && !terminalNode.minimized} focusOnShow={selected} readOnly={session.status !== 'rodando'} embedded />
          </Suspense>
          : <div className="mapping-ended"><AgentIcon agent={session.agent} size={24} /><strong>{status.label}</strong>
            {session.status !== 'rodando' && <button className="mapping-action" onClick={() => onTerminal(session.id)}>Abrir histórico do terminal</button>}
          </div>}
      </div>
      {!terminalNode.minimized && !maximized && <span className="mapping-resize" role="separator" aria-label="Redimensionar janela" onPointerDown={(event) => begin('resize', event)} {...pointerHandlers} />}
    </article>}
  </>;
});
