import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  ChevronDown, Crosshair, Eye, Focus, FolderTree, LayoutGrid, Maximize2, Minus, Network,
  RotateCcw, Scan, TerminalSquare, Workflow, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { AgentIcon } from './AgentIcon';
import { StatusBadge, StatusDot, sessionStatus } from './status';
import { sameFolder } from './path';
import { useAppStore, type ProjectInfo, type SessionInfo } from './store';
import {
  ARCHITECTURE_NODE_SIZE, DEFAULT_VIEWPORT, arrangeMappingNodes, mappingBounds,
  mergeMappingLayout, nodeDisplaySize, type MappingLayout, type MappingMode,
  type MappingNode, type MappingViewport,
} from './mapping';
import './mapping.css';

const TerminalView = lazy(() => import('./TerminalView').then((module) => ({ default: module.TerminalView })));

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const STORAGE_PREFIX = 'athenas-mapping:';

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

async function loadLayout(scope: string): Promise<MappingLayout | null> {
  if (isTauri()) return invoke<MappingLayout | null>('mapping_layout_get', { scope });
  try {
    const value = localStorage.getItem(`${STORAGE_PREFIX}${scope}`);
    return value ? JSON.parse(value) as MappingLayout : null;
  } catch { return null; }
}

async function storeLayout(scope: string, layout: MappingLayout) {
  if (isTauri()) await invoke('mapping_layout_save', { scope, layout });
  else {
    try { localStorage.setItem(`${STORAGE_PREFIX}${scope}`, JSON.stringify(layout)); } catch { /* preview still works */ }
  }
}

type AgentWindowProps = {
  session: SessionInfo;
  project: ProjectInfo | null;
  node: MappingNode;
  mode: MappingMode;
  selected: boolean;
  zoom: number;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onChange: (id: string, patch: Partial<MappingNode>, persist?: boolean) => void;
};

const AgentWindow = memo(function AgentWindow({
  session, project, node, mode, selected, zoom, onSelect, onFocus, onChange,
}: AgentWindowProps) {
  const interaction = useRef<{
    kind: 'move' | 'resize'; startX: number; startY: number; node: MappingNode;
  } | null>(null);
  const status = sessionStatus(session.status);
  const size = nodeDisplaySize(node, mode);

  const begin = (kind: 'move' | 'resize', event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    interaction.current = { kind, startX: event.clientX, startY: event.clientY, node };
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(session.id);
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const current = interaction.current;
    if (!current) return;
    const dx = (event.clientX - current.startX) / zoom;
    const dy = (event.clientY - current.startY) / zoom;
    if (current.kind === 'move') onChange(session.id, { x: current.node.x + dx, y: current.node.y + dy });
    else onChange(session.id, {
      width: clamp(current.node.width + dx, 420, 1600),
      height: clamp(current.node.height + dy, 260, 1200),
    });
  };
  const end = (event: React.PointerEvent<HTMLElement>) => {
    if (!interaction.current) return;
    interaction.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onChange(session.id, {}, true);
  };

  if (mode === 'architecture') {
    return <article
      className={`mapping-node architecture-node ${selected ? 'selected' : ''}`}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: ARCHITECTURE_NODE_SIZE.width, height: ARCHITECTURE_NODE_SIZE.height }}
      onPointerDown={() => onSelect(session.id)}
    >
      <header className="architecture-drag" onPointerDown={(event) => begin('move', event)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <span className="mapping-agent-icon"><AgentIcon agent={session.agent} size={17} /></span>
        <div><strong>{session.agent}</strong><small>{project?.name ?? 'Sessão avulsa'}</small></div>
        <StatusDot info={status} />
      </header>
      <div className="architecture-body"><StatusBadge info={status} /><p>Sem tarefa estruturada disponível</p></div>
      <button className="architecture-focus" aria-label={`Focar ${session.agent}`} title="Focar agente" onClick={() => onFocus(session.id)}><Focus size={13} /></button>
    </article>;
  }

  return <article
    className={`mapping-node terminal-node ${selected ? 'selected' : ''} ${node.minimized ? 'minimized' : ''}`}
    style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: size.width, height: size.height }}
    onPointerDown={() => onSelect(session.id)}
  >
    <header className="mapping-window-header" onPointerDown={(event) => begin('move', event)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <span className="mapping-agent-icon"><AgentIcon agent={session.agent} size={15} /></span>
      <div className="mapping-window-title"><strong>{session.agent}</strong><small>{project?.name ?? 'Sessão avulsa'}</small></div>
      <StatusBadge info={status} />
      <div className="mapping-window-actions" onPointerDown={(event) => event.stopPropagation()}>
        <button aria-label="Focar janela" title="Focar" onClick={() => onFocus(session.id)}><Crosshair size={13} /></button>
        <button aria-label="Expandir janela" title="Expandir" onClick={() => onChange(session.id, { width: 1000, height: 680, minimized: false }, true)}><Maximize2 size={13} /></button>
        <button aria-label={node.minimized ? 'Restaurar janela' : 'Minimizar janela'} title={node.minimized ? 'Restaurar' : 'Minimizar'} onClick={() => onChange(session.id, { minimized: !node.minimized }, true)}><Minus size={13} /></button>
        <button aria-label="Ocultar janela do mapa" title="Ocultar do mapa" onClick={() => onChange(session.id, { hidden: true }, true)}><X size={13} /></button>
      </div>
    </header>
    {!node.minimized && <div className="mapping-terminal-content">
      {session.status === 'rodando'
        ? <Suspense fallback={<div className="terminal-loading">Carregando terminal…</div>}><TerminalView session={session} onStatus={useAppStore.getState().upsertSession} /></Suspense>
        : <div className="mapping-ended"><AgentIcon agent={session.agent} size={22} /><strong>Sessão {status.label.toLowerCase()}</strong><span>O histórico permanece preservado.</span></div>}
    </div>}
    {!node.minimized && <span className="mapping-resize" role="separator" aria-label="Redimensionar janela" onPointerDown={(event) => begin('resize', event)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />}
  </article>;
});

