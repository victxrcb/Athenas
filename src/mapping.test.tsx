import { describe, expect, it } from 'vitest';
import { DEFAULT_MAPPING_PREFERENCES, MAPPING_ORDERS, mappingBounds, mappingScene, mergeMappingLayout, nodesForMappingMode, patchMappingNode, type MappingLayout } from './mapping';

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
    const scene = mappingScene(base.nodes, 'architecture', { ...DEFAULT_MAPPING_PREFERENCES, order: 'project' }, (id) => ({ key: id === 'b' ? 'p2' : 'p1', label: 'Mesmo nome' }), []);
    const bounds = mappingBounds(scene.nodes, 'architecture');
    expect(base.nodes[2].x).toBe(-500);
    expect(scene.nodes[0].y).not.toBe(scene.nodes[1].y);
    expect(scene.groups).toHaveLength(2);
    expect(scene.nodes.map((node) => node.sessionId)).toEqual(['a', 'b']);
    expect(bounds?.width).toBeGreaterThan(0);
    expect(bounds?.height).toBeGreaterThan(0);
  });

  it('keeps organization derived and follows explicit links in hierarchical mode', () => {
    const base = mergeMappingLayout(null, ['a', 'b', 'c', 'd']);
    const original = JSON.stringify(base);
    const links = [{ fromId: 'c', toId: 'a' }, { fromId: 'a', toId: 'b' }];
    for (const order of Object.keys(MAPPING_ORDERS) as (keyof typeof MAPPING_ORDERS)[]) {
      const { nodes } = mappingScene(base.nodes, 'architecture', { ...DEFAULT_MAPPING_PREFERENCES, order }, () => ({ key: 'same', label: 'Mesmo nome' }), links);
      expect(new Set(nodes.map(({ x, y }) => `${x},${y}`)).size).toBe(4);
      if (order === 'hierarchy') {
        expect(nodes[2].x).toBeLessThan(nodes[0].x);
        expect(nodes[0].x).toBeLessThan(nodes[1].x);
      }
    }
    expect(JSON.stringify(base)).toBe(original);
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
