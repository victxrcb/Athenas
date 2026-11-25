import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Cable, ChevronDown, ChevronRight, Crosshair, EyeOff, Megaphone, TerminalSquare, Unlink, Workflow, X } from 'lucide-react';
import { liveStatus, sessionLabel, useActivityStore } from './activity';
import { confirmAction } from './confirm';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { createLink, deleteLink, introduceLeader, linkAnchors, linkMidpoint, linkPath, listLinks, type AgentLink, type Point } from './links';
import { AgentWindow, type SemanticZoom } from './MappingAgent';
import { CanvasControls, MappingMinimap, MappingOptionsLabels, MappingToolbar } from './MappingCanvasTools';
import { AgentInspector, AgentTimeline, eventTime } from './MappingPanels';
import { latestMappingEvent, useMappingEvents } from './mappingActivity';
import { MAPPING_MAX_ZOOM, MAPPING_MIN_ZOOM, mappingBounds, mappingScene, nodeDisplaySize, patchMappingNode, type MappingMode, type MappingNode, type MappingOrder, type MappingViewport } from './mapping';
import { sameFolder } from './path';
import { useAppStore, type SessionInfo } from './store';
import { useMappingLayout } from './useMappingLayout';
import './mappingTokens.css';
import './mapping.css';

const clampZoom = (value: number) => Math.min(MAPPING_MAX_ZOOM, Math.max(MAPPING_MIN_ZOOM, value));
const NO_VISIBLE_TERMINALS = new Set<string>();
const linkKey = (from: string, to: string) => `${from}→${to}`;
type LinkDraft = { fromId: string; point: Point; targetId: string | null };

function ConnectionInspector({ link, label, onClose, onBrief, onRemove, onFocus }: {
  link: AgentLink; label: (id: string) => string; onClose: () => void;
  onBrief: () => void; onRemove: () => void; onFocus: (id: string) => void;
}) {
  const event = useMappingEvents((state) => latestMappingEvent(state.events, (item) => item.sessionId === link.fromId && item.relatedId === link.toId));
  return <aside className="mapping-inspector" aria-label="Detalhes da conexão">
    <header className="mapping-inspector-head">
      <span className="mapping-agent-icon"><Cable size={22} /></span>
      <div><h2>Vínculo de comando</h2><p>{label(link.fromId)} → {label(link.toId)}</p></div>
      <button className="mapping-icon-button" aria-label="Fechar inspetor" title="Fechar inspetor (Esc)" onClick={onClose}><X size={17} /></button>
    </header>
    <div className="mapping-inspector-body">
      <section><h3>Direção</h3>
        <div className="mapping-peer"><button onClick={() => onFocus(link.fromId)}>{label(link.fromId)}</button> → <button onClick={() => onFocus(link.toId)}>{label(link.toId)}</button></div>
      </section>
      <section><h3>Último evento</h3><p>{event ? <><time>{eventTime(event.at)}</time> · {event.kind === 'sent' ? 'Mensagem entregue' : 'Falha na entrega'}</> : 'Nenhuma entrega registrada.'}</p></section>
      <section><h3>Configurado em</h3><p>{new Date(link.createdAt * 1000).toLocaleString('pt-BR')}</p></section>
    </div>
    <footer className="mapping-inspector-actions">
      <button className="mapping-action" disabled={!isTauri()} onClick={onBrief}><Megaphone size={15} /> Enviar briefing</button>
      <button className="mapping-action mapping-danger" onClick={onRemove}><Unlink size={15} /> Remover vínculo</button>
    </footer>
  </aside>;
}

