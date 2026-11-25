import { describe, expect, it } from 'vitest';
import { arrangeMappingNodes, mappingBounds, mergeMappingLayout, nodesForMappingMode, patchMappingNode, type MappingLayout } from './mapping';

describe('mapping layout', () => {
  it('preserves saved geometry and adds only missing sessions', () => {
    const saved: MappingLayout = {
      mode: 'architecture',
      viewport: { x: 1, y: 2, zoom: 0.8 },
      nodes: [{ sessionId: 'a', x: 99, y: 88, width: 700, height: 500, minimized: true, hidden: false }],
    };
    const result = mergeMappingLayout(saved, ['a', 'b']);
    expect(result.nodes[0]).toEqual({ ...saved.nodes[0], architecturePosition: { x: 99, y: 88 } });
    expect(result.nodes[1].sessionId).toBe('b');
    expect(result.viewport).toEqual(saved.viewport);
  });

  it('arranges visible agents without overlap and leaves hidden agents untouched', () => {
    const base = mergeMappingLayout(null, ['a', 'b', 'c']);
    base.nodes[2] = { ...base.nodes[2], hidden: true, x: -500, y: -400 };
    const arranged = arrangeMappingNodes(base.nodes, (id) => id === 'b' ? 'p2' : 'p1', 'architecture');
    const architecture = nodesForMappingMode(arranged, 'architecture');
    const bounds = mappingBounds(architecture, 'architecture');
    expect(arranged[2].x).toBe(-500);
    expect(architecture[0].y).not.toBe(architecture[1].y);
    expect(nodesForMappingMode(arranged, 'terminal').map(({ x, y }) => ({ x, y }))).toEqual(base.nodes.map(({ x, y }) => ({ x, y })));
    expect(bounds?.width).toBeGreaterThan(0);
    expect(bounds?.height).toBeGreaterThan(0);
  });

  it('restores each mode position after saving moves in both views', () => {
    const layout = mergeMappingLayout(null, ['a']);
    const architectureMove = patchMappingNode(layout.nodes[0], { x: 250, y: 300 }, 'architecture');
    const terminalMove = patchMappingNode(architectureMove, { x: 900, y: 450 }, 'terminal');
    const saved = JSON.stringify({ ...layout, nodes: [terminalMove] });
    const restored = mergeMappingLayout(JSON.parse(saved), ['a']);
    expect(nodesForMappingMode(restored.nodes, 'architecture')[0]).toMatchObject({ x: 250, y: 300 });
    expect(nodesForMappingMode(restored.nodes, 'terminal')[0]).toMatchObject({ x: 900, y: 450 });
  });
});
