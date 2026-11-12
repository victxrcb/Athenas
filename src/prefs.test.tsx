import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SIDEBAR_PREFS, loadSidebarPrefs, resetSidebarPrefsCache, sanitizeSidebarPrefs, setSidebarItem, toggleSidebarHidden } from './sidebarPrefs';
import { applyFont, fontStack, isValidFontName, loadFont, sanitizeFont } from './font';

describe('preferências da sidebar', () => {
  beforeEach(() => { localStorage.clear(); resetSidebarPrefsCache(); });

  it('usa o padrão com dados ausentes ou inválidos', () => {
    expect(sanitizeSidebarPrefs(null)).toEqual(DEFAULT_SIDEBAR_PREFS);
    expect(sanitizeSidebarPrefs({ hidden: 'sim', items: { git: 'não', bogus: false } })).toEqual(DEFAULT_SIDEBAR_PREFS);
  });

  it('persiste itens ocultos e o estado da sidebar', () => {
    setSidebarItem('git', false);
    toggleSidebarHidden();
    resetSidebarPrefsCache();
    const saved = loadSidebarPrefs();
    expect(saved.hidden).toBe(true);
    expect(saved.items.git).toBe(false);
    expect(saved.items.mapping).toBe(true);
  });
});

describe('fonte da interface', () => {
  beforeEach(() => localStorage.clear());

  it('rejeita nomes que poderiam injetar CSS', () => {
    expect(isValidFontName('Fira Sans')).toBe(true);
    expect(isValidFontName('x"; } body { display:none')).toBe(false);
    expect(sanitizeFont({ id: 'custom', custom: 'a;b' })).toEqual({ id: 'inter', custom: '' });
  });

  it('aplica e persiste a fonte escolhida', () => {
    applyFont({ id: 'custom', custom: 'Roboto' });
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toContain('"Roboto"');
    expect(loadFont()).toEqual({ id: 'custom', custom: 'Roboto' });
    expect(fontStack({ id: 'arial', custom: '' })).toMatch(/^Arial/);
  });
});