function MappingMinimap({ nodes, mode, viewport, canvas, onCenter }: {
  nodes: MappingNode[]; mode: MappingMode; viewport: MappingViewport;
  canvas: { width: number; height: number }; onCenter: (x: number, y: number) => void;
}) {
  const visible = nodes.filter((node) => !node.hidden);
  const viewportWorld = {
    left: -viewport.x / viewport.zoom,
    top: -viewport.y / viewport.zoom,
    right: (canvas.width - viewport.x) / viewport.zoom,
    bottom: (canvas.height - viewport.y) / viewport.zoom,
  };
  const content = mappingBounds(visible, mode);
  const left = Math.min(content?.left ?? 0, viewportWorld.left);
  const top = Math.min(content?.top ?? 0, viewportWorld.top);
  const right = Math.max(content?.right ?? 1, viewportWorld.right);
  const bottom = Math.max(content?.bottom ?? 1, viewportWorld.bottom);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const sx = 174 / width;
  const sy = 104 / height;
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onCenter(left + ((event.clientX - rect.left - 3) / sx), top + ((event.clientY - rect.top - 3) / sy));
  };
  return <div className="mapping-minimap" aria-label="Minimapa" onPointerDown={point}>
    {visible.map((node) => {
      const size = nodeDisplaySize(node, mode);
      return <i key={node.sessionId} style={{ left: 3 + (node.x - left) * sx, top: 3 + (node.y - top) * sy, width: Math.max(3, size.width * sx), height: Math.max(3, size.height * sy) }} />;
    })}
    <b style={{ left: 3 + (viewportWorld.left - left) * sx, top: 3 + (viewportWorld.top - top) * sy, width: Math.max(8, (viewportWorld.right - viewportWorld.left) * sx), height: Math.max(8, (viewportWorld.bottom - viewportWorld.top) * sy) }} />
  </div>;
}

