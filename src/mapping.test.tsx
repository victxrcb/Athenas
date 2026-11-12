import { describe, expect, it } from 'vitest';
import { arrangeMappingNodes, mappingBounds, mergeMappingLayout, type MappingLayout } from './mapping';

describe('mapping layout', () => {
  it('preserves saved geometry and adds only missing sessions', () => {
    const saved: MappingLayout = {
      mode: 'architecture',
      viewport: { x: 1, y: 2, zoom: 0.8 },
      nodes: [{ sessionId: 'a', x: 99, y: 88, width: 700, height: 500, minimized: true, hidden: false }],
    };
    const result = mergeMappingLayout(saved, ['a', 'b']);
    expect(result.nodes[0]).toEqual(saved.nodes[0]);
    expect(result.nodes[1].sessionId).toBe('b');
    expect(result.viewport).toEqual(saved.viewport);
  });

  it('arranges visible agents without overlap and leaves hidden agents untouched', () => {
    const base = mergeMappingLayout(null, ['a', 'b', 'c']);
    base.nodes[2] = { ...base.nodes[2], hidden: true, x: -500, y: -400 };
    const arranged = arrangeMappingNodes(base.nodes, (id) => id === 'b' ? 'p2' : 'p1', 'architecture');
    const bounds = mappingBounds(arranged, 'architecture');
    expect(arranged[2].x).toBe(-500);
    expect(arranged[0].y).not.toBe(arranged[1].y);
    expect(bounds?.width).toBeGreaterThan(0);
    expect(bounds?.height).toBeGreaterThan(0);
  });
});
