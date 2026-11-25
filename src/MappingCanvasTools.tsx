import { memo, useMemo, useRef } from 'react';
import { ChevronDown, Crosshair, Ellipsis, Expand, Eye, FolderTree, LayoutGrid, Map as MapIcon, Minus, Network, Plus, Scan, Shrink, TerminalSquare, Workflow } from 'lucide-react';
import { linkPath, type Point } from './links';
import { MAPPING_MAX_ZOOM, MAPPING_MIN_ZOOM, MAPPING_ORDERS, mappingBounds, nodeDisplaySize, type MappingMode, type MappingNode, type MappingOrder, type MappingPreferences, type MappingViewport } from './mapping';
import type { ProjectInfo, SessionInfo } from './store';
import { useMappingStatus } from './MappingPanels';

export const MappingToolbar = memo(function MappingToolbar({ scope, projects, running, hidden, mode, order, full, ready, onScope, onMode, onCreate, onOrder, onFit, onFull, onOptions, onRestore }: {
  scope: string; projects: ProjectInfo[]; running: number; hidden: number; mode: MappingMode; order: MappingOrder; full: boolean; ready: boolean;
  onScope: (scope: string) => void; onMode: (mode: MappingMode) => void; onCreate: () => void; onOrder: (order: MappingOrder) => void;
  onFit: () => void; onFull: () => void; onOptions: (point: Point) => void; onRestore: () => void;
}) {
  return <header className="mapping-topbar">
    <div className="mapping-heading"><span><Workflow size={18} /></span><h1>Mapeamento</h1></div>
    <label className="mapping-select mapping-project-filter"><FolderTree size={15} /><select aria-label="Filtrar projeto" value={scope} onChange={(event) => onScope(event.target.value)}>
      <option value="all">Todos os projetos</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select><ChevronDown size={12} /></label>
    <span className="mapping-count" title={`${running} sessões ativas`}><i className={running ? 'has-active' : ''} />{running} <span>ativos</span></span>
    <div className="mapping-actions">
      <div className="mapping-mode" role="group" aria-label="Modo de visualização">
        <button aria-label="Arquitetura" title="Arquitetura" aria-pressed={mode === 'architecture'} disabled={!ready} onClick={() => onMode('architecture')}><Network size={15} /><span>Arquitetura</span></button>
        <button aria-label="Terminal" title="Terminal" aria-pressed={mode === 'terminal'} disabled={!ready} onClick={() => onMode('terminal')}><TerminalSquare size={15} /><span>Terminal</span></button>
      </div>
      <button className="mapping-action mapping-create" aria-label="Novo agente no mapa" title="Novo agente" onClick={onCreate}><Plus size={16} /><span>Novo agente</span></button>
      <label className="mapping-select mapping-order"><LayoutGrid size={15} /><select aria-label="Organização do canvas" value={order} disabled={!ready} onChange={(event) => onOrder(event.target.value as MappingOrder)}>
        {Object.entries(MAPPING_ORDERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select><ChevronDown size={12} /></label>
      <button className="mapping-icon-button" aria-label="Ajustar todos à tela" title="Ajustar todos à tela (F)" onClick={onFit}><Scan size={16} /></button>
      <button className="mapping-icon-button" aria-label={full ? 'Sair da tela cheia' : 'Expandir canvas'} title={full ? 'Sair da tela cheia (Esc)' : 'Expandir canvas'} aria-pressed={full} onClick={onFull}>{full ? <Shrink size={16} /> : <Expand size={16} />}</button>
      {hidden > 0 && <button className="mapping-icon-button" aria-label={`Exibir ${hidden} oculto(s)`} title={`Exibir ${hidden} oculto(s)`} onClick={onRestore}><Eye size={16} /></button>}
      <button className="mapping-icon-button" aria-label="Opções do mapa" title="Opções do mapa" aria-haspopup="menu" onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onOptions({ x: rect.left, y: rect.bottom + 4 });
      }}><Ellipsis size={19} /></button>
    </div>
  </header>;
});

export const CanvasControls = memo(function CanvasControls({ zoom, minimap, canFocus, changeZoom, setMinimap, onFocus }: {
  zoom: number; minimap: boolean; canFocus: boolean; changeZoom: (delta: number) => void; setMinimap: () => void; onFocus: () => void;
}) {
  return <div className="mapping-canvas-controls" role="group" aria-label="Controles do canvas">
    <button className="mapping-icon-button" aria-label="Reduzir zoom" title="Reduzir zoom (-)" disabled={zoom <= MAPPING_MIN_ZOOM} onClick={() => changeZoom(-.125)}><Minus size={15} /></button>
    <button className="mapping-zoom" aria-label="Restaurar zoom para 100%" title="Restaurar zoom (0)" onClick={() => changeZoom(0)}>{Math.round(zoom * 100)}%</button>
    <button className="mapping-icon-button" aria-label="Aumentar zoom" title="Aumentar zoom (+)" disabled={zoom >= MAPPING_MAX_ZOOM} onClick={() => changeZoom(.125)}><Plus size={15} /></button>
    <button className="mapping-icon-button" aria-label="Centralizar selecionado" title="Centralizar selecionado (C)" disabled={!canFocus} onClick={onFocus}><Crosshair size={15} /></button>
    <button className="mapping-icon-button" aria-label={minimap ? 'Recolher minimapa' : 'Abrir minimapa'} aria-pressed={minimap} title="Minimapa" onClick={setMinimap}><MapIcon size={15} /></button>
  </div>;
});

