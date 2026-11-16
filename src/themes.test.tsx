import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_THEME, THEMES, applyTheme, loadTheme } from './themes';

describe('temas da interface', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('disponibiliza o tema Dark Lemon com sua paleta', () => {
    expect(THEMES).toContainEqual({
      id: 'dark-lemon',
      name: 'Dark Lemon',
      swatch: ['#090b07', '#c7e83f', '#a6c936'],
    });
  });

  it('carrega Dark Lemon quando ele está salvo', () => {
    localStorage.setItem('athenas-theme', 'dark-lemon');
    expect(loadTheme()).toBe('dark-lemon');
  });

  it('aplica e persiste Dark Lemon, notificando componentes', () => {
    const listener = vi.fn();
    window.addEventListener('athenas-theme', listener, { once: true });

    applyTheme('dark-lemon');

    expect(document.documentElement.dataset.theme).toBe('dark-lemon');
    expect(localStorage.getItem('athenas-theme')).toBe('dark-lemon');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('mantém o tema padrão para um valor inválido', () => {
    localStorage.setItem('athenas-theme', 'limonada');
    expect(loadTheme()).toBe(DEFAULT_THEME);
  });
});
