export type MappingMode = 'terminal' | 'architecture';
export const MAPPING_ORDERS = {
  free: 'Livre', grid: 'Grade', horizontal: 'Horizontal', vertical: 'Vertical',
  hierarchy: 'Hierárquica', radial: 'Radial', project: 'Por projeto', status: 'Por status', provider: 'Por provedor',
} as const;
export type MappingOrder = keyof typeof MAPPING_ORDERS;
export type MappingPreferences = {
  order: MappingOrder; grid: boolean; minimap: boolean; timeline: boolean; motion: boolean; collapsed: string[];
};
export const DEFAULT_MAPPING_PREFERENCES: MappingPreferences = {
  order: 'free', grid: true, minimap: true, timeline: true, motion: true, collapsed: [],
};

export type MappingViewport = { x: number; y: number; zoom: number };
type MappingPosition = Pick<MappingViewport, 'x' | 'y'>;

export type MappingNode = {
  sessionId: string;
  x: number;
  y: number;
  architecturePosition?: MappingPosition | null;
  width: number;
  height: number;
  minimized: boolean;
  hidden: boolean;
};

export type MappingLayout = {
  mode: MappingMode;
  viewport: MappingViewport;
  nodes: MappingNode[];
};

export const MAPPING_MIN_ZOOM = 0.05;
export const MAPPING_MAX_ZOOM = 2;
export const DEFAULT_VIEWPORT: MappingViewport = { x: 160, y: 96, zoom: 1 };
export const DEFAULT_NODE_SIZE = { width: 620, height: 420 };
export const ARCHITECTURE_NODE_SIZE = { width: 248, height: 112 };

export function newMappingNode(sessionId: string, index: number): MappingNode {
  return {
    sessionId,
    x: 64 + (index % 3) * 660,
    y: 64 + Math.floor(index / 3) * 460,
    architecturePosition: { x: 64 + (index % 3) * 308, y: 64 + Math.floor(index / 3) * 176 },
    ...DEFAULT_NODE_SIZE,
    minimized: false,
    hidden: false,
  };
}

/** Keeps user geometry for known sessions and assigns a stable free slot only to new sessions. */
export function mergeMappingLayout(layout: MappingLayout | null, sessionIds: string[]): MappingLayout {
  const existing = new Map((layout?.nodes ?? []).map((node) => [node.sessionId, node]));
  const nodes = sessionIds.map((id, index) => {
    const node = existing.get(id) ?? newMappingNode(id, index);
    return node.architecturePosition ? node : { ...node, architecturePosition: { x: node.x, y: node.y } };
  });
  return {
    mode: layout?.mode ?? 'architecture',
    viewport: layout?.viewport ?? { ...DEFAULT_VIEWPORT },
    nodes,
  };
}

export function nodeDisplaySize(node: MappingNode, mode: MappingMode) {
  if (mode === 'architecture') return ARCHITECTURE_NODE_SIZE;
  return { width: node.width, height: node.minimized ? 42 : node.height };
}

export function nodesForMappingMode(nodes: MappingNode[], mode: MappingMode) {
  return mode === 'architecture' ? nodes.map((node) => ({ ...node, ...node.architecturePosition })) : nodes;
}

export function patchMappingNode(node: MappingNode, patch: Partial<MappingNode>, mode: MappingMode): MappingNode {
  if (mode === 'terminal') return { ...node, ...patch };
  const { x, y, ...rest } = patch;
  const position = node.architecturePosition ?? node;
  return { ...node, ...rest, architecturePosition: { x: x ?? position.x, y: y ?? position.y } };
}