type MinimapProps = {
  nodes: MappingNode[]; sessions: SessionInfo[]; mode: MappingMode; viewport: MappingViewport; canvas: { width: number; height: number };
  edges: { key: string; start: Point; end: Point }[]; onCenter: (x: number, y: number) => void;
};

const MinimapAgent = memo(function MinimapAgent({ node, mode, session }: {
  node: MappingNode; mode: MappingMode; session: SessionInfo;
}) {
  const size = nodeDisplaySize(node, mode);
  const { tone } = useMappingStatus(session);
  return <rect className={`map-agent map-${tone}`} x={node.x} y={node.y} width={size.width} height={size.height} rx={6} />;
});

export const MappingMinimap = memo(function MappingMinimap({ nodes, sessions, mode, viewport, canvas, edges, onCenter }: MinimapProps) {
  const drag = useRef<{ inverse: DOMMatrix; x: number; y: number } | null>(null);
  const rect = { x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom, width: canvas.width / viewport.zoom, height: canvas.height / viewport.zoom };
  const bounds = useMemo(() => mappingBounds(nodes, mode), [nodes, mode]);
  const left = Math.min(bounds?.left ?? rect.x, rect.x) - 24;
  const top = Math.min(bounds?.top ?? rect.y, rect.y) - 24;
  const width = Math.max(bounds?.right ?? 1, rect.x + rect.width) - left + 24;
  const height = Math.max(bounds?.bottom ?? 1, rect.y + rect.height) - top + 24;
  const markers = useMemo(() => {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    return nodes.map((node) => {
      const session = byId.get(node.sessionId);
      return !node.hidden && session ? <MinimapAgent key={node.sessionId} session={session} node={node} mode={mode} /> : null;
    });
  }, [nodes, sessions, mode]);
  const connections = useMemo(() => edges.map((edge) =>
    <path key={edge.key} d={linkPath(edge.start, edge.end)} vectorEffect="non-scaling-stroke" />), [edges]);
  const point = (event: React.PointerEvent<SVGSVGElement>, inverse: DOMMatrix) => {
    const cursor = event.currentTarget.createSVGPoint();
    cursor.x = event.clientX;
    cursor.y = event.clientY;
    return cursor.matrixTransform(inverse);
  };
  return <svg className="mapping-minimap" aria-label="Minimapa" role="group" tabIndex={0} viewBox={`${left} ${top} ${width} ${height}`}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const inverse = event.currentTarget.getScreenCTM()?.inverse();
      if (!inverse) return;
      const cursor = point(event, inverse);
      const inside = cursor.x >= rect.x && cursor.x <= rect.x + rect.width && cursor.y >= rect.y && cursor.y <= rect.y + rect.height;
      drag.current = { inverse, x: inside ? rect.x + rect.width / 2 - cursor.x : 0, y: inside ? rect.y + rect.height / 2 - cursor.y : 0 };
      event.currentTarget.setPointerCapture(event.pointerId);
      if (!inside) onCenter(cursor.x, cursor.y);
    }}
    onPointerMove={(event) => {
      const current = drag.current;
      if (!current) return;
      const cursor = point(event, current.inverse);
      onCenter(cursor.x + current.x, cursor.y + current.y);
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={(event) => {
      const amount = 80 / viewport.zoom;
      const delta = { ArrowUp: [0, -amount], ArrowDown: [0, amount], ArrowLeft: [-amount, 0], ArrowRight: [amount, 0] }[event.key];
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      onCenter(rect.x + rect.width / 2 + delta[0], rect.y + rect.height / 2 + delta[1]);
    }}>
    {connections}
    {markers}
    <rect className="mapping-minimap-viewport" {...rect} vectorEffect="non-scaling-stroke" />
  </svg>;
});

export function MappingOptionsLabels(preferences: MappingPreferences) {
  return {
    grid: preferences.grid ? 'Ocultar grade' : 'Mostrar grade',
    minimap: preferences.minimap ? 'Recolher minimapa' : 'Abrir minimapa',
    timeline: preferences.timeline ? 'Recolher timeline' : 'Abrir timeline',
    motion: preferences.motion ? 'Reduzir animações' : 'Permitir animações',
  };
}