export function MappingView() {
  const sessions = useAppStore((state) => state.sessions);
  const projects = useAppStore((state) => state.workspace.projects);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const setNotice = useAppStore((state) => state.setNotice);
  const [scope, setScope] = useState(activeProjectId ?? 'all');
  const [layout, setLayout] = useState<MappingLayout>(() => mergeMappingLayout(null, []));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(layout);
  const panRef = useRef<{ x: number; y: number; viewport: MappingViewport } | null>(null);
  const saveTimer = useRef<number | null>(null);

  const projectFor = useCallback((session: SessionInfo) => projects.find((project) => sameFolder(session.folder, project.folder)), [projects]);
  const filteredSessions = useMemo(() => sessions.filter((session) => scope === 'all' || projectFor(session)?.id === scope), [sessions, scope, projectFor]);
  const sessionIds = filteredSessions.map((session) => session.id).join('|');
  const nodesById = useMemo(() => new Map(layout.nodes.map((node) => [node.sessionId, node])), [layout.nodes]);

  const persist = useCallback((next: MappingLayout) => {
    void storeLayout(scope, next).catch((error) => setNotice(`Não foi possível salvar o mapa: ${error}`));
  }, [scope, setNotice]);
  const updateLayout = useCallback((change: (current: MappingLayout) => MappingLayout, save = false) => {
    setLayout((current) => {
      const next = change(current);
      layoutRef.current = next;
      if (save) persist(next);
      return next;
    });
  }, [persist]);
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => persist(layoutRef.current), 350);
  }, [persist]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void loadLayout(scope).then((stored) => {
      if (cancelled) return;
      const next = mergeMappingLayout(stored, filteredSessions.map((session) => session.id));
      layoutRef.current = next;
      setLayout(next);
      setLoaded(true);
    }).catch((error) => { if (!cancelled) { setNotice(`Não foi possível carregar o mapa: ${error}`); setLoaded(true); } });
    return () => { cancelled = true; };
    // Session additions are merged by the effect below without reloading persisted geometry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    if (!loaded) return;
    updateLayout((current) => mergeMappingLayout(current, filteredSessions.map((session) => session.id)));
  }, [loaded, sessionIds, filteredSessions, updateLayout]);

  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return;
    const measure = () => setCanvasSize({ width: host.clientWidth, height: host.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const resize = new ResizeObserver(measure);
    resize.observe(host);
    return () => resize.disconnect();
  }, []);

  useEffect(() => () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); }, []);

  const patchNode = useCallback((id: string, patch: Partial<MappingNode>, save = false) => {
    updateLayout((current) => ({ ...current, nodes: current.nodes.map((node) => node.sessionId === id ? { ...node, ...patch } : node) }), save);
  }, [updateLayout]);

  const focusNode = useCallback((id: string) => {
    const node = layoutRef.current.nodes.find((item) => item.sessionId === id);
    const host = canvasRef.current;
    if (!node || !host) return;
    const size = nodeDisplaySize(node, layoutRef.current.mode);
    const viewport = { ...layoutRef.current.viewport,
      x: host.clientWidth / 2 - (node.x + size.width / 2) * layoutRef.current.viewport.zoom,
      y: host.clientHeight / 2 - (node.y + size.height / 2) * layoutRef.current.viewport.zoom,
    };
    setSelectedId(id);
    updateLayout((current) => ({ ...current, viewport }), true);
  }, [updateLayout]);

  const fitAll = useCallback((save = true) => {
    const host = canvasRef.current;
    const bounds = mappingBounds(layoutRef.current.nodes, layoutRef.current.mode);
    if (!host || !bounds) return;
    const zoom = clamp(Math.min((host.clientWidth - 96) / Math.max(bounds.width, 1), (host.clientHeight - 96) / Math.max(bounds.height, 1)), MIN_ZOOM, 1.25);
    const viewport = {
      zoom,
      x: (host.clientWidth - bounds.width * zoom) / 2 - bounds.left * zoom,
      y: (host.clientHeight - bounds.height * zoom) / 2 - bounds.top * zoom,
    };
    updateLayout((current) => ({ ...current, viewport }), save);
  }, [updateLayout]);

  const setZoom = useCallback((zoom: number, clientX?: number, clientY?: number) => {
    const host = canvasRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    updateLayout((current) => {
      const nextZoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
      const anchorX = (clientX ?? rect.left + rect.width / 2) - rect.left;
      const anchorY = (clientY ?? rect.top + rect.height / 2) - rect.top;
      const worldX = (anchorX - current.viewport.x) / current.viewport.zoom;
      const worldY = (anchorY - current.viewport.y) / current.viewport.zoom;
      return { ...current, viewport: { zoom: nextZoom, x: anchorX - worldX * nextZoom, y: anchorY - worldY * nextZoom } };
    });
    scheduleSave();
  }, [scheduleSave, updateLayout]);

  const restoreHidden = () => updateLayout((current) => ({ ...current, nodes: current.nodes.map((node) => ({ ...node, hidden: false })) }), true);
  const hiddenCount = layout.nodes.filter((node) => node.hidden).length;
  const runningCount = filteredSessions.filter((session) => session.status === 'rodando').length;
  const grid = 24 * layout.viewport.zoom;

  return <section className="mapping-view">
    <header className="mapping-topbar">
      <div className="mapping-heading"><span><Workflow size={16} /></span><div><h1>Mapeamento</h1><small>Workspace visual de agentes</small></div></div>
      <span className="mapping-divider" aria-hidden="true" />
      <label className="mapping-project-filter"><FolderTree size={14} /><select aria-label="Filtrar projeto" value={scope} onChange={(event) => setScope(event.target.value)}><option value="all">Todos os projetos</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={13} className="mapping-select-caret" /></label>
      <div className="mapping-summary">
        <span className={`mapping-chip ${runningCount ? 'live' : ''}`}><i />{runningCount} ativo(s)</span>
        <span className="mapping-chip muted">{filteredSessions.length} agente(s) no mapa</span>
      </div>
      <div className="mapping-mode" role="group" aria-label="Modo de visualização">
        <button className={layout.mode === 'terminal' ? 'active' : ''} aria-pressed={layout.mode === 'terminal'} onClick={() => updateLayout((current) => ({ ...current, mode: 'terminal' }), true)}><TerminalSquare size={14} /> Terminal</button>
        <button className={layout.mode === 'architecture' ? 'active' : ''} aria-pressed={layout.mode === 'architecture'} onClick={() => updateLayout((current) => ({ ...current, mode: 'architecture' }), true)}><Network size={14} /> Arquitetura</button>
      </div>
      <div className="mapping-actions">
        {hiddenCount > 0 && <button className="mapping-action attention" onClick={restoreHidden}><Eye size={13} /> Exibir {hiddenCount} oculto(s)</button>}
        <button className="mapping-action" title="Organizar agentes por projeto" onClick={() => { const next = arrangeMappingNodes(layoutRef.current.nodes, (id) => { const session = filteredSessions.find((item) => item.id === id); return session ? projectFor(session)?.id ?? 'loose' : 'loose'; }, layoutRef.current.mode); updateLayout((current) => ({ ...current, nodes: next }), true); window.requestAnimationFrame(() => fitAll()); }}><LayoutGrid size={14} /> <span>Organizar agentes</span></button>
        <button className="mapping-action" title="Ajustar todos à tela" onClick={() => fitAll()}><Scan size={14} /> <span>Ajustar</span></button>
      </div>
    </header>
    <div
      ref={canvasRef}
      className={`mapping-canvas ${panRef.current ? 'panning' : ''}`}
      style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${layout.viewport.x % grid}px ${layout.viewport.y % grid}px` }}
      onWheel={(event) => {
        if ((event.target as HTMLElement).closest('.terminal-view')) return;
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) setZoom(layout.viewport.zoom * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
        else { updateLayout((current) => ({ ...current, viewport: { ...current.viewport, x: current.viewport.x - event.deltaX, y: current.viewport.y - event.deltaY } })); scheduleSave(); }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest('.mapping-node, .mapping-controls, .mapping-minimap')) return;
        panRef.current = { x: event.clientX, y: event.clientY, viewport: layout.viewport };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const pan = panRef.current;
        if (!pan) return;
        updateLayout((current) => ({ ...current, viewport: { ...current.viewport, x: pan.viewport.x + event.clientX - pan.x, y: pan.viewport.y + event.clientY - pan.y } }));
      }}
      onPointerUp={(event) => { if (panRef.current) { panRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); persist(layoutRef.current); } }}
      onPointerCancel={() => { panRef.current = null; }}
    >
      <div className="mapping-world" style={{ transform: `translate(${layout.viewport.x}px, ${layout.viewport.y}px) scale(${layout.viewport.zoom})` }}>
        <div className="mapping-axis axis-x"><span>X</span></div><div className="mapping-axis axis-y"><span>Y</span></div><div className="mapping-origin">0,0</div>
        <svg className="mapping-edges" aria-hidden="true" />
        {loaded && filteredSessions.map((session) => {
          const node = nodesById.get(session.id);
          if (!node || node.hidden) return null;
          return <AgentWindow key={session.id} session={session} project={projectFor(session) ?? null} node={node} mode={layout.mode} selected={selectedId === session.id} zoom={layout.viewport.zoom} onSelect={setSelectedId} onFocus={focusNode} onChange={patchNode} />;
        })}
      </div>
      {!loaded && <div className="mapping-empty">Carregando organização…</div>}
      {loaded && filteredSessions.length === 0 && <div className="mapping-empty"><Workflow size={28} /><strong>Nenhuma sessão neste escopo.</strong><span>Abra um agente real para adicioná-lo ao mapa.</span></div>}
      <div className="mapping-controls" aria-label="Controles do canvas">
        <button aria-label="Aproximar" title="Aproximar" onClick={() => setZoom(layout.viewport.zoom + 0.1)}><ZoomIn size={15} /></button>
        <button aria-label="Afastar" title="Afastar" onClick={() => setZoom(layout.viewport.zoom - 0.1)}><ZoomOut size={15} /></button>
        <button className="zoom-value" aria-label="Restaurar zoom para 100%" title="Zoom 100%" onClick={() => setZoom(1)}>{Math.round(layout.viewport.zoom * 100)}%</button>
        <button aria-label="Retornar à origem" title="Retornar à origem" onClick={() => updateLayout((current) => ({ ...current, viewport: { ...DEFAULT_VIEWPORT } }), true)}><RotateCcw size={15} /></button>
        <button aria-label="Ajustar todos os agentes" title="Ajustar todos" onClick={() => fitAll()}><Scan size={15} /></button>
      </div>
      <MappingMinimap nodes={layout.nodes} mode={layout.mode} viewport={layout.viewport} canvas={canvasSize} onCenter={(x, y) => updateLayout((current) => ({ ...current, viewport: { ...current.viewport, x: canvasSize.width / 2 - x * current.viewport.zoom, y: canvasSize.height / 2 - y * current.viewport.zoom } }), true)} />
    </div>
  </section>;
}