export function mappingBounds(nodes: MappingNode[], mode: MappingMode) {
  const visible = nodes.filter((node) => !node.hidden);
  if (!visible.length) return null;
  const left = Math.min(...visible.map((node) => node.x));
  const top = Math.min(...visible.map((node) => node.y));
  const right = Math.max(...visible.map((node) => node.x + nodeDisplaySize(node, mode).width));
  const bottom = Math.max(...visible.map((node) => node.y + nodeDisplaySize(node, mode).height));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function mappingScene(
  nodes: MappingNode[],
  mode: MappingMode,
  preferences: MappingPreferences,
  groupFor: (id: string) => { key: string; label: string },
  links: ReadonlyArray<{ fromId: string; toId: string }>,
) {
  const manual = nodesForMappingMode(nodes, mode);
  const { order, collapsed } = preferences;
  if (order === 'free') return { nodes: manual, groups: [] };
  const visible = manual.filter((node) => !node.hidden);
  if (!visible.length) return { nodes: visible, groups: [] };
  const grouped = order === 'project' || order === 'status' || order === 'provider';
  const buckets = new Map<string, { label: string; nodes: MappingNode[] }>();
  const levels = new Map<string, number>();
  if (order === 'hierarchy') {
    // Resolve acyclic dependencies first. Cycles share the final unresolved column.
    const pending = new Map(visible.map((node) => [node.sessionId, new Set<string>()]));
    for (const link of links) if (pending.has(link.fromId)) pending.get(link.toId)?.add(link.fromId);
    while (pending.size) {
      const ready = [...pending].filter(([, parents]) => [...parents].every((id) => levels.has(id)));
      if (!ready.length) break;
      for (const [id, parents] of ready) {
        levels.set(id, Math.max(0, ...[...parents].map((parent) => levels.get(parent)! + 1)));
        pending.delete(id);
      }
    }
    const last = Math.max(-1, ...levels.values()) + 1;
    for (const id of pending.keys()) levels.set(id, last);
  }
  for (const node of visible) {
    const { key, label } = grouped ? groupFor(node.sessionId) : { key: 'all', label: '' };
    const bucket = buckets.get(key) ?? { label, nodes: [] };
    bucket.nodes.push(node);
    buckets.set(key, bucket);
  }
  const result: MappingNode[] = [];
  const groups: { key: string; label: string; count: number; x: number; y: number; width: number; height: number; collapsed: boolean }[] = [];
  const sizes = visible.map((node) => nodeDisplaySize(node, mode));
  const stepX = Math.max(...sizes.map((size) => size.width)) + 64;
  const stepY = Math.max(...sizes.map((size) => size.height)) + 58;
  let offsetY = 44;
  for (const [groupId, { label, nodes: bucket }] of buckets) {
    const columns = order === 'horizontal' ? bucket.length : order === 'vertical' ? 1 : Math.ceil(Math.sqrt(bucket.length));
    const radius = bucket.length === 1 ? 0 : Math.hypot(stepX, stepY) / (2 * Math.sin(Math.PI / bucket.length));
    const rows = new Map<number, number>();
    const arranged = bucket.map((node, index) => {
      let x = (index % columns) * stepX;
      let y = Math.floor(index / columns) * stepY;
      if (order === 'radial') {
        const angle = index * Math.PI * 2 / bucket.length - Math.PI / 2;
        x = radius * (1 + Math.cos(angle));
        y = radius * (1 + Math.sin(angle));
      }
      if (order === 'hierarchy') {
        const level = levels.get(node.sessionId) ?? 0;
        const row = rows.get(level) ?? 0;
        rows.set(level, row + 1);
        x = level * stepX;
        y = row * stepY;
      }
      return { ...node, x: 44 + x, y: offsetY + y + (grouped ? 42 : 0) };
    });
    if (grouped) {
      const bounds = mappingBounds(arranged, mode)!;
      const key = `${order}:${groupId}`;
      const closed = collapsed.includes(key);
      const height = closed ? 36 : bounds.height + 62;
      groups.push({ key, label, count: bucket.length, collapsed: closed, x: 24, y: offsetY, width: closed ? Math.min(300, bounds.width + 40) : bounds.width + 40, height });
      offsetY += height + 26;
      if (closed) continue;
    }
    result.push(...arranged);
  }
  return { nodes: result, groups };
}
