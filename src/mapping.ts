export type MappingMode = 'terminal' | 'architecture';

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

export const DEFAULT_VIEWPORT: MappingViewport = { x: 160, y: 96, zoom: 1 };
export const DEFAULT_NODE_SIZE = { width: 620, height: 420 };
export const ARCHITECTURE_NODE_SIZE = { width: 64, height: 64 };

export function newMappingNode(sessionId: string, index: number): MappingNode {
  return {
    sessionId,
    x: 64 + (index % 3) * 660,
    y: 64 + Math.floor(index / 3) * 460,
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
    mode: layout?.mode === 'architecture' ? 'architecture' : 'terminal',
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

/** Explicit auto-layout grouped by project; hidden nodes keep their saved position. */
export function arrangeMappingNodes(
  nodes: MappingNode[],
  projectForSession: (sessionId: string) => string,
  mode: MappingMode,
): MappingNode[] {
  const visible = nodes.filter((node) => !node.hidden);
  const groups = new Map<string, MappingNode[]>();
  visible.forEach((node) => {
    const key = projectForSession(node.sessionId);
    groups.set(key, [...(groups.get(key) ?? []), node]);
  });
  const arranged = new Map<string, MappingNode>();
  let groupY = 40;
  for (const group of groups.values()) {
    const columns = Math.max(1, Math.ceil(Math.sqrt(group.length)));
    const cellWidth = Math.max(...group.map((node) => nodeDisplaySize(node, mode).width));
    const cellHeight = Math.max(...group.map((node) => nodeDisplaySize(node, mode).height));
    let maxBottom = groupY;
    group.forEach((node, index) => {
      const size = nodeDisplaySize(node, mode);
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = 40 + column * (cellWidth + 28);
      const y = groupY + row * (cellHeight + 28);
      const next = patchMappingNode(node, { x, y }, mode);
      arranged.set(node.sessionId, next);
      maxBottom = Math.max(maxBottom, y + size.height);
    });
    groupY = maxBottom + 72;
  }
  return nodes.map((node) => arranged.get(node.sessionId) ?? node);
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
