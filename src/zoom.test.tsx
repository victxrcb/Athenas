import { afterEach, describe, expect, it } from 'vitest';
import { applyZoom, loadZoom, stepZoom } from './zoom';

afterEach(() => { localStorage.clear(); document.documentElement.style.removeProperty('zoom'); });

describe('zoom', () => {
  it('steps through the levels and clamps at both ends', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.5, 1)).toBe(1.5);
    expect(stepZoom(0.8, -1)).toBe(0.8);
    expect(stepZoom(1.33, 1)).toBe(1.1);
  });

  it('remembers the chosen level and ignores invalid saved values', async () => {
    expect(loadZoom()).toBe(1);
    await applyZoom(1.25);
    expect(loadZoom()).toBe(1.25);
    localStorage.setItem('athenas-zoom', '7');
    expect(loadZoom()).toBe(1);
  });
});
