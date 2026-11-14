import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MascotIcon } from './MascotIcon';
import { DEFAULT_MASCOT, MASCOT_OUTFITS, sanitizeMascot } from './mascot';

describe('mascot outfits', () => {
  it('keeps a known outfit and falls back to none for unknown or legacy configs', () => {
    expect(sanitizeMascot({ ...DEFAULT_MASCOT, outfit: 'beach' }).outfit).toBe('beach');
    expect(sanitizeMascot({ ...DEFAULT_MASCOT, outfit: 'tuxedo' }).outfit).toBe('none');
    expect(sanitizeMascot({ color: '#ff7a80', eyes: 'dot', antennas: true, blush: false }).outfit).toBe('none');
  });

  it('keeps every outfit pixel inside the 13-column grid', () => {
    for (const outfit of MASCOT_OUTFITS) {
      for (const [x, y] of outfit.pixels) {
        expect(x, `${outfit.id} x`).toBeGreaterThanOrEqual(0);
        expect(x, `${outfit.id} x`).toBeLessThan(13);
        expect(y, `${outfit.id} y`).toBeLessThan(9);
      }
    }
  });

  it('grows the viewBox for hats and hides antennas under them', () => {
    const { container, rerender } = render(<MascotIcon config={{ ...DEFAULT_MASCOT, antennas: true }} />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 13 11');
    rerender(<MascotIcon config={{ ...DEFAULT_MASCOT, antennas: true, outfit: 'christmas' }} />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 13 13');
    const rects = [...container.querySelectorAll('rect')];
    expect(rects.some((rect) => rect.getAttribute('fill') === '#d63a3a')).toBe(true);
  });
});