export const MappingView = memo(function MappingView() {
  const sessions = useAppStore((state) => state.sessions);
  const projects = useAppStore((state) => state.workspace.projects);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const reducedEffects = useAppStore((state) => state.preferences.reducedEffects);
  const [scope, setScope] = useState(activeProjectId ?? 'all');
  const navigationProject = useRef(activeProjectId);
  const filteredSessions = useMemo(() => sessions.filter((session) => scope === 'all' || projects.some((project) => project.id === scope && sameFolder(session.folder, project.folder))), [sessions, projects, scope]);
  const ids = useMemo(() => filteredSessions.map((session) => session.id), [filteredSessions]);
  const { layout, layoutRef, loaded, fresh, setFresh, updateLayout, preferences, updatePreferences } = useMappingLayout(scope, ids);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inspector, setInspector] = useState(false);
  const [selectedLink, setSelectedLink] = useState<AgentLink | null>(null);
  const [links, setLinks] = useState<AgentLink[]>([]);
  const [linkDrag, setLinkDrag] = useState<LinkDraft | null>(null);
  const [keyboardLink, setKeyboardLink] = useState<string | null>(null);
  const [newSessionId, setNewSessionId] = useState<string | null>(null);
  const [historyAgent, setHistoryAgent] = useState<string | null>(null);
  const [menu, setMenu] = useState<(Point & { id?: string }) | null>(null);
  const [full, setFull] = useState(false);
  const fullRequested = useRef(false);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [arranging, setArranging] = useState(false);
  const [terminalIds, setTerminalIds] = useState<Set<string>>(() => new Set());
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(layout.viewport.zoom);
  zoomRef.current = layout.viewport.zoom;
  const pan = useRef<{ x: number; y: number; viewport: MappingViewport; moved: boolean } | null>(null);
  const [panning, setPanning] = useState(false);
  const linkDragRef = useRef(linkDrag);
  linkDragRef.current = linkDrag;
  const selectedId = selectedIds.at(-1);
  const selectedSession = filteredSessions.find((session) => session.id === selectedId);
  const selectedAgentLinks = useMemo(() => links.filter((link) => link.fromId === selectedId || link.toId === selectedId), [links, selectedId]);
  const byId = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const projectFor = useCallback((session: SessionInfo) => projects.find((project) => sameFolder(session.folder, project.folder)), [projects]);
  const statusByScope = useActivityStore((state) => preferences.order === 'status' ? JSON.stringify(filteredSessions.map((session) => liveStatus(session, state.activity[session.id]).label)) : '');
  const suspendedByScope = useAppStore((state) => preferences.order === 'status' ? ids.map((id) => state.memory.sessions?.[id]?.suspended ? '1' : '0').join('') : '');
  const groupById = useMemo(() => {
    const statuses: string[] = statusByScope ? JSON.parse(statusByScope) : [];
    return new Map(filteredSessions.map((session, index) => {
      if (preferences.order === 'project') {
        const project = projectFor(session);
        return [session.id, { key: project?.id ?? 'loose', label: project?.name ?? 'Sessões avulsas' }];
      }
      const label = preferences.order === 'provider' ? session.agent : suspendedByScope[index] === '1' ? 'Pausado' : statuses[index] ?? session.status;
      return [session.id, { key: label, label }];
    }));
  }, [filteredSessions, preferences.order, projectFor, statusByScope, suspendedByScope]);
  const scene = useMemo(() => mappingScene(layout.nodes, layout.mode, preferences, (id) => groupById.get(id) ?? { key: 'loose', label: 'Sessões avulsas' }, links),
    [layout.nodes, layout.mode, preferences, groupById, links]);
  const nodesById = useMemo(() => new Map(scene.nodes.map((node) => [node.sessionId, node])), [scene.nodes]);
  const storedById = useMemo(() => new Map(layout.nodes.map((node) => [node.sessionId, node])), [layout.nodes]);
  const drawnLinks = useMemo(() => links.flatMap((link) => {
    const from = nodesById.get(link.fromId);
    const to = nodesById.get(link.toId);
    if (!from || !to || from.hidden || to.hidden) return [];
    const anchors = linkAnchors(from, to, layout.mode);
    return [{ ...anchors, link, key: linkKey(link.fromId, link.toId), mid: linkMidpoint(anchors.start, anchors.end) }];
  }), [layout.mode, links, nodesById]);
  const flashedLink = useMappingEvents((state) => latestMappingEvent(state.events, (event) => event.kind === 'sent' && Boolean(event.relatedId)));
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flashedLink?.relatedId || Date.now() - flashedLink.at > 1600) return;
    setFlash(linkKey(flashedLink.sessionId, flashedLink.relatedId));
    const timer = window.setTimeout(() => setFlash(null), 1600);
    return () => window.clearTimeout(timer);
  }, [flashedLink]);

  const setNotice = useAppStore.getState().setNotice;
  const name = useCallback((id: string) => { const session = byId.get(id); return session ? sessionLabel(session) : 'Sessão indisponível'; }, [byId]);
  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return;
    const measure = () => setCanvasSize({ width: host.clientWidth, height: host.clientHeight });
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(host);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void listLinks().then((value) => { if (!cancelled) setLinks(value); }).catch((error) => { if (!cancelled) setNotice(String(error)); });
    return () => { cancelled = true; };
  }, [setNotice]);

  const changeScope = useCallback((next: string) => {
    setScope(next); setSelectedIds([]); setSelectedLink(null); setInspector(false); setMaximized(null); setKeyboardLink(null); setLinkDrag(null); setHistoryAgent(null);
  }, []);
  useEffect(() => {
    if (navigationProject.current === activeProjectId) return;
    navigationProject.current = activeProjectId;
    changeScope(activeProjectId ?? 'all');
  }, [activeProjectId, changeScope]);
  useEffect(() => { if (scope !== 'all' && !projects.some((project) => project.id === scope)) changeScope('all'); }, [scope, projects, changeScope]);
  const closeInspector = useCallback(() => { setSelectedLink(null); setInspector(false); }, []);
  const select = useCallback((id: string, multiple = false) => {
    setSelectedLink(null);
    setInspector(true);
    setSelectedIds((current) => multiple ? current.includes(id) ? current.filter((item) => item !== id) : [...current, id] : current.includes(id) ? current : [id]);
  }, []);
  const inspectLink = useCallback((link: AgentLink) => { setSelectedLink(link); setInspector(true); }, []);
  const patchNode = useCallback((id: string, patch: Partial<MappingNode>, save = false) => {
    if (patch.hidden) setMaximized((current) => current === id ? null : current);
    updateLayout((current) => {
      const source = current.nodes.find((node) => node.sessionId === id);
      if (!source) return current;
      if (patch.x === undefined && patch.y === undefined) {
        return { ...current, nodes: current.nodes.map((node) => node === source ? patchMappingNode(node, patch, current.mode) : node) };
      }
      const position = current.mode === 'architecture' ? source.architecturePosition ?? source : source;
      const dx = (patch.x ?? position.x) - position.x;
      const dy = (patch.y ?? position.y) - position.y;
      return { ...current, nodes: current.nodes.map((node) => {
        if (node === source) return patchMappingNode(node, patch, current.mode);
        if (!selectedIds.includes(id) || !selectedIds.includes(node.sessionId)) return node;
        const origin = current.mode === 'architecture' ? node.architecturePosition ?? node : node;
        return patchMappingNode(node, { x: origin.x + dx, y: origin.y + dy }, current.mode);
      }) };
    }, save);
  }, [updateLayout, selectedIds]);

  const center = useCallback((x: number, y: number) => {
    const host = canvasRef.current;
    if (!host) return;
    updateLayout((current) => ({ ...current, viewport: {
      ...current.viewport, x: host.clientWidth / 2 - x * current.viewport.zoom, y: host.clientHeight / 2 - y * current.viewport.zoom,
    } }), true);
  }, [updateLayout]);
  const focusNode = useCallback((id: string) => {
    const node = nodesById.get(id);
    if (!node || node.hidden) {
      const session = byId.get(id);
      if (!session) return;
      const targetScope = projectFor(session)?.id ?? 'all';
      if (scope !== targetScope && scope !== 'all') changeScope(targetScope);
      else {
        if (storedById.get(id)?.hidden) patchNode(id, { hidden: false }, true);
        if (preferences.collapsed.length) updatePreferences({ collapsed: [] });
      }
      setNewSessionId(id);
      return;
    }
    const size = nodeDisplaySize(node, layout.mode);
    select(id);
    // The inspector consumes horizontal space after selection on wide windows.
    window.requestAnimationFrame(() => { center(node.x + size.width / 2, node.y + size.height / 2); });
  }, [nodesById, byId, projectFor, scope, changeScope, storedById, patchNode, preferences.collapsed, updatePreferences, layout.mode, select, center]);
  useEffect(() => {
    if (!loaded || !newSessionId || !nodesById.get(newSessionId) || nodesById.get(newSessionId)?.hidden) return;
    focusNode(newSessionId);
    setNewSessionId(null);
  }, [loaded, newSessionId, nodesById, focusNode]);

  const fit = useCallback(() => {
    const host = canvasRef.current;
    const geometry = mappingBounds(scene.nodes, layout.mode);
    const bounds = scene.groups.reduce((current, group) => ({
      left: Math.min(current.left, group.x), top: Math.min(current.top, group.y),
      right: Math.max(current.right, group.x + group.width), bottom: Math.max(current.bottom, group.y + group.height),
    }), geometry ?? { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    if (!host || !Number.isFinite(bounds.left) || host.clientWidth < 2 || host.clientHeight < 2) return;
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    const zoom = Math.min(1, clampZoom(Math.min((host.clientWidth - 96) / width, (host.clientHeight - 80) / height)));
    updateLayout((current) => ({ ...current, viewport: {
      zoom, x: (host.clientWidth - width * zoom) / 2 - bounds.left * zoom, y: (host.clientHeight - height * zoom) / 2 - bounds.top * zoom,
    } }), true);
  }, [layout.mode, scene, updateLayout]);
  useEffect(() => {
    if (fresh && loaded && scene.nodes.length && canvasSize.width > 1 && canvasSize.height > 1) { fit(); setFresh(false); }
  }, [fresh, loaded, scene.nodes.length, canvasSize, fit, setFresh]);
  useEffect(() => {
    if (!arranging) return;
    const timer = window.setTimeout(() => setArranging(false), 420);
    return () => window.clearTimeout(timer);
  }, [arranging]);
  const changeOrder = useCallback((order: MappingOrder) => { setArranging(true); updatePreferences({ order }); }, [updatePreferences]);
  const changeMode = useCallback((mode: MappingMode) => {
    setMaximized(null);
    updateLayout((current) => ({ ...current, mode }), true);
  }, [updateLayout]);
  const visibleTerminals = useMemo(() => {
    if (!loaded || layout.mode !== 'terminal') return NO_VISIBLE_TERMINALS;
    const { x, y, zoom } = layout.viewport;
    return new Set(scene.nodes.filter((node) => !node.hidden &&
      (maximized ? maximized === node.sessionId : x + node.x * zoom <= canvasSize.width + 96 &&
        y + node.y * zoom <= canvasSize.height + 96 &&
        x + (node.x + node.width) * zoom >= -96 && y + (node.y + node.height) * zoom >= -96))
      .map((node) => node.sessionId));
  }, [loaded, layout.mode, layout.viewport, scene.nodes, canvasSize, maximized]);
  useEffect(() => {
    setTerminalIds((current) => {
      const ids = [...visibleTerminals].filter((id) => !current.has(id) && byId.get(id)?.status === 'rodando');
      return ids.length ? new Set([...current, ...ids]) : current;
    });
  }, [visibleTerminals, byId]);
  const openTerminal = useCallback((id: string) => {
    setTerminalIds((current) => current.has(id) ? current : new Set([...current, id]));
    select(id);
    updateLayout((current) => ({
      ...current, mode: 'terminal', nodes: current.nodes.map((node) => node.sessionId === id ? { ...node, minimized: false, hidden: false } : node),
      viewport: { ...current.viewport, zoom: Math.max(.75, current.viewport.zoom) },
    }), true);
    setNewSessionId(id);
  }, [select, updateLayout]);
  const returnToArchitecture = useCallback((id: string) => { changeMode('architecture'); setNewSessionId(id); }, [changeMode]);
  const maximize = useCallback((id: string) => {
    setMaximized((current) => current === id ? null : id);
    patchNode(id, { minimized: false }, true);
    closeInspector();
  }, [patchNode, closeInspector]);
  const restore = useCallback(() => updateLayout((current) => ({ ...current, nodes: current.nodes.map((node) => node.hidden ? { ...node, hidden: false } : node) }), true), [updateLayout]);

  const setZoom = useCallback((value: number, clientX?: number, clientY?: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = clampZoom(value);
    const x = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const y = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    updateLayout((current) => ({
      ...current, viewport: { zoom, x: x - (x - current.viewport.x) * zoom / current.viewport.zoom, y: y - (y - current.viewport.y) * zoom / current.viewport.zoom },
    }), true);
  }, [updateLayout]);
  const changeZoom = useCallback((delta: number) => setZoom(delta === 0 ? 1 : zoomRef.current + delta), [setZoom]);
  useEffect(() => {
    const host = canvasRef.current;
    if (!host) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest('.terminal-view, .mapping-canvas-controls, .mapping-minimap')) return;
      event.preventDefault();
      if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
        updateLayout((current) => ({ ...current, viewport: { ...current.viewport, x: current.viewport.x - (event.deltaX || event.deltaY) } }), true);
      } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey && !event.metaKey) {
        updateLayout((current) => ({ ...current, viewport: { ...current.viewport, x: current.viewport.x - event.deltaX, y: current.viewport.y - event.deltaY } }), true);
      } else {
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1);
        setZoom(layoutRef.current.viewport.zoom * Math.exp(-delta * .002), event.clientX, event.clientY);
      }
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return () => host.removeEventListener('wheel', wheel);
  }, [setZoom, updateLayout, layoutRef]);

  const commitLink = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return;
    void createLink(fromId, toId).then(setLinks).catch((error) => setNotice(String(error)));
  }, [setNotice]);
  const startLink = useCallback((fromId: string, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setKeyboardLink(null);
    select(fromId);
    const rect = canvasRef.current?.getBoundingClientRect();
    const view = layoutRef.current.viewport;
    setLinkDrag({ fromId, point: { x: (event.clientX - (rect?.left ?? 0) - view.x) / view.zoom, y: (event.clientY - (rect?.top ?? 0) - view.y) / view.zoom }, targetId: null });
  }, [layoutRef, select]);
  const dragging = linkDrag !== null;
  useEffect(() => {
    if (!dragging) return;
    const targetAt = (event: PointerEvent) => document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId ?? null;
    const move = (event: PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const view = layoutRef.current.viewport;
      const target = targetAt(event);
      setLinkDrag((current) => current && { ...current, targetId: target === current.fromId ? null : target,
        point: { x: (event.clientX - rect.left - view.x) / view.zoom, y: (event.clientY - rect.top - view.y) / view.zoom } });
    };
    const up = (event: PointerEvent) => {
      const current = linkDragRef.current;
      const target = targetAt(event);
      setLinkDrag(null);
      if (current && target) commitLink(current.fromId, target);
    };
    const cancel = () => setLinkDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); };
  }, [dragging, commitLink, layoutRef]);
  const remove = async (link: AgentLink) => {
    if (!(await confirmAction(`Remover o vínculo de ${name(link.fromId)} para ${name(link.toId)}?`))) return;
    try { setLinks(await deleteLink(link.fromId, link.toId)); closeInspector(); } catch (error) { setNotice(String(error)); }
  };
  const brief = async (link: AgentLink) => {
    if (!(await confirmAction(`Enviar o briefing de vínculos ao terminal de ${name(link.fromId)}?`))) return;
    try { await introduceLeader(link.fromId); setNotice('Briefing enviado ao agente líder.'); } catch (error) { setNotice(String(error)); }
  };

  const createAgent = useCallback(() => useAppStore.getState().openMappingSession(scope === 'all' ? null : scope, (session) => {
    if (scope !== 'all' && projectFor(session)?.id !== scope) changeScope('all');
    setNewSessionId(session.id);
  }), [scope, projectFor, changeScope]);
  const openNodeMenu = useCallback((id: string, x: number, y: number) => setMenu({ id, x, y }), []);
  const openOptions = useCallback((point: Point) => setMenu(point), []);
  const focusSelected = useCallback(() => { if (selectedId) focusNode(selectedId); }, [selectedId, focusNode]);
  const toggleMinimap = useCallback(() => updatePreferences({ minimap: !preferences.minimap }), [preferences.minimap, updatePreferences]);
  const toggleTimeline = useCallback(() => updatePreferences({ timeline: !preferences.timeline }), [preferences.timeline, updatePreferences]);
  const toggleFull = useCallback(() => setFull((value) => !value), []);
  useEffect(() => {
    if (!full || !isTauri()) return;
    let disposed = false;
    const window = getCurrentWindow();
    const enter = (async () => {
      if (await window.isFullscreen() || disposed) return;
      await window.setFullscreen(true);
      fullRequested.current = true;
    })().catch((error) => setNotice(String(error)));
    return () => {
      disposed = true;
      void enter.then(async () => {
        if (!fullRequested.current) return;
        fullRequested.current = false;
        await window.setFullscreen(false);
      }).catch((error) => setNotice(String(error)));
    };
  }, [full, setNotice]);
  const onTimelineSelect = useCallback((id: string, centerAgent: boolean) => {
    if (centerAgent) focusNode(id);
    else if (byId.has(id)) { setSelectedIds([id]); setSelectedLink(null); }
  }, [focusNode, byId]);
  const openTimelineHistory = useCallback(() => { setHistoryAgent(selectedId ?? null); updatePreferences({ timeline: true }); }, [selectedId, updatePreferences]);
  const keys = (event: React.KeyboardEvent<HTMLElement>) => {
    const element = event.target as HTMLElement;
    if (element.closest('input, textarea, select, .terminal-view, [contenteditable]') || event.ctrlKey || event.altKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === 'escape') {
      if (menu) return;
      if (linkDrag || keyboardLink) { setLinkDrag(null); setKeyboardLink(null); }
      else if (maximized) setMaximized(null);
      else if (full) setFull(false);
      else closeInspector();
      return;
    }
    if (element.closest('button')) return;
    if (key === 'f') fit();
    else if (key === 'c') focusSelected();
    else if (key === '0') changeZoom(0);
    else if (key === '+' || key === '=') changeZoom(.125);
    else if (key === '-') changeZoom(-.125);
    else if (key === 't' && selectedId) { if (layout.mode === 'terminal') returnToArchitecture(selectedId); else openTerminal(selectedId); }
    else if (key === 'l' && selectedId) {
      if (keyboardLink && keyboardLink !== selectedId) { commitLink(keyboardLink, selectedId); setKeyboardLink(null); setNotice(null); }
      else { setKeyboardLink(selectedId); setNotice('Selecione o agente de destino e pressione L para vincular.'); }
    } else return;
    event.preventDefault();
  };
  const menuLabels = MappingOptionsLabels(preferences);
  const menuItems: MenuItem[] = menu?.id ? [
    { label: 'Abrir terminal', icon: <TerminalSquare size={15} />, onSelect: () => openTerminal(menu.id!) },
    { label: 'Centralizar', icon: <Crosshair size={15} />, onSelect: () => focusNode(menu.id!) },
    { label: 'Inspecionar agente', onSelect: () => select(menu.id!) },
    { label: 'Vincular a outro agente', icon: <Cable size={15} />, onSelect: () => { select(menu.id!); setKeyboardLink(menu.id!); setNotice('Selecione o agente de destino e pressione L para vincular.'); } },
    { label: 'Ocultar do mapa', icon: <EyeOff size={15} />, onSelect: () => patchNode(menu.id!, { hidden: true }, true) },
  ] : [
    { label: menuLabels.grid, onSelect: () => updatePreferences({ grid: !preferences.grid }) },
    { label: menuLabels.minimap, onSelect: toggleMinimap },
    { label: menuLabels.timeline, onSelect: toggleTimeline },
    { label: menuLabels.motion, onSelect: () => updatePreferences({ motion: !preferences.motion }) },
  ];
  const semanticZoom: SemanticZoom = layout.viewport.zoom < .62 ? 'far' : layout.viewport.zoom >= 1.25 ? 'near' : 'normal';
  const grid = Math.max(12, 24 * layout.viewport.zoom);
  const linkSource = linkDrag && nodesById.get(linkDrag.fromId);
  const fromSize = linkSource && nodeDisplaySize(linkSource, layout.mode);
  const dragStart = linkSource && fromSize ? { x: linkSource.x + fromSize.width, y: linkSource.y + fromSize.height / 2 } : null;
  const showInspector = inspector && !full && !maximized && Boolean(selectedSession || selectedLink);
  const edgeBounds = useMemo(() => mappingBounds(scene.nodes, layout.mode), [scene.nodes, layout.mode]);
  const svgX = Math.min(edgeBounds?.left ?? 0, linkDrag?.point.x ?? Infinity) - 128;
  const svgY = Math.min(edgeBounds?.top ?? 0, linkDrag?.point.y ?? Infinity) - 128;
  const svgW = Math.max(edgeBounds?.right ?? 1, linkDrag?.point.x ?? -Infinity) - svgX + 128;
  const svgH = Math.max(edgeBounds?.bottom ?? 1, linkDrag?.point.y ?? -Infinity) - svgY + 128;

  const targetLinkId = linkDrag?.targetId;
  const agentWindows = useMemo(() => loaded && filteredSessions.map((session) => {
    const stored = storedById.get(session.id);
    const visible = nodesById.get(session.id);
    if (!stored || (!visible && !terminalIds.has(session.id))) return null;
    const node = visible ?? { ...stored, hidden: true };
    const keepTerminal = terminalIds.has(session.id) || (session.status === 'rodando' && visibleTerminals.has(session.id));
    return <AgentWindow key={session.id} session={session} project={projectFor(session)} node={node} terminalNode={layout.mode === 'terminal' ? node : stored}
      mode={layout.mode} semanticZoom={semanticZoom} selected={selectedIds.includes(session.id)} linkTarget={targetLinkId === session.id || keyboardLink === session.id}
      movable={preferences.order === 'free'} keepTerminal={keepTerminal} maximized={maximized === session.id} zoomRef={zoomRef}
      onSelect={select} onFocus={focusNode} onTerminal={openTerminal} onArchitecture={returnToArchitecture} onMaximize={maximize}
      onChange={patchNode} onLinkStart={startLink} onLinkTarget={select} onMenu={openNodeMenu} />;
  }), [
    loaded, filteredSessions, storedById, nodesById, terminalIds, visibleTerminals, projectFor, layout.mode,
    semanticZoom, selectedIds, targetLinkId, keyboardLink, preferences.order, maximized,
    select, focusNode, openTerminal, returnToArchitecture, maximize, patchNode, startLink, openNodeMenu,
  ]);

  return <section className={`mapping-view ${full ? 'mapping-full' : ''} ${!preferences.motion || reducedEffects ? 'mapping-reduced' : ''}`} onKeyDown={keys}>
    <MappingToolbar scope={scope} projects={projects} running={filteredSessions.filter((session) => session.status === 'rodando').length}
      hidden={layout.nodes.filter((node) => node.hidden).length} mode={layout.mode} order={preferences.order} full={full} ready={loaded}
      onScope={changeScope} onMode={changeMode} onCreate={createAgent} onOrder={changeOrder} onFit={fit} onFull={toggleFull} onOptions={openOptions} onRestore={restore} />
    <div className={`mapping-workspace ${showInspector ? 'with-inspector' : ''}`}>
      <div ref={canvasRef} tabIndex={0} role="region" aria-label="Canvas de agentes" className={`mapping-canvas ${preferences.grid ? 'with-grid' : ''} ${panning ? 'panning' : ''} ${linkDrag ? 'linking' : ''}`}
        style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${layout.viewport.x % grid}px ${layout.viewport.y % grid}px` }}
        onPointerDown={(event) => {
          if (maximized || (event.button !== 0 && event.button !== 1)) return;
          if ((event.target as Element).closest('.mapping-node, .mapping-minimap, .mapping-link-controls, button')) return;
          canvasRef.current?.focus({ preventScroll: true });
          pan.current = { x: event.clientX, y: event.clientY, viewport: layout.viewport, moved: false };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = pan.current;
          if (!start) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (!start.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
          if (!start.moved) { start.moved = true; setPanning(true); }
          updateLayout((current) => ({ ...current, viewport: { ...current.viewport, x: start.viewport.x + dx, y: start.viewport.y + dy } }));
        }}
        onPointerUp={() => {
          if (pan.current?.moved) updateLayout((current) => current, true);
          else if (pan.current) { setSelectedIds([]); closeInspector(); }
          pan.current = null;
          setPanning(false);
        }}
        onPointerCancel={() => { if (pan.current?.moved) updateLayout((current) => current, true); pan.current = null; setPanning(false); }}>
        <div className={`mapping-world ${arranging ? 'arranging' : ''} ${maximized ? 'terminal-maximized' : ''}`}
          style={{ transform: maximized ? undefined : `translate(${layout.viewport.x}px, ${layout.viewport.y}px) scale(${layout.viewport.zoom})` }}>
          {scene.groups.map((group) => <div key={group.key} className="mapping-group" style={{ transform: `translate(${group.x}px, ${group.y}px)`, width: group.width, height: group.height }}>
            <button aria-expanded={!group.collapsed} onClick={() => {
              setArranging(true);
              updatePreferences({ collapsed: group.collapsed ? preferences.collapsed.filter((key) => key !== group.key) : [...preferences.collapsed, group.key] });
            }}>{group.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}{group.label}<small>{group.count}</small></button>
          </div>)}
          {(drawnLinks.length > 0 || linkDrag) && <svg className="mapping-edges" aria-hidden="true" style={{ left: svgX, top: svgY, width: svgW, height: svgH }} viewBox={`${svgX} ${svgY} ${svgW} ${svgH}`}>
            <defs><marker id="mapping-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
            {drawnLinks.map(({ key, start, end }) => <path key={key} className={`mapping-edge ${flash === key ? 'active' : ''} ${selectedLink && key === linkKey(selectedLink.fromId, selectedLink.toId) ? 'selected' : ''}`} d={linkPath(start, end)} markerEnd="url(#mapping-arrow)" vectorEffect="non-scaling-stroke" />)}
            {linkDrag && dragStart && <path className="mapping-edge draft" d={linkPath(dragStart, linkDrag.point)} markerEnd="url(#mapping-arrow)" vectorEffect="non-scaling-stroke" />}
          </svg>}
          {drawnLinks.map(({ key, link, mid }) => <button key={key} className="mapping-link-controls"
            aria-label={`Inspecionar vínculo ${name(link.fromId)} → ${name(link.toId)}`} title={`${name(link.fromId)} → ${name(link.toId)}`}
            style={{ transform: `translate(${mid.x}px, ${mid.y}px) translate(-50%, -50%) scale(${1 / Math.max(layout.viewport.zoom, .55)})` }}
            onClick={() => inspectLink(link)}><Cable size={12} /><span>Comando</span></button>)}
          {agentWindows}
        </div>
        {(!loaded || (filteredSessions.length === 0 && layout.nodes.length === 0)) && <div className="mapping-empty">
          <span><Workflow size={28} /></span>
          <strong>{loaded ? 'Nenhuma sessão neste projeto' : 'Carregando o mapa…'}</strong>
          {loaded && <button className="mapping-action mapping-create" onClick={createAgent}>Criar agente</button>}
        </div>}
        {!maximized && <>
          <CanvasControls zoom={layout.viewport.zoom} minimap={preferences.minimap} canFocus={Boolean(selectedId)} changeZoom={changeZoom} setMinimap={toggleMinimap} onFocus={focusSelected} />
          {preferences.minimap && <MappingMinimap nodes={scene.nodes} sessions={filteredSessions} mode={layout.mode} viewport={layout.viewport} canvas={canvasSize} edges={drawnLinks} onCenter={center} />}
        </>}
      </div>
      {showInspector && (selectedLink
        ? <ConnectionInspector link={selectedLink} label={name} onClose={closeInspector} onBrief={() => void brief(selectedLink)} onRemove={() => void remove(selectedLink)} onFocus={focusNode} />
        : selectedSession && <AgentInspector key={selectedSession.id} session={selectedSession} project={projectFor(selectedSession)} links={selectedAgentLinks}
          onClose={closeInspector} onFocus={focusNode} onTerminal={openTerminal} onConnection={inspectLink} onHistory={openTimelineHistory} />)}
    </div>
    <div hidden={full || Boolean(maximized)}><AgentTimeline open={preferences.timeline} onToggle={toggleTimeline} sessions={filteredSessions} focusedAgent={historyAgent} onSelect={onTimelineSelect} /></div>
    {menu && <ContextMenu autoFocus x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
  </section>;
});
